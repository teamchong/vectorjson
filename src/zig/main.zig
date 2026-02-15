///! VectorJSON WASM Engine
///!
///! Thin WASM export layer wrapping zimdjson's DOM parser.
///! Parses JSON bytes into zimdjson's internal tape format, then exposes
///! a token-by-token iterator for the WAT WasmGC shim to consume.
const std = @import("std");
const zimdjson = @import("zimdjson");
const simd = @import("simd.zig");

// --- Allocator ---
// WASM linear memory page allocator (child allocator for arena)
const page_alloc: std.mem.Allocator = .{ .ptr = undefined, .vtable = &std.heap.WasmAllocator.vtable };
// General-purpose allocator (used for long-lived allocs like alloc/dealloc exports)
const gpa = page_alloc;

// --- Parser state ---
const DomParser = zimdjson.dom.FullParser(.default);

var parser: DomParser = DomParser.init;
var last_error_code: i32 = 0;

// --- Tape iteration state ---
// We walk the tape word-by-word, exposing one token at a time.
const TokenType = enum(i32) {
    // Terminals
    null_value = 0,
    true_value = 1,
    false_value = 2,
    number_unsigned = 3,
    number_signed = 4,
    number_double = 5,
    string = 6,
    // Containers
    object_start = 7,
    object_end = 8,
    array_start = 9,
    array_end = 10,
    // Key (in objects)
    key = 11,
    // Special
    end_of_tape = 12,
    error_token = 13,
};

// Tape walker state
var tape_index: u32 = 0;
var tape_len: u32 = 0;

// Current token data (set by get_next_token, read by get_token_*)
var current_token_type: TokenType = .end_of_tape;
var current_number_f64: f64 = 0;
var current_number_u64: u64 = 0;
var current_number_i64: i64 = 0;
var current_string_ptr: [*]const u8 = undefined;
var current_string_len: u32 = 0;
var current_bool_val: i32 = 0;

// Depth tracking for object key vs value distinction
var depth_stack: [1024]u8 = undefined; // 'o' for object, 'a' for array
var depth: u32 = 0;
var expecting_key: [1024]bool = undefined; // per depth: are we expecting a key?

// --- WASM Exports ---

/// Allocate `size` bytes in WASM linear memory, return pointer.
export fn alloc(size: u32) ?[*]u8 {
    const slice = gpa.alloc(u8, size) catch return null;
    return slice.ptr;
}

/// Free previously allocated memory.
export fn dealloc(ptr: [*]u8, size: u32) void {
    gpa.free(ptr[0..size]);
}

/// Parse JSON bytes at (ptr, len). Returns 0 on success, 1 on error.
export fn parse(ptr: [*]const u8, len: u32) i32 {
    last_error_code = 0;
    depth = 0;

    _ = parser.parseFromSlice(gpa, ptr[0..len]) catch |err| {
        last_error_code = mapError(err);
        return 1;
    };

    // The tape starts at index 0 (root word), real content at index 1.
    // The root opening word at index 0 has data.ptr pointing to the closing root word.
    // In non-streaming mode, zimdjson writes words via raw pointer arithmetic,
    // so words.items().len stays 0. We read the tape length from the root word.
    //
    // Word layout (packed u64): tag:u8 | data.ptr:u32 | data.len:u24
    // So data.ptr = bits [8:40] = (word >> 8) & 0xFFFFFFFF
    const root_raw: u64 = parser.tape.words.items().ptr[0];
    const closing_root_index: u32 = @truncate(root_raw >> 8);
    tape_index = 1; // skip opening root
    tape_len = closing_root_index + 1;

    return 0;
}

/// Advance to the next token in the tape. Returns the token type.
/// After calling this, use get_token_number/string/bool to read the value.
export fn get_next_token() i32 {
    if (tape_index >= tape_len) {
        current_token_type = .end_of_tape;
        return @intFromEnum(TokenType.end_of_tape);
    }

    // Read the tape word
    const word = parser.tape.get(tape_index);

    const tag = word.tag;
    const result: TokenType = switch (tag) {
        .root => blk: {
            // Closing root — we're done
            current_token_type = .end_of_tape;
            tape_index = tape_len; // force end
            break :blk .end_of_tape;
        },
        .null => blk: {
            tape_index += 1;
            maybeAdvancePastKey();
            break :blk .null_value;
        },
        .true => blk: {
            current_bool_val = 1;
            tape_index += 1;
            maybeAdvancePastKey();
            break :blk .true_value;
        },
        .false => blk: {
            current_bool_val = 0;
            tape_index += 1;
            maybeAdvancePastKey();
            break :blk .false_value;
        },
        .unsigned => blk: {
            const number_word = parser.tape.get(tape_index + 1);
            current_number_u64 = @bitCast(number_word);
            current_number_f64 = @floatFromInt(current_number_u64);
            tape_index += 2;
            maybeAdvancePastKey();
            break :blk .number_unsigned;
        },
        .signed => blk: {
            const number_word = parser.tape.get(tape_index + 1);
            current_number_i64 = @bitCast(number_word);
            current_number_f64 = @floatFromInt(current_number_i64);
            tape_index += 2;
            maybeAdvancePastKey();
            break :blk .number_signed;
        },
        .double => blk: {
            const number_word = parser.tape.get(tape_index + 1);
            current_number_f64 = @bitCast(number_word);
            tape_index += 2;
            maybeAdvancePastKey();
            break :blk .number_double;
        },
        .string => blk: {
            // Read string from the string buffer
            const native_endian = @import("builtin").cpu.arch.endian();
            const str_ptr_offset = word.data.ptr;
            const strings = parser.tape.string_buffer.strings.items();
            const low_bits = std.mem.readInt(u16, strings.ptr[str_ptr_offset..][0..@sizeOf(u16)], native_endian);
            const high_bits: u64 = word.data.len;
            const str_len: u32 = @intCast(high_bits << 16 | low_bits);
            current_string_ptr = strings.ptr[str_ptr_offset + @sizeOf(u16) ..];
            current_string_len = str_len;
            tape_index += 1;

            // Check if this string is an object key
            if (depth > 0 and depth_stack[depth - 1] == 'o' and expecting_key[depth - 1]) {
                expecting_key[depth - 1] = false; // next token is the value
                break :blk .key;
            }
            maybeAdvancePastKey();
            break :blk .string;
        },
        .object_opening => blk: {
            if (depth < depth_stack.len) {
                depth_stack[depth] = 'o';
                expecting_key[depth] = true;
                depth += 1;
            }
            tape_index += 1;
            break :blk .object_start;
        },
        .object_closing => blk: {
            if (depth > 0) depth -= 1;
            tape_index += 1;
            maybeAdvancePastKey();
            break :blk .object_end;
        },
        .array_opening => blk: {
            if (depth < depth_stack.len) {
                depth_stack[depth] = 'a';
                expecting_key[depth] = false;
                depth += 1;
            }
            tape_index += 1;
            break :blk .array_start;
        },
        .array_closing => blk: {
            if (depth > 0) depth -= 1;
            tape_index += 1;
            maybeAdvancePastKey();
            break :blk .array_end;
        },
    };

    current_token_type = result;
    return @intFromEnum(result);
}

/// After emitting a value inside an object, set expecting_key back to true.
fn maybeAdvancePastKey() void {
    if (depth > 0 and depth_stack[depth - 1] == 'o') {
        expecting_key[depth - 1] = true;
    }
}

/// Get the current token's numeric value as f64.
export fn get_token_number() f64 {
    return current_number_f64;
}

/// Get a pointer to the current token's string data.
export fn get_token_string_ptr() [*]const u8 {
    return current_string_ptr;
}

/// Get the length of the current token's string.
export fn get_token_string_len() u32 {
    return current_string_len;
}

/// Get the current token's boolean value (1=true, 0=false).
export fn get_token_bool() i32 {
    return current_bool_val;
}

/// Reset the tape iterator to the beginning.
export fn reset_tape() void {
    tape_index = 1;
    depth = 0;
    current_token_type = .end_of_tape;
}

/// Get the last error code (0 = no error).
export fn get_error_code() i32 {
    return last_error_code;
}

/// Get the number of direct children of the most recently opened container.
/// Must be called immediately after get_next_token() returns array_start (9)
/// or object_start (7). For objects, returns the number of key-value pairs.
/// For arrays, returns the number of elements.
///
/// The count is stored directly in the tape word's data.len field by zimdjson.
export fn get_container_count() u32 {
    if (tape_index < 1) return 0;

    // The opening tag was the previous word (tape_index - 1, before we advanced)
    const opening_index = tape_index - 1;
    const opening_word = parser.tape.get(opening_index);
    return opening_word.data.len;
}

// --- Streaming exports ---
const stream = @import("stream.zig");

/// Global stream state slots (support multiple concurrent streams)
var streams: [4]?*stream.StreamState = .{ null, null, null, null };

/// Create a new streaming parser. Returns stream ID (0-3) or -1 on error.
export fn stream_create() i32 {
    for (&streams, 0..) |*slot, i| {
        if (slot.* == null) {
            slot.* = stream.StreamState.init(gpa) catch return -1;
            return @intCast(i);
        }
    }
    return -1; // no free slots
}

/// Destroy a streaming parser and free resources.
export fn stream_destroy(id: i32) void {
    if (id < 0 or id >= streams.len) return;
    const uid: usize = @intCast(id);
    if (streams[uid]) |s| {
        s.deinit();
        streams[uid] = null;
    }
}

/// Feed a chunk of data to a streaming parser.
/// Returns status: 0=incomplete, 1=complete, 2=error, 3=end_early
export fn stream_feed(id: i32, ptr: [*]const u8, len: u32) i32 {
    if (id < 0 or id >= streams.len) return 2;
    const uid: usize = @intCast(id);
    const s = streams[uid] orelse return 2;
    return @intFromEnum(s.feed(ptr, len));
}

/// Get the status of a streaming parser.
export fn stream_get_status(id: i32) i32 {
    if (id < 0 or id >= streams.len) return 2;
    const uid: usize = @intCast(id);
    const s = streams[uid] orelse return 2;
    return @intFromEnum(s.status);
}

/// Get the buffer pointer for a streaming parser (for parsing the accumulated data).
export fn stream_get_buffer_ptr(id: i32) u32 {
    if (id < 0 or id >= streams.len) return 0;
    const uid: usize = @intCast(id);
    const s = streams[uid] orelse return 0;
    const buf = s.getBuffer();
    return @intFromPtr(buf.ptr);
}

/// Get the buffer length for a streaming parser.
export fn stream_get_buffer_len(id: i32) u32 {
    if (id < 0 or id >= streams.len) return 0;
    const uid: usize = @intCast(id);
    const s = streams[uid] orelse return 0;
    return s.getBuffer().len;
}

/// Get the remaining bytes pointer after end_early.
export fn stream_get_remaining_ptr(id: i32) u32 {
    if (id < 0 or id >= streams.len) return 0;
    const uid: usize = @intCast(id);
    const s = streams[uid] orelse return 0;
    return @intFromPtr(s.getRemaining().ptr);
}

/// Get the length of just the complete value (excluding trailing data).
export fn stream_get_value_len(id: i32) u32 {
    if (id < 0 or id >= streams.len) return 0;
    const uid: usize = @intCast(id);
    const s = streams[uid] orelse return 0;
    return s.getValueLen();
}

/// Get the remaining bytes length.
export fn stream_get_remaining_len(id: i32) u32 {
    if (id < 0 or id >= streams.len) return 0;
    const uid: usize = @intCast(id);
    const s = streams[uid] orelse return 0;
    return s.getRemaining().len;
}

// --- Compare exports ---
const compare_mod = @import("compare.zig");

var compare_state: ?*compare_mod.CompareState = null;

/// Serialize the current tape into a TokenStream.
/// Must be called after a successful parse().
fn serializeCurrentTape(ts: *compare_mod.TokenStream) void {
    ts.reset();

    while (tape_index < tape_len) {
        const token = get_next_token();
        const tt: TokenType = @enumFromInt(token);
        switch (tt) {
            .null_value => ts.writeTag(.null_val),
            .true_value => ts.writeTag(.true_val),
            .false_value => ts.writeTag(.false_val),
            .number_unsigned, .number_signed, .number_double => {
                ts.writeTag(.number);
                ts.writeF64(current_number_f64);
            },
            .string => {
                ts.writeStringData(.string, current_string_ptr, current_string_len);
            },
            .key => {
                ts.writeStringData(.key, current_string_ptr, current_string_len);
            },
            .object_start => ts.writeTag(.object_start),
            .object_end => ts.writeTag(.object_end),
            .array_start => ts.writeTag(.array_start),
            .array_end => ts.writeTag(.array_end),
            .end_of_tape => break,
            .error_token => break,
        }
    }
}

/// Parse JSON A and serialize its tape to snapshot A.
/// Returns 0 on success, 1 on error.
export fn compare_parse_a(ptr: [*]const u8, len: u32) i32 {
    // Ensure compare state exists
    if (compare_state == null) {
        compare_state = compare_mod.CompareState.init(gpa) catch return 1;
    }
    const cs = compare_state.?;
    cs.reset();

    // Parse A
    if (parse(ptr, len) != 0) return 1;

    // Serialize tape to stream A
    serializeCurrentTape(&cs.stream_a);
    return 0;
}

/// Set comparison mode: 0=unordered (default), 1=ordered (key order matters).
export fn compare_set_ordered(ordered: i32) void {
    if (compare_state) |cs| {
        cs.ordered = ordered != 0;
    }
}

/// Parse JSON B, serialize its tape to snapshot B, and run comparison.
/// Must be called after compare_parse_a. Returns 0 on success, 1 on error.
export fn compare_parse_b(ptr: [*]const u8, len: u32) i32 {
    const cs = compare_state orelse return 1;

    // Parse B
    if (parse(ptr, len) != 0) return 1;

    // Serialize tape to stream B
    serializeCurrentTape(&cs.stream_b);

    // Run comparison
    cs.compare();
    return 0;
}

/// Get the number of diffs found.
export fn compare_diff_count() u32 {
    const cs = compare_state orelse return 0;
    return cs.getDiffCount();
}

/// Get pointer to diff path string at index.
export fn compare_diff_path_ptr(index: u32) [*]const u8 {
    const cs = compare_state orelse return @ptrFromInt(1);
    return cs.getDiffPathPtr(index);
}

/// Get length of diff path string at index.
export fn compare_diff_path_len(index: u32) u32 {
    const cs = compare_state orelse return 0;
    return cs.getDiffPathLen(index);
}

/// Get diff type at index (0=changed, 1=added, 2=removed, 3=type_changed).
export fn compare_diff_type(index: u32) u32 {
    const cs = compare_state orelse return 0;
    return cs.getDiffType(index);
}

/// Free the comparison state.
export fn compare_free() void {
    if (compare_state) |cs| {
        cs.deinit();
        compare_state = null;
    }
}

// --- Validate exports ---
const validate_mod = @import("validate.zig");

var validator: ?*validate_mod.ValidatorState = null;

/// Load and compile a JSON Schema. The schema JSON is at (ptr, len).
/// Returns 0 on success, 1 on parse error, 2 on compile error.
export fn validate_load_schema(ptr: [*]const u8, len: u32) i32 {
    // Ensure validator exists
    if (validator == null) {
        validator = validate_mod.ValidatorState.init(gpa) catch return 1;
    }
    const v = validator.?;

    // Parse schema JSON
    if (parse(ptr, len) != 0) return 1;

    // Serialize schema tape to token stream
    serializeCurrentTape(&v.schema_stream);

    // Compile schema from token stream
    if (!v.compileSchema()) return 2;
    return 0;
}

/// Validate data JSON against the loaded schema.
/// Returns 0 if valid, 1 if invalid (errors available), 2 if no schema loaded.
export fn validate_check(ptr: [*]const u8, len: u32) i32 {
    const v = validator orelse return 2;
    if (!v.schema_loaded) return 2;

    // Parse data JSON
    if (parse(ptr, len) != 0) return 1;

    // Serialize data tape to a temporary token stream for validation
    var data_stream = compare_mod.TokenStream.init(gpa);
    defer data_stream.deinit();
    serializeCurrentTape(&data_stream);

    // Validate
    var data_reader = compare_mod.TokenReader.fromStream(&data_stream);
    v.validateData(&data_reader);

    return if (v.error_count > 0) @as(i32, 1) else @as(i32, 0);
}

/// Get the number of validation errors.
export fn validate_error_count() u32 {
    const v = validator orelse return 0;
    return v.getErrorCount();
}

/// Get validation error path pointer at index.
export fn validate_error_path_ptr(i: u32) [*]const u8 {
    const v = validator orelse return @ptrFromInt(1);
    return v.getErrorPathPtr(i);
}

/// Get validation error path length at index.
export fn validate_error_path_len(i: u32) u32 {
    const v = validator orelse return 0;
    return v.getErrorPathLen(i);
}

/// Get validation error message pointer at index.
export fn validate_error_msg_ptr(i: u32) [*]const u8 {
    const v = validator orelse return @ptrFromInt(1);
    return v.getErrorMsgPtr(i);
}

/// Get validation error message length at index.
export fn validate_error_msg_len(i: u32) u32 {
    const v = validator orelse return 0;
    return v.getErrorMsgLen(i);
}

/// Free the validator state.
export fn validate_free() void {
    if (validator) |v| {
        v.deinit();
        validator = null;
    }
}

// --- Stringify exports ---
const stringify_mod = @import("stringify.zig");

var stringifier: stringify_mod.Stringifier = .{};

/// Initialize the stringifier. Must be called before writing tokens.
export fn stringify_init() void {
    stringifier.deinit();
    stringifier.init(gpa);
}

/// Write a null value.
export fn stringify_null() void {
    stringifier.writeNull();
}

/// Write a boolean value (0=false, non-zero=true).
export fn stringify_bool(val: i32) void {
    stringifier.writeBool(val);
}

/// Write a number value.
export fn stringify_number(val: f64) void {
    stringifier.writeNumber(val);
}

/// Write a string value. Reads UTF-8 bytes from (ptr, len) in engine memory.
export fn stringify_string(ptr: [*]const u8, len: u32) void {
    stringifier.writeString(ptr, len);
}

/// Write an object key. Reads UTF-8 bytes from (ptr, len) in engine memory.
export fn stringify_key(ptr: [*]const u8, len: u32) void {
    stringifier.writeKey(ptr, len);
}

/// Write '{' and push object depth.
export fn stringify_object_start() void {
    stringifier.writeObjectStart();
}

/// Write '}' and pop object depth.
export fn stringify_object_end() void {
    stringifier.writeObjectEnd();
}

/// Write '[' and push array depth.
export fn stringify_array_start() void {
    stringifier.writeArrayStart();
}

/// Write ']' and pop array depth.
export fn stringify_array_end() void {
    stringifier.writeArrayEnd();
}

/// Get pointer to the result buffer.
export fn stringify_result_ptr() [*]const u8 {
    return stringifier.getResultPtr();
}

/// Get length of the result buffer.
export fn stringify_result_len() u32 {
    return stringifier.getResultLen();
}

/// Free the result buffer.
export fn stringify_free() void {
    stringifier.deinit();
}

// ============================================================
// Document Slot System — "True Lazy" tape-direct navigation
// ============================================================
//
// Instead of building a WasmGC tree eagerly, we parse into a tape and
// return a document handle (i32 slot ID). JS navigates the tape on
// demand via doc_get_tag, doc_find_field, doc_array_at, etc.
//
// Each slot owns a separate DomParser instance so multiple documents
// can coexist. When a slot is freed, the parser's internal buffers are
// retained for reuse by the next parse in that slot.

const MAX_DOC_SLOTS = 256;
var doc_parsers: [MAX_DOC_SLOTS]DomParser = .{DomParser.init} ** MAX_DOC_SLOTS;
var doc_active: [MAX_DOC_SLOTS]bool = .{false} ** MAX_DOC_SLOTS;

fn getDocParser(doc_id: i32) ?*DomParser {
    if (doc_id < 0 or doc_id >= MAX_DOC_SLOTS) return null;
    const uid: usize = @intCast(doc_id);
    if (!doc_active[uid]) return null;
    return &doc_parsers[uid];
}

/// Read a string value from a parser's tape at the given index.
/// Returns the raw byte slice pointing into the parser's string buffer.
fn readTapeString(p: *DomParser, index: u32) []const u8 {
    const native_endian = @import("builtin").cpu.arch.endian();
    const word = p.tape.get(index);
    const str_offset = word.data.ptr;
    const strings = p.tape.string_buffer.strings.items();
    const low_bits = std.mem.readInt(u16, strings.ptr[str_offset..][0..@sizeOf(u16)], native_endian);
    const high_bits: u64 = word.data.len;
    const str_len: u32 = @intCast(high_bits << 16 | low_bits);
    return strings.ptr[str_offset + @sizeOf(u16) ..][0..str_len];
}

/// Parse JSON bytes and store the result in a document slot.
/// Returns slot ID (0..15) on success, or -1 on error.
/// The error code is available via get_error_code().
export fn doc_parse(ptr: [*]const u8, len: u32) i32 {
    last_error_code = 0;

    // Find a free slot
    var slot_id: i32 = -1;
    for (&doc_active, 0..) |*active, i| {
        if (!active.*) {
            slot_id = @intCast(i);
            break;
        }
    }
    if (slot_id < 0) {
        last_error_code = 2; // ExceededCapacity
        return -1;
    }

    const uid: usize = @intCast(slot_id);
    _ = doc_parsers[uid].parseFromSlice(gpa, ptr[0..len]) catch |err| {
        last_error_code = mapError(err);
        return -1;
    };

    doc_active[uid] = true;
    return slot_id;
}

/// Free a document slot, marking it available for reuse.
/// Parser buffers are retained — parseFromSlice reuses them automatically:
///   string_buffer.reset() clears data, retains capacity
///   ensureTotalCapacityForSlice only grows, never shrinks
export fn doc_free(doc_id: i32) void {
    if (doc_id < 0 or doc_id >= MAX_DOC_SLOTS) return;
    const uid: usize = @intCast(doc_id);
    doc_active[uid] = false;
}

/// Get the tag type of the value at the given tape index.
/// Returns: 0=null, 1=true, 2=false, 3=number, 4=string, 5=object, 6=array, -1=error
export fn doc_get_tag(doc_id: i32, index: u32) i32 {
    const p = getDocParser(doc_id) orelse return -1;
    const word = p.tape.get(index);
    return switch (word.tag) {
        .null => 0,
        .true => 1,
        .false => 2,
        .unsigned, .signed, .double => 3,
        .string => 4,
        .object_opening => 5,
        .array_opening => 6,
        else => -1,
    };
}

/// Get the numeric value at the given tape index as f64.
export fn doc_get_number(doc_id: i32, index: u32) f64 {
    const p = getDocParser(doc_id) orelse return 0;
    const word = p.tape.get(index);
    const next_raw: u64 = @bitCast(p.tape.get(index + 1));
    return switch (word.tag) {
        .unsigned => @floatFromInt(@as(u64, next_raw)),
        .signed => @floatFromInt(@as(i64, @bitCast(next_raw))),
        .double => @bitCast(next_raw),
        else => 0,
    };
}

/// Get a pointer to the string data at the given tape index.
export fn doc_get_string_ptr(doc_id: i32, index: u32) [*]const u8 {
    const p = getDocParser(doc_id) orelse return @ptrFromInt(1);
    const str = readTapeString(p, index);
    return str.ptr;
}

/// Get the length of the string at the given tape index.
export fn doc_get_string_len(doc_id: i32, index: u32) u32 {
    const p = getDocParser(doc_id) orelse return 0;
    const str = readTapeString(p, index);
    return @intCast(str.len);
}

/// Get the child count of a container (object or array) at the given tape index.
export fn doc_get_count(doc_id: i32, index: u32) u32 {
    const p = getDocParser(doc_id) orelse return 0;
    const word = p.tape.get(index);
    return switch (word.tag) {
        .object_opening, .array_opening => word.data.len,
        else => 0,
    };
}

/// Find a field in an object by key. Returns the tape index of the VALUE,
/// or 0 if not found (0 is the root word, never a valid value position).
export fn doc_find_field(doc_id: i32, obj_index: u32, key_ptr: [*]const u8, key_len: u32) u32 {
    const p = getDocParser(doc_id) orelse return 0;
    const word = p.tape.get(obj_index);
    if (word.tag != .object_opening) return 0;

    var curr: u32 = obj_index + 1; // first key position
    while (true) {
        const w = p.tape.get(curr);
        if (w.tag == .object_closing) return 0; // not found

        // curr points to a key (string)
        const key_str = readTapeString(p, curr);
        if (key_str.len == key_len and simd.eql(key_str.ptr, key_ptr, key_len)) {
            return curr + 1; // value is immediately after the key
        }

        // Skip to next key: advance past key + value
        const val_w = p.tape.get(curr + 1);
        curr = switch (val_w.tag) {
            .array_opening, .object_opening => val_w.data.ptr, // past closing bracket
            .unsigned, .signed, .double => curr + 3, // key + value_tag + number_data
            else => curr + 2, // key + value
        };
    }
}

/// Get the tape index of the nth element in an array.
/// Returns 0 if out of bounds.
export fn doc_array_at(doc_id: i32, arr_index: u32, n: u32) u32 {
    const p = getDocParser(doc_id) orelse return 0;
    const word = p.tape.get(arr_index);
    if (word.tag != .array_opening) return 0;

    var curr: u32 = arr_index + 1; // first element
    var i: u32 = 0;
    while (true) {
        const w = p.tape.get(curr);
        if (w.tag == .array_closing) return 0; // out of bounds
        if (i == n) return curr;

        // Skip current element
        curr = switch (w.tag) {
            .array_opening, .object_opening => w.data.ptr,
            .unsigned, .signed, .double => curr + 2,
            else => curr + 1,
        };
        i += 1;
    }
}

/// Get the tape index of the nth key in an object.
/// Returns 0 if out of bounds. Use doc_get_string_ptr/len to read the key.
export fn doc_obj_key_at(doc_id: i32, obj_index: u32, n: u32) u32 {
    const p = getDocParser(doc_id) orelse return 0;
    const word = p.tape.get(obj_index);
    if (word.tag != .object_opening) return 0;

    var curr: u32 = obj_index + 1; // first key
    var i: u32 = 0;
    while (true) {
        const w = p.tape.get(curr);
        if (w.tag == .object_closing) return 0;
        if (i == n) return curr;

        // Skip to next key: advance past key + value
        const val_w = p.tape.get(curr + 1);
        curr = switch (val_w.tag) {
            .array_opening, .object_opening => val_w.data.ptr,
            .unsigned, .signed, .double => curr + 3,
            else => curr + 2,
        };
        i += 1;
    }
}

/// Get the tape index of the value at the nth key in an object.
/// Returns 0 if out of bounds.
export fn doc_obj_val_at(doc_id: i32, obj_index: u32, n: u32) u32 {
    const key_idx = doc_obj_key_at(doc_id, obj_index, n);
    if (key_idx == 0) return 0;
    return key_idx + 1; // value is immediately after key
}

// --- Batch iteration exports ---
// These walk a container ONCE and return all child tape indices,
// turning O(N²) sequential access into O(N).

/// Static batch buffer: 64KB = 16384 u32 indices.
/// Covers arrays/objects up to 16K elements in one batch call.
var batch_buffer: [16384]u32 = undefined;

/// Get a pointer to the batch buffer (for JS to read results).
export fn doc_batch_ptr() [*]u32 {
    return &batch_buffer;
}

/// Walk an array once, writing element tape indices into batch_buffer.
/// Returns the number of elements written (capped at 1024).
export fn doc_array_elements(doc_id: i32, arr_index: u32) u32 {
    const p = getDocParser(doc_id) orelse return 0;
    const word = p.tape.get(arr_index);
    if (word.tag != .array_opening) return 0;

    var curr: u32 = arr_index + 1;
    var count: u32 = 0;
    while (count < 16384) {
        const w = p.tape.get(curr);
        if (w.tag == .array_closing) break;
        batch_buffer[count] = curr;
        count += 1;

        // Advance to next element
        curr = switch (w.tag) {
            .array_opening, .object_opening => w.data.ptr,
            .unsigned, .signed, .double => curr + 2,
            else => curr + 1,
        };
    }
    return count;
}

/// Walk an object once, writing key tape indices into batch_buffer.
/// Value index = key_index + 1.
/// Returns the number of entries written (capped at 1024).
export fn doc_object_keys(doc_id: i32, obj_index: u32) u32 {
    const p = getDocParser(doc_id) orelse return 0;
    const word = p.tape.get(obj_index);
    if (word.tag != .object_opening) return 0;

    var curr: u32 = obj_index + 1;
    var count: u32 = 0;
    while (count < 16384) {
        const w = p.tape.get(curr);
        if (w.tag == .object_closing) break;
        batch_buffer[count] = curr; // key index
        count += 1;

        // Skip past key + value
        const val_w = p.tape.get(curr + 1);
        curr = switch (val_w.tag) {
            .array_opening, .object_opening => val_w.data.ptr,
            .unsigned, .signed, .double => curr + 3,
            else => curr + 2,
        };
    }
    return count;
}

// --- Batch column read: read one field across all array elements in one WASM call ---
// Struct-of-Arrays pattern: instead of N cross-module calls, one call reads the entire column.

/// Static f64 output buffer for batch column reads (8 bytes × 16384 = 128KB).
var f64_batch: [16384]f64 = undefined;

/// Get pointer to the f64 batch buffer (JS reads results via Float64Array view).
export fn doc_f64_batch_ptr() [*]f64 {
    return &f64_batch;
}

/// Read the number value at field `field_idx` from every object element in an array.
/// Writes f64 values into f64_batch. Returns number of rows written.
/// Array elements must be objects. Non-number values write 0.0.
export fn doc_read_column_f64(doc_id: i32, arr_index: u32, field_idx: u32) u32 {
    const p = getDocParser(doc_id) orelse return 0;
    const word = p.tape.get(arr_index);
    if (word.tag != .array_opening) return 0;

    var elem_curr: u32 = arr_index + 1;
    var row: u32 = 0;
    while (row < 16384) {
        const ew = p.tape.get(elem_curr);
        if (ew.tag == .array_closing) break;
        if (ew.tag != .object_opening) {
            f64_batch[row] = 0.0;
            // Skip element
            elem_curr = switch (ew.tag) {
                .array_opening, .object_opening => ew.data.ptr,
                .unsigned, .signed, .double => elem_curr + 2,
                else => elem_curr + 1,
            };
            row += 1;
            continue;
        }

        // Navigate to field_idx within this object
        var field_curr: u32 = elem_curr + 1;
        var fi: u32 = 0;
        while (fi < field_idx) : (fi += 1) {
            const kw = p.tape.get(field_curr);
            if (kw.tag == .object_closing) break;
            // Skip key + value
            const vw = p.tape.get(field_curr + 1);
            field_curr = switch (vw.tag) {
                .array_opening, .object_opening => vw.data.ptr,
                .unsigned, .signed, .double => field_curr + 3,
                else => field_curr + 2,
            };
        }

        // Read the value at field_curr + 1 (key is at field_curr)
        const val_idx = field_curr + 1;
        const vword = p.tape.get(val_idx);
        const next_raw: u64 = @bitCast(p.tape.get(val_idx + 1));
        f64_batch[row] = switch (vword.tag) {
            .unsigned => @floatFromInt(@as(u64, next_raw)),
            .signed => @floatFromInt(@as(i64, @bitCast(next_raw))),
            .double => @bitCast(next_raw),
            else => 0.0,
        };

        // Advance to next array element
        elem_curr = ew.data.ptr; // object_opening.data.ptr = past the object_closing
        row += 1;
    }
    return row;
}

/// Read the tag byte at field `field_idx` from every object element in an array.
/// Writes tag values (as u32) into batch_buffer. Returns number of rows written.
export fn doc_read_column_tags(doc_id: i32, arr_index: u32, field_idx: u32) u32 {
    const p = getDocParser(doc_id) orelse return 0;
    const word = p.tape.get(arr_index);
    if (word.tag != .array_opening) return 0;

    var elem_curr: u32 = arr_index + 1;
    var row: u32 = 0;
    while (row < 16384) {
        const ew = p.tape.get(elem_curr);
        if (ew.tag == .array_closing) break;
        if (ew.tag != .object_opening) {
            batch_buffer[row] = 0;
            elem_curr = switch (ew.tag) {
                .array_opening, .object_opening => ew.data.ptr,
                .unsigned, .signed, .double => elem_curr + 2,
                else => elem_curr + 1,
            };
            row += 1;
            continue;
        }

        var field_curr: u32 = elem_curr + 1;
        var fi: u32 = 0;
        while (fi < field_idx) : (fi += 1) {
            const kw = p.tape.get(field_curr);
            if (kw.tag == .object_closing) break;
            const vw = p.tape.get(field_curr + 1);
            field_curr = switch (vw.tag) {
                .array_opening, .object_opening => vw.data.ptr,
                .unsigned, .signed, .double => field_curr + 3,
                else => field_curr + 2,
            };
        }

        const val_idx = field_curr + 1;
        const vword = p.tape.get(val_idx);
        batch_buffer[row] = @intFromEnum(vword.tag);

        elem_curr = ew.data.ptr;
        row += 1;
    }
    return row;
}

/// Read the boolean value at field `field_idx` from every object element.
/// Writes u32 values (0=false, 1=true) into batch_buffer. Returns row count.
export fn doc_read_column_bool(doc_id: i32, arr_index: u32, field_idx: u32) u32 {
    const p = getDocParser(doc_id) orelse return 0;
    const word = p.tape.get(arr_index);
    if (word.tag != .array_opening) return 0;

    var elem_curr: u32 = arr_index + 1;
    var row: u32 = 0;
    while (row < 16384) {
        const ew = p.tape.get(elem_curr);
        if (ew.tag == .array_closing) break;
        if (ew.tag != .object_opening) {
            batch_buffer[row] = 0;
            elem_curr = switch (ew.tag) {
                .array_opening, .object_opening => ew.data.ptr,
                .unsigned, .signed, .double => elem_curr + 2,
                else => elem_curr + 1,
            };
            row += 1;
            continue;
        }

        var field_curr: u32 = elem_curr + 1;
        var fi: u32 = 0;
        while (fi < field_idx) : (fi += 1) {
            const kw = p.tape.get(field_curr);
            if (kw.tag == .object_closing) break;
            const vw = p.tape.get(field_curr + 1);
            field_curr = switch (vw.tag) {
                .array_opening, .object_opening => vw.data.ptr,
                .unsigned, .signed, .double => field_curr + 3,
                else => field_curr + 2,
            };
        }

        const val_idx = field_curr + 1;
        const vword = p.tape.get(val_idx);
        batch_buffer[row] = if (vword.tag == .true) 1 else 0;

        elem_curr = ew.data.ptr;
        row += 1;
    }
    return row;
}

/// Read string pointer+length pairs at field `field_idx` from every object in array.
/// Writes [ptr0, len0, ptr1, len1, ...] into batch_buffer (2 u32s per row).
/// Returns number of rows (pairs = rows * 2 entries in batch_buffer).
/// Max 8192 rows (16384 / 2).
export fn doc_read_column_str(doc_id: i32, arr_index: u32, field_idx: u32) u32 {
    const p = getDocParser(doc_id) orelse return 0;
    const word = p.tape.get(arr_index);
    if (word.tag != .array_opening) return 0;

    var elem_curr: u32 = arr_index + 1;
    var row: u32 = 0;
    while (row < 8192) {
        const ew = p.tape.get(elem_curr);
        if (ew.tag == .array_closing) break;
        if (ew.tag != .object_opening) {
            batch_buffer[row * 2] = 0;
            batch_buffer[row * 2 + 1] = 0;
            elem_curr = switch (ew.tag) {
                .array_opening, .object_opening => ew.data.ptr,
                .unsigned, .signed, .double => elem_curr + 2,
                else => elem_curr + 1,
            };
            row += 1;
            continue;
        }

        var field_curr: u32 = elem_curr + 1;
        var fi: u32 = 0;
        while (fi < field_idx) : (fi += 1) {
            const kw = p.tape.get(field_curr);
            if (kw.tag == .object_closing) break;
            const vw = p.tape.get(field_curr + 1);
            field_curr = switch (vw.tag) {
                .array_opening, .object_opening => vw.data.ptr,
                .unsigned, .signed, .double => field_curr + 3,
                else => field_curr + 2,
            };
        }

        // Read string at field_curr + 1
        const val_idx = field_curr + 1;
        const str = readTapeString(p, val_idx);
        batch_buffer[row * 2] = @intFromPtr(str.ptr);
        batch_buffer[row * 2 + 1] = @intCast(str.len);

        elem_curr = ew.data.ptr;
        row += 1;
    }
    return row;
}

/// Batch string column → contiguous UTF-16LE with offset table.
/// SIMD-converts ALL strings in ONE call. Output split into two buffers:
///   - batch_buffer: [row_count, charOffset_0, charOffset_1, ..., charOffset_N]
///     where charOffset_i is the char start position for string i in the UTF-16 buffer.
///     The length of string i = charOffset_{i+1} - charOffset_i.
///   - UTF-16 buffer (via get_utf16_ptr): contiguous UTF-16LE code units, no gaps.
/// JS creates ONE big JS string from the entire buffer, then .slice() each substring.
/// Returns total char count (for JS to read the UTF-16 buffer).
export fn doc_read_column_str_utf16(doc_id: i32, arr_index: u32, field_idx: u32) u32 {
    const p = getDocParser(doc_id) orelse return 0;
    const word = p.tape.get(arr_index);
    if (word.tag != .array_opening) return 0;

    // First pass: count elements and total UTF-8 bytes (for buffer sizing)
    var total_utf8_bytes: u32 = 0;
    var elem_count: u32 = 0;
    {
        var ec: u32 = arr_index + 1;
        while (true) {
            const ew = p.tape.get(ec);
            if (ew.tag == .array_closing) break;
            if (ew.tag == .object_opening) {
                var fc: u32 = ec + 1;
                var fi: u32 = 0;
                while (fi < field_idx) : (fi += 1) {
                    const kw = p.tape.get(fc);
                    if (kw.tag == .object_closing) break;
                    const vw = p.tape.get(fc + 1);
                    fc = switch (vw.tag) {
                        .array_opening, .object_opening => vw.data.ptr,
                        .unsigned, .signed, .double => fc + 3,
                        else => fc + 2,
                    };
                }
                const str = readTapeString(p, fc + 1);
                total_utf8_bytes += @intCast(str.len);
            }
            elem_count += 1;
            ec = switch (ew.tag) {
                .array_opening, .object_opening => ew.data.ptr,
                .unsigned, .signed, .double => ec + 2,
                else => ec + 1,
            };
        }
    }

    if (elem_count == 0) return 0;

    // Allocate UTF-16 buffer (worst case: each UTF-8 byte → 1 UTF-16 code unit)
    const buf = getUtf16Buf(total_utf8_bytes * 2) orelse return 0;

    // batch_buffer layout: [elem_count, offset_0, offset_1, ..., offset_N]
    // offset_N is the total char count (sentinel for computing last string's length)
    batch_buffer[0] = elem_count;
    var out: u32 = 0; // byte offset into buf
    var row: u32 = 0;

    // Second pass: SIMD-convert each string, write offsets
    var ec2: u32 = arr_index + 1;
    while (true) {
        const ew = p.tape.get(ec2);
        if (ew.tag == .array_closing) break;

        // Record char offset for this row
        batch_buffer[1 + row] = out / 2; // char offset (not byte offset)

        if (ew.tag == .object_opening) {
            var fc: u32 = ec2 + 1;
            var fi: u32 = 0;
            while (fi < field_idx) : (fi += 1) {
                const kw = p.tape.get(fc);
                if (kw.tag == .object_closing) break;
                const vw = p.tape.get(fc + 1);
                fc = switch (vw.tag) {
                    .array_opening, .object_opening => vw.data.ptr,
                    .unsigned, .signed, .double => fc + 3,
                    else => fc + 2,
                };
            }
            const str = readTapeString(p, fc + 1);
            if (str.len > 0) {
                const bytes_written = utf8ToUtf16Le(str, buf, out);
                out += bytes_written;
            }
        }
        // else: non-object element → empty string (offset stays same as next)

        row += 1;
        ec2 = switch (ew.tag) {
            .array_opening, .object_opening => ew.data.ptr,
            .unsigned, .signed, .double => ec2 + 2,
            else => ec2 + 1,
        };
    }

    // Sentinel: total char count (so JS can compute last string's length)
    batch_buffer[1 + row] = out / 2;

    return out / 2; // total char count
}

// --- Doc stringify: tape → JSON bytes in one WASM call ---
// Walks the tape recursively, uses the existing Stringifier to produce JSON.
// Zero cross-module calls. Zero intermediate JS strings.

/// Stringify a document value at the given tape index.
/// Initializes the stringifier, walks the tape, produces JSON bytes.
/// Result accessible via stringify_result_ptr/len. Caller must call stringify_free.
export fn doc_stringify(doc_id: i32, index: u32) i32 {
    const p = getDocParser(doc_id) orelse return -1;
    stringifier.init(gpa);
    docStringifyValue(p, index);
    if (stringifier.has_error) return -1;
    return 0;
}

fn docStringifyValue(p: *DomParser, index: u32) void {
    const word = p.tape.get(index);
    switch (word.tag) {
        .null => stringifier.writeNull(),
        .true => stringifier.writeBool(1),
        .false => stringifier.writeBool(0),
        .unsigned => {
            const next_raw: u64 = @bitCast(p.tape.get(index + 1));
            const val: f64 = @floatFromInt(@as(u64, next_raw));
            stringifier.writeNumber(val);
        },
        .signed => {
            const next_raw: u64 = @bitCast(p.tape.get(index + 1));
            const val: f64 = @floatFromInt(@as(i64, @bitCast(next_raw)));
            stringifier.writeNumber(val);
        },
        .double => {
            const next_raw: u64 = @bitCast(p.tape.get(index + 1));
            stringifier.writeNumber(@bitCast(next_raw));
        },
        .string => {
            const str = readTapeString(p, index);
            stringifier.writeString(str.ptr, @intCast(str.len));
        },
        .array_opening => {
            stringifier.writeArrayStart();
            const count = word.data.len;
            // Walk array elements sequentially
            var curr: u32 = index + 1;
            var i: u32 = 0;
            while (i < count) : (i += 1) {
                const w = p.tape.get(curr);
                if (w.tag == .array_closing) break;
                docStringifyValue(p, curr);
                // Advance past current element
                curr = switch (w.tag) {
                    .array_opening, .object_opening => w.data.ptr,
                    .unsigned, .signed, .double => curr + 2,
                    else => curr + 1,
                };
            }
            stringifier.writeArrayEnd();
        },
        .object_opening => {
            stringifier.writeObjectStart();
            const count = word.data.len;
            // Walk key-value pairs sequentially
            var curr: u32 = index + 1;
            var i: u32 = 0;
            while (i < count) : (i += 1) {
                const w = p.tape.get(curr);
                if (w.tag == .object_closing) break;
                // Write key
                const key_str = readTapeString(p, curr);
                stringifier.writeKey(key_str.ptr, @intCast(key_str.len));
                // Write value
                docStringifyValue(p, curr + 1);
                // Advance past key + value
                const val_w = p.tape.get(curr + 1);
                curr = switch (val_w.tag) {
                    .array_opening, .object_opening => val_w.data.ptr,
                    .unsigned, .signed, .double => curr + 3,
                    else => curr + 2,
                };
            }
            stringifier.writeObjectEnd();
        },
        else => stringifier.writeNull(),
    }
}

// --- Eager materialization: tape → flat binary buffer in one WASM call ---
//
// Uses an arena allocator: all materialization allocations are pointer bumps,
// and doc_materialize_free() resets the entire arena instantly.
//
// Buffer format (depth-first traversal):
//   TAG_NULL(0):   [0]
//   TAG_TRUE(1):   [1]
//   TAG_FALSE(2):  [2]
//   TAG_NUMBER(3): [3][f64 LE 8 bytes]
//   TAG_STRING(4): [4][u32 LE char_count][pad?][...utf16le code units]
//   TAG_ARRAY(5):  [5][u32 LE count][...children]
//   TAG_OBJECT(6): [6][u32 LE count][u32 key_char_count][pad?][key utf16le]...[child value]...
//
// Strings are encoded as UTF-16LE code units. A 1-byte alignment pad is
// inserted before the u16 data when the current offset is odd, so that
// JS can construct a Uint16Array view directly (requires 2-byte alignment).
// JS reads this buffer linearly via String.fromCharCode — zero TextDecoder,
// zero FFI calls needed.

var mat_arena: std.heap.ArenaAllocator = std.heap.ArenaAllocator.init(page_alloc);
var mat_buffer: ?[*]u8 = null;
var mat_len: u32 = 0;
var mat_cap: u32 = 0;
var mat_error: bool = false;

fn matEnsure(need: u32) void {
    if (mat_error) return;
    const required = mat_len + need;
    if (required <= mat_cap) return;
    var new_cap = if (mat_cap == 0) @as(u32, 4096) else mat_cap;
    while (new_cap < required) new_cap *|= 2;
    const allocator = mat_arena.allocator();
    if (mat_buffer) |buf| {
        const new = allocator.realloc(buf[0..mat_cap], new_cap) catch {
            mat_error = true;
            return;
        };
        mat_buffer = new.ptr;
    } else {
        const new = allocator.alloc(u8, new_cap) catch {
            mat_error = true;
            return;
        };
        mat_buffer = new.ptr;
    }
    mat_cap = new_cap;
}

fn matWriteByte(b: u8) void {
    matEnsure(1);
    if (mat_error) return;
    mat_buffer.?[mat_len] = b;
    mat_len += 1;
}

fn matWriteU32(v: u32) void {
    matEnsure(4);
    if (mat_error) return;
    const buf = mat_buffer.?;
    std.mem.writeInt(u32, buf[mat_len..][0..4], v, .little);
    mat_len += 4;
}

fn matWriteF64(v: f64) void {
    matEnsure(8);
    if (mat_error) return;
    const buf = mat_buffer.?;
    const bytes: [8]u8 = @bitCast(v);
    @memcpy(buf[mat_len..][0..8], &bytes);
    mat_len += 8;
}

fn matWriteBytes(data: []const u8) void {
    const len: u32 = @intCast(data.len);
    matEnsure(len);
    if (mat_error) return;
    @memcpy(mat_buffer.?[mat_len..][0..len], data);
    mat_len += len;
}

// --- UTF-8 → UTF-16LE conversion for eager materialization ---

/// Count the number of UTF-16 code units needed to represent a UTF-8 byte slice.
/// For ASCII (the common case in JSON), each byte maps to exactly one u16.
fn utf8Utf16Len(src: []const u8) u32 {
    var i: usize = 0;
    var count: u32 = 0;
    while (i < src.len) {
        const b = src[i];
        if (b < 0x80) {
            count += 1;
            i += 1;
        } else if (b < 0xE0) {
            count += 1;
            i += 2;
        } else if (b < 0xF0) {
            count += 1;
            i += 3;
        } else {
            count += 2; // surrogate pair
            i += 4;
        }
    }
    return count;
}

/// Convert UTF-8 bytes to UTF-16LE, writing directly into a byte buffer.
/// For ASCII bytes, this is just widening: byte → [byte, 0x00].
/// For multi-byte sequences, decodes the codepoint and writes u16 LE.
/// For codepoints above U+FFFF, writes a UTF-16 surrogate pair (2 × u16).
/// Returns the number of bytes written (= char_count * 2).
/// SIMD fast path: process 16 ASCII bytes → 16 u16 (32 bytes) at once.
fn utf8ToUtf16Le(src: []const u8, dst: [*]u8, start: u32) u32 {
    var i: usize = 0;
    var out: u32 = start;

    // SIMD fast path: process 16 ASCII bytes at a time.
    // JSON keys/values are almost always ASCII — this is the common case.
    // Uses WASM SIMD i16x8.extend_{low,high}_i8x16_u for zero-widening,
    // then v128.store for 16-byte bulk writes.
    const V16 = @Vector(16, u8);
    const V8u16 = @Vector(8, u16);
    const high_bit: V16 = @splat(0x80);
    while (i + 16 <= src.len) {
        const chunk: V16 = src[i..][0..16].*;
        // Check if ALL 16 bytes are ASCII (< 0x80)
        if (@reduce(.Or, chunk & high_bit) == 0) {
            // Extract low/high halves via @shuffle
            const low_half: @Vector(8, u8) = @shuffle(u8, chunk, undefined, @as(@Vector(8, i32), .{ 0, 1, 2, 3, 4, 5, 6, 7 }));
            const high_half: @Vector(8, u8) = @shuffle(u8, chunk, undefined, @as(@Vector(8, i32), .{ 8, 9, 10, 11, 12, 13, 14, 15 }));
            // Zero-extend to u16 (WASM: i16x8.extend_{low,high}_i8x16_u)
            const wide_low: V8u16 = @intCast(low_half);
            const wide_high: V8u16 = @intCast(high_half);
            // Store as bytes (WASM: v128.store — 16 bytes per store)
            dst[out..][0..16].* = @bitCast(wide_low);
            dst[out + 16 ..][0..16].* = @bitCast(wide_high);
            out += 32;
            i += 16;
            continue;
        }
        // Non-ASCII chunk — fall through to scalar loop
        break;
    }

    while (i < src.len) {
        const b = src[i];
        if (b < 0x80) {
            // ASCII — most common case in JSON keys/values
            dst[out] = b;
            dst[out + 1] = 0;
            out += 2;
            i += 1;
        } else if (b < 0xE0) {
            // 2-byte UTF-8 → 1 BMP code unit
            const cp: u32 = (@as(u32, b & 0x1F) << 6) | @as(u32, src[i + 1] & 0x3F);
            dst[out] = @truncate(cp);
            dst[out + 1] = @truncate(cp >> 8);
            out += 2;
            i += 2;
        } else if (b < 0xF0) {
            // 3-byte UTF-8 → 1 BMP code unit
            const cp: u32 = (@as(u32, b & 0x0F) << 12) | (@as(u32, src[i + 1] & 0x3F) << 6) | @as(u32, src[i + 2] & 0x3F);
            dst[out] = @truncate(cp);
            dst[out + 1] = @truncate(cp >> 8);
            out += 2;
            i += 3;
        } else {
            // 4-byte UTF-8 → surrogate pair (2 × u16)
            const cp: u32 = (@as(u32, b & 0x07) << 18) | (@as(u32, src[i + 1] & 0x3F) << 12) | (@as(u32, src[i + 2] & 0x3F) << 6) | @as(u32, src[i + 3] & 0x3F);
            const adj = cp - 0x10000;
            const high: u16 = @intCast(0xD800 + (adj >> 10));
            const low: u16 = @intCast(0xDC00 + (adj & 0x3FF));
            dst[out] = @truncate(high);
            dst[out + 1] = @truncate(high >> 8);
            dst[out + 2] = @truncate(low);
            dst[out + 3] = @truncate(low >> 8);
            out += 4;
            i += 4;
        }
    }
    return out - start;
}

/// Write a UTF-8 string as UTF-16LE into the materialization buffer.
/// Format: [u32 char_count][pad?][...utf16le code units]
/// Single-pass: allocates upper-bound space, converts, then patches char_count.
/// Upper bound: each UTF-8 byte → at most 1 UTF-16 code unit (src.len u16s).
fn matWriteStringUtf16(str: []const u8) void {
    if (mat_error) return;
    if (str.len == 0) {
        matWriteU32(0);
        return;
    }
    // Single matEnsure for: u32 header(4) + pad(1) + data(src.len * 2)
    const max_data_bytes: u32 = @intCast(str.len * 2);
    matEnsure(5 + max_data_bytes);
    if (mat_error) return;
    // Write placeholder char_count (patched after conversion)
    const count_pos = mat_len;
    const buf = mat_buffer.?;
    std.mem.writeInt(u32, buf[mat_len..][0..4], 0, .little);
    mat_len += 4;
    // Pad to 2-byte alignment for Uint16Array on JS side
    if (mat_len & 1 != 0) {
        buf[mat_len] = 0;
        mat_len += 1;
    }
    // Convert UTF-8 → UTF-16LE in one pass (no separate length scan)
    const bytes_written = utf8ToUtf16Le(str, buf, mat_len);
    mat_len += bytes_written;
    // Patch actual char_count
    std.mem.writeInt(u32, buf[count_pos..][0..4], bytes_written / 2, .little);
}

noinline fn docMaterializeValue(p: *DomParser, index: u32) void {
    if (mat_error) return;
    const word = p.tape.get(index);
    switch (word.tag) {
        .null => matWriteByte(0),
        .true => matWriteByte(1),
        .false => matWriteByte(2),
        .unsigned => {
            matWriteByte(3);
            const next_raw: u64 = @bitCast(p.tape.get(index + 1));
            matWriteF64(@floatFromInt(@as(u64, next_raw)));
        },
        .signed => {
            matWriteByte(3);
            const next_raw: u64 = @bitCast(p.tape.get(index + 1));
            matWriteF64(@floatFromInt(@as(i64, @bitCast(next_raw))));
        },
        .double => {
            matWriteByte(3);
            const next_raw: u64 = @bitCast(p.tape.get(index + 1));
            matWriteF64(@bitCast(next_raw));
        },
        .string => {
            const str = readTapeString(p, index);
            if (str.len == 0) {
                // tag(1) + u32(4) = 5 bytes total
                matEnsure(5);
                if (mat_error) return;
                const buf = mat_buffer.?;
                buf[mat_len] = 4;
                std.mem.writeInt(u32, buf[mat_len + 1 ..][0..4], 0, .little);
                mat_len += 5;
            } else {
                // tag(1) + u32(4) + pad(1) + data(src.len * 2) — single alloc check
                const max_data: u32 = @intCast(str.len * 2);
                matEnsure(6 + max_data);
                if (mat_error) return;
                const buf = mat_buffer.?;
                buf[mat_len] = 4;
                mat_len += 1;
                const count_pos = mat_len;
                std.mem.writeInt(u32, buf[mat_len..][0..4], 0, .little);
                mat_len += 4;
                if (mat_len & 1 != 0) {
                    buf[mat_len] = 0;
                    mat_len += 1;
                }
                const bytes_written = utf8ToUtf16Le(str, buf, mat_len);
                mat_len += bytes_written;
                std.mem.writeInt(u32, buf[count_pos..][0..4], bytes_written / 2, .little);
            }
        },
        .array_opening => {
            matWriteByte(5);
            const count = word.data.len;
            matWriteU32(count);
            var curr: u32 = index + 1;
            var i: u32 = 0;
            while (i < count) : (i += 1) {
                const w = p.tape.get(curr);
                if (w.tag == .array_closing) break;
                docMaterializeValue(p, curr);
                curr = switch (w.tag) {
                    .array_opening, .object_opening => w.data.ptr,
                    .unsigned, .signed, .double => curr + 2,
                    else => curr + 1,
                };
            }
        },
        .object_opening => {
            matWriteByte(6);
            const count = word.data.len;
            matWriteU32(count);
            var curr: u32 = index + 1;
            var i: u32 = 0;
            while (i < count) : (i += 1) {
                const w = p.tape.get(curr);
                if (w.tag == .object_closing) break;
                // Write key as UTF-16LE (inlined for single matEnsure)
                const key_str = readTapeString(p, curr);
                if (key_str.len == 0) {
                    matEnsure(4);
                    if (mat_error) return;
                    std.mem.writeInt(u32, mat_buffer.?[mat_len..][0..4], 0, .little);
                    mat_len += 4;
                } else {
                    const max_key_data: u32 = @intCast(key_str.len * 2);
                    matEnsure(5 + max_key_data);
                    if (mat_error) return;
                    const kb = mat_buffer.?;
                    const kcount_pos = mat_len;
                    std.mem.writeInt(u32, kb[mat_len..][0..4], 0, .little);
                    mat_len += 4;
                    if (mat_len & 1 != 0) {
                        kb[mat_len] = 0;
                        mat_len += 1;
                    }
                    const kbw = utf8ToUtf16Le(key_str, kb, mat_len);
                    mat_len += kbw;
                    std.mem.writeInt(u32, kb[kcount_pos..][0..4], kbw / 2, .little);
                }
                // Write value
                docMaterializeValue(p, curr + 1);
                // Advance past key + value
                const val_w = p.tape.get(curr + 1);
                curr = switch (val_w.tag) {
                    .array_opening, .object_opening => val_w.data.ptr,
                    .unsigned, .signed, .double => curr + 3,
                    else => curr + 2,
                };
            }
        },
        else => matWriteByte(0), // unknown → null
    }
}

/// Materialize a document value to a flat binary buffer.
/// Returns 0 on success, -1 on error.
/// Read result via doc_materialize_ptr/len. Free with doc_materialize_free.
export fn doc_materialize(doc_id: i32, index: u32) i32 {
    const p = getDocParser(doc_id) orelse return -1;
    mat_len = 0;
    mat_error = false;
    docMaterializeValue(p, index);
    if (mat_error) return -1;
    return 0;
}

/// Get pointer to materialization result buffer.
export fn doc_materialize_ptr() u32 {
    return if (mat_buffer) |buf| @intFromPtr(buf) else 0;
}

/// Get length of materialization result.
export fn doc_materialize_len() u32 {
    return mat_len;
}

/// Mark the materialization buffer as available for reuse.
/// Buffer and arena capacity are retained — next materialize reuses them.
export fn doc_materialize_free() void {
    mat_len = 0;
}

// --- General UTF-8 → UTF-16LE conversion export ---
//
// Used by JS to convert ANY UTF-8 string in linear memory to UTF-16LE,
// replacing TextDecoder entirely. The buffer grows dynamically and is
// retained between calls (typical JSON strings are small, so the first
// allocation serves most subsequent calls without re-allocating).

var str_utf16_buf: ?[*]u8 = null;
var str_utf16_cap: u32 = 0;
var str_utf16_char_count: u32 = 0;

// Fixed-address cache: JS reads this directly via DataView instead of
// calling get_utf16_ptr(). Updated after every conversion.
var str_utf16_ptr_cache: u32 = 0;

fn getUtf16Buf(needed: u32) ?[*]u8 {
    if (needed <= str_utf16_cap) return str_utf16_buf;
    // Free old buffer and allocate larger one
    if (str_utf16_buf) |buf| {
        gpa.free(buf[0..str_utf16_cap]);
    }
    var new_cap = if (str_utf16_cap == 0) @as(u32, 1024) else str_utf16_cap;
    while (new_cap < needed) new_cap *|= 2;
    const new_buf = gpa.alloc(u8, new_cap) catch return null;
    str_utf16_buf = new_buf.ptr;
    str_utf16_cap = @intCast(new_buf.len);
    // Update fixed-address cache so JS can read the pointer directly
    str_utf16_ptr_cache = @intFromPtr(new_buf.ptr);
    return new_buf.ptr;
}

/// Convert UTF-8 bytes at (ptr, len) to UTF-16LE in a shared buffer.
/// Returns the number of u16 code units. Read result via get_utf16_ptr().
/// This is the Zig-side replacement for JS TextDecoder — one WASM call,
/// then JS reads Uint16Array + String.fromCharCode.
export fn utf8_to_utf16(ptr: [*]const u8, len: u32) u32 {
    if (len == 0) {
        str_utf16_char_count = 0;
        return 0;
    }
    const src = ptr[0..len];
    // Upper bound: each UTF-8 byte → at most 1 UTF-16 code unit
    const buf = getUtf16Buf(len * 2) orelse return 0;
    const bytes_written = utf8ToUtf16Le(src, buf, 0);
    const char_count = bytes_written / 2;
    str_utf16_char_count = char_count;
    return char_count;
}

/// Get pointer to the UTF-16 conversion result buffer.
export fn get_utf16_ptr() u32 {
    return if (str_utf16_buf) |buf| @intFromPtr(buf) else 0;
}

/// Return the fixed address of str_utf16_ptr_cache.
/// JS calls this ONCE at init, then reads the pointer directly from
/// memory via DataView — zero WASM calls to get the buffer location.
export fn get_utf16_ptr_addr() u32 {
    return @intFromPtr(&str_utf16_ptr_cache);
}

/// Read a doc string at tape index and convert to UTF-16LE — ONE WASM call.
/// Replaces the 4-call sequence: doc_get_string_len + doc_get_string_ptr +
/// utf8_to_utf16 + get_utf16_ptr.
/// Returns char_count (number of u16 code units). Read result via get_utf16_ptr().
export fn doc_read_string_utf16(doc_id: i32, index: u32) u32 {
    const p = getDocParser(doc_id) orelse return 0;
    const str = readTapeString(p, index);
    if (str.len == 0) return 0;
    // Upper bound: each UTF-8 byte → at most 1 UTF-16 code unit
    const buf = getUtf16Buf(@intCast(str.len * 2)) orelse return 0;
    const bytes_written = utf8ToUtf16Le(str, buf, 0);
    const char_count = bytes_written / 2;
    str_utf16_char_count = char_count;
    return char_count;
}

fn mapError(err: anytype) i32 {
    return switch (err) {
        error.ExceededDepth => 1,
        error.ExceededCapacity => 2,
        error.InvalidEscape => 3,
        error.InvalidUnicodeCodePoint => 4,
        error.InvalidNumberLiteral => 5,
        error.ExpectedColon => 6,
        error.ExpectedKey => 7,
        error.ExpectedArrayCommaOrEnd => 8,
        error.ExpectedObjectCommaOrEnd => 9,
        error.IncompleteArray => 10,
        error.IncompleteObject => 11,
        error.TrailingContent => 12,
        error.OutOfMemory => 13,
        else => 99,
    };
}
