///! VectorJSON WASM Engine
///!
///! Thin WASM export layer wrapping zimdjson's DOM parser.
///! Parses JSON bytes into zimdjson's internal tape format, then exposes
///! a token-by-token iterator for the WAT WasmGC shim to consume.
const std = @import("std");
const zimdjson = @import("zimdjson");

// --- Allocator ---
// WASM linear memory allocator for receiving bytes from JS/WAT shim
const gpa: std.mem.Allocator = .{ .ptr = undefined, .vtable = &std.heap.WasmAllocator.vtable };

// --- Parser state ---
const DomParser = zimdjson.dom.FullParser(.default);

var parser: DomParser = DomParser.init;
var current_document: ?DomParser.Document = null;
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

    const document = parser.parseFromSlice(gpa, ptr[0..len]) catch |err| {
        last_error_code = mapError(err);
        current_document = null;
        return 1;
    };

    current_document = document;

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

/// Free a document slot, releasing its internal buffers.
/// The slot is reset to a fresh state and can be reused.
export fn doc_free(doc_id: i32) void {
    if (doc_id < 0 or doc_id >= MAX_DOC_SLOTS) return;
    const uid: usize = @intCast(doc_id);
    doc_parsers[uid].deinit(gpa);
    doc_parsers[uid] = DomParser.init;
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
        if (key_str.len == key_len and std.mem.eql(u8, key_str, key_ptr[0..key_len])) {
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
