///! VectorJSON WASM Engine
///!
///! Thin WASM export layer wrapping zimdjson's DOM parser.
///! Provides document-slot based tape navigation for lazy JS proxy access.
const std = @import("std");
const zimdjson = @import("zimdjson");
const simd = @import("simd.zig");

// --- Allocator ---
const gpa: std.mem.Allocator = .{ .ptr = undefined, .vtable = &std.heap.WasmAllocator.vtable };

// --- Parser state ---
const DomParser = zimdjson.dom.FullParser(.default);
const DomParserJson5 = zimdjson.dom.FullParser(.{ .json5 = true });

var last_error_code: i32 = 0;

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

/// Get the last error code (0 = no error).
export fn get_error_code() i32 {
    return last_error_code;
}

// ============================================================
// Streaming Parser — incremental feed, O(n) total
// ============================================================
//
// Each stream accumulates bytes and scans structure incrementally.
// Only NEW bytes are scanned per feed() call. SIMD fast-skip for strings.
// When complete, JS can doc_parse the accumulated buffer.

const stream = @import("stream.zig");
const FeedStatus = stream.FeedStatus;

/// Global stream state slots (support multiple concurrent streams)
var streams: [4]?*stream.StreamState = .{ null, null, null, null };

fn getStream(id: i32) ?*stream.StreamState {
    if (id < 0 or id >= streams.len) return null;
    return streams[@intCast(id)];
}

export fn stream_create(format: i32) i32 {
    const fmt: stream.Format = if (format >= 0 and format <= 2)
        @enumFromInt(format)
    else
        .json;
    for (&streams, 0..) |*slot, i| {
        if (slot.* == null) {
            slot.* = stream.StreamState.init(gpa, fmt) catch return -1;
            return @intCast(i);
        }
    }
    return -1;
}

export fn stream_destroy(id: i32) void {
    const s = getStream(id) orelse return;
    s.deinit();
    streams[@intCast(id)] = null;
}

export fn stream_feed(id: i32, ptr: [*]const u8, len: u32) i32 {
    const s = getStream(id) orelse return 2;
    return @intFromEnum(s.feed(ptr, len));
}

export fn stream_get_status(id: i32) i32 {
    const s = getStream(id) orelse return 2;
    return @intFromEnum(s.status);
}

export fn stream_get_buffer_ptr(id: i32) u32 {
    const s = getStream(id) orelse return 0;
    return @intFromPtr(s.getBufferPtr());
}

export fn stream_get_value_len(id: i32) u32 {
    const s = getStream(id) orelse return 0;
    return s.getValueLen();
}

export fn stream_get_remaining_ptr(id: i32) u32 {
    const s = getStream(id) orelse return 0;
    return @intFromPtr(s.getRemaining().ptr);
}

export fn stream_get_remaining_len(id: i32) u32 {
    const s = getStream(id) orelse return 0;
    return s.getRemaining().len;
}

export fn stream_get_buffer_len(id: i32) u32 {
    const s = getStream(id) orelse return 0;
    return s.buffer_len;
}

export fn stream_get_buffer_cap(id: i32) u32 {
    const s = getStream(id) orelse return 0;
    return s.buffer_cap;
}

export fn stream_reset_for_next(id: i32) u32 {
    const s = getStream(id) orelse return 0;
    return s.resetForNext();
}

// ============================================================
// Document Slot System — "True Lazy" tape-direct navigation
// ============================================================
//
// Instead of building a WasmGC tree upfront, we parse into a tape and
// return a document handle (i32 slot ID). JS navigates the tape on
// demand via doc_get_tag, doc_find_field, doc_array_elements, etc.
//
// Each slot owns a separate DomParser instance so multiple documents
// can coexist. When a slot is freed, the parser's internal buffers are
// retained for reuse by the next parse in that slot.

const MAX_DOC_SLOTS = 128;
var doc_parsers: [MAX_DOC_SLOTS]DomParser = .{DomParser.init} ** MAX_DOC_SLOTS;
var doc_active: [MAX_DOC_SLOTS]bool = .{false} ** MAX_DOC_SLOTS;
var doc_is_json5: [MAX_DOC_SLOTS]bool = .{false} ** MAX_DOC_SLOTS;

// --- Source position tracking ---
// Per-slot arrays mapping tape index → byte offset in the parsed input.
// Built lazily on first doc_get_src_pos call by correlating tape words with token indices.
// Used by JS isComplete() to check if a value was autocompleted.
const DocSrcPos = struct { positions: ?[*]u32 = null, cap: u32 = 0, len: u32 = 0, built: bool = false };
var doc_src: [MAX_DOC_SLOTS]DocSrcPos = .{DocSrcPos{}} ** MAX_DOC_SLOTS;

/// Build source position array for a document slot by walking tape + tokens in parallel.
/// Token indices contain byte offsets of ALL structural characters ({, }, [, ], :, ", etc.).
/// Tape words correspond to value-producing tokens. We skip `:` and `,` tokens that don't
/// produce tape entries.
fn buildDocSrcPositions(uid: usize) void {
    const p = &doc_parsers[uid];
    const sp = &doc_src[uid];

    // Compute tape length from root word (non-streaming mode uses pointer arithmetic,
    // so words.items().len is 0; the root word stores the closing root index).
    const root_raw: u64 = p.tape.words.items().ptr[0];
    const closing_root_idx: u32 = @truncate(root_raw >> 8);
    const tape_count: u32 = closing_root_idx + 1;

    // Reuse existing allocation if large enough, else grow
    if (sp.cap < tape_count) {
        if (sp.positions) |old_ptr| {
            gpa.free(old_ptr[0..sp.cap]);
        }
        const positions = gpa.alloc(u32, tape_count) catch {
            sp.* = .{};
            return;
        };
        sp.positions = positions.ptr;
        sp.cap = tape_count;
    }

    const positions = sp.positions orelse return;
    sp.len = tape_count;

    // Access token indices and input document
    const tok_items = p.tape.tokens.indexes.items;
    const input_doc = p.tape.tokens.document;
    const input_len: u32 = @intCast(input_doc.len);

    // Root opening word — position 0
    positions[0] = 0;

    var tok: u32 = 0;
    var ti: u32 = 1;

    while (ti < tape_count - 1) {
        // Skip comma and colon tokens (they don't produce tape entries)
        while (tok < tok_items.len) {
            const pos = tok_items[tok];
            if (pos < input_len) {
                const ch = input_doc[pos];
                if (ch != ':' and ch != ',') break;
            } else break;
            tok += 1;
        }

        if (tok < tok_items.len) {
            positions[ti] = tok_items[tok];
            tok += 1;
        } else {
            positions[ti] = input_len;
        }

        const word = p.tape.get(ti);
        ti += 1;

        // Number types have a data word following the tag — share the same position
        if (word.tag == .unsigned or word.tag == .signed or word.tag == .double) {
            if (ti < tape_count) {
                positions[ti] = positions[ti - 1];
                ti += 1;
            }
        }
    }

    // Root closing word
    if (ti < tape_count) {
        positions[ti] = input_len;
    }
}

fn getDocParser(doc_id: i32) ?*DomParser {
    if (doc_id < 0 or doc_id >= MAX_DOC_SLOTS) return null;
    const uid: usize = @intCast(doc_id);
    if (!doc_active[uid]) return null;
    if (doc_is_json5[uid]) {
        // DomParser and DomParserJson5 have identical memory layout —
        // same fields (document_buffer, tape, max_capacity) at same offsets.
        // The only difference is comptime dispatch in buildFromSlice (already done).
        // Safe to reinterpret the pointer for tape navigation.
        return @ptrCast(&doc_parsers_json5[uid]);
    }
    return &doc_parsers[uid];
}

/// Parse JSON bytes and store the result in a document slot.
/// Returns slot ID (0..127) on success, or -1 on error.
/// The error code is available via get_error_code().
export fn doc_parse(ptr: [*]const u8, len: u32) i32 {
    last_error_code = 0;

    // Find a free slot (for/else returns first free index or early-returns -1)
    const uid: usize = for (doc_active, 0..) |active, i| {
        if (!active) break i;
    } else {
        last_error_code = 2; // ExceededCapacity
        return -1;
    };

    _ = doc_parsers[uid].parseFromSlice(gpa, ptr[0..len]) catch |err| {
        last_error_code = mapError(err);
        return -1;
    };

    doc_active[uid] = true;
    doc_is_json5[uid] = false;
    doc_src[uid].built = false; // mark for lazy build on first src_pos query

    return @intCast(uid);
}

// --- JSON5 document slots (separate array for json5 comptime parser) ---
var doc_parsers_json5: [MAX_DOC_SLOTS]DomParserJson5 = .{DomParserJson5.init} ** MAX_DOC_SLOTS;

/// Preprocess JSON5 input to valid JSON.
/// 1. Strip // and /* */ comments
/// 2. Remove trailing commas (,} → ' }', ,] → ' ]')
/// 3. Convert single-quoted strings to double-quoted (escape inner ", unescape inner ')
/// 4. Wrap unquoted keys in double quotes
/// 5. Convert hex 0xFF → decimal
/// 6. Convert NaN → null (Infinity/+Infinity/-Infinity handled by DomParserJson5)
///
/// Uses an intermediate output buffer, then copies back. Returns new length.
export fn preprocess_json5(ptr: [*]u8, len: u32) u32 {
    if (len == 0) return 0;

    // Allocate output buffer (worst case: unquoted keys need wrapping → ~2x)
    const out_cap = len * 2 + 64;
    const out_buf = gpa.alloc(u8, out_cap) catch return 0;
    defer gpa.free(out_buf);

    var i: u32 = 0;
    var o: u32 = 0;
    var in_string: bool = false;
    var quote_char: u8 = '"';
    var escape_next: bool = false;
    var expecting_key: bool = false;
    var depth: i32 = 0;
    var last_non_ws: u8 = 0;
    var last_comma_out_pos: u32 = 0; // track last comma position in output — avoids O(n²) backward scan
    var context_stack: [256]u8 = undefined; // '{' or '['
    var stack_depth: u32 = 0;

    while (i < len) {
        const c = ptr[i];

        if (escape_next) {
            escape_next = false;
            if (in_string and quote_char == '\'') {
                // In single-quoted string: unescape \' → ', escape " → \"
                if (c == '\'') {
                    out_buf[o] = '\'';
                    o += 1;
                } else if (c == '"') {
                    out_buf[o] = '\\';
                    o += 1;
                    out_buf[o] = '"';
                    o += 1;
                } else {
                    out_buf[o] = '\\';
                    o += 1;
                    out_buf[o] = c;
                    o += 1;
                }
            } else {
                out_buf[o] = '\\';
                o += 1;
                out_buf[o] = c;
                o += 1;
            }
            i += 1;
            continue;
        }

        if (in_string) {
            if (c == '\\') {
                escape_next = true;
                i += 1;
                continue;
            }
            if (c == quote_char) {
                in_string = false;
                out_buf[o] = '"'; // Always close with double quote
                o += 1;
                last_non_ws = '"';
                i += 1;
                continue;
            }
            // Inside single-quoted string: escape any literal " chars
            if (quote_char == '\'' and c == '"') {
                out_buf[o] = '\\';
                o += 1;
                out_buf[o] = '"';
                o += 1;
            } else {
                out_buf[o] = c;
                o += 1;
            }
            i += 1;
            continue;
        }

        // Not in string — handle comments
        if (c == '/' and i + 1 < len) {
            if (ptr[i + 1] == '/') {
                // Line comment — skip to end of line
                i += 2;
                while (i < len and ptr[i] != '\n' and ptr[i] != '\r') i += 1;
                continue;
            }
            if (ptr[i + 1] == '*') {
                // Block comment — skip to */
                i += 2;
                while (i + 1 < len) {
                    if (ptr[i] == '*' and ptr[i + 1] == '/') {
                        i += 2;
                        break;
                    }
                    i += 1;
                } else {
                    i = len; // unterminated block comment
                }
                continue;
            }
        }

        // Handle trailing commas: if last non-ws was ',' and current is '}' or ']'
        if (c == '}' or c == ']') {
            if (last_non_ws == ',') {
                // O(1) — replace tracked comma position instead of backward scan
                out_buf[last_comma_out_pos] = ' ';
            }
            depth -= 1;
            if (stack_depth > 0) stack_depth -= 1;
            out_buf[o] = c;
            o += 1;
            last_non_ws = c;
            expecting_key = if (stack_depth > 0) context_stack[stack_depth - 1] == '{' else false;
            i += 1;
            continue;
        }

        if (c == '{') {
            if (stack_depth < context_stack.len) {
                context_stack[stack_depth] = '{';
                stack_depth += 1;
            }
            depth += 1;
            expecting_key = true;
            out_buf[o] = c;
            o += 1;
            last_non_ws = c;
            i += 1;
            continue;
        }

        if (c == '[') {
            if (stack_depth < context_stack.len) {
                context_stack[stack_depth] = '[';
                stack_depth += 1;
            }
            depth += 1;
            expecting_key = false;
            out_buf[o] = c;
            o += 1;
            last_non_ws = c;
            i += 1;
            continue;
        }

        if (c == ',') {
            expecting_key = if (stack_depth > 0) context_stack[stack_depth - 1] == '{' else false;
            last_comma_out_pos = o;
            out_buf[o] = c;
            o += 1;
            last_non_ws = c;
            i += 1;
            continue;
        }

        if (c == ':') {
            expecting_key = false;
            out_buf[o] = c;
            o += 1;
            last_non_ws = c;
            i += 1;
            continue;
        }

        if (c == '"') {
            in_string = true;
            quote_char = '"';
            expecting_key = false;
            out_buf[o] = '"';
            o += 1;
            last_non_ws = '"';
            i += 1;
            continue;
        }

        if (c == '\'') {
            in_string = true;
            quote_char = '\'';
            expecting_key = false;
            out_buf[o] = '"'; // Open with double quote
            o += 1;
            last_non_ws = '"';
            i += 1;
            continue;
        }

        // Whitespace
        if (c == ' ' or c == '\t' or c == '\n' or c == '\r') {
            out_buf[o] = c;
            o += 1;
            i += 1;
            continue;
        }

        // Hex number: 0x... or 0X...
        if (c == '0' and i + 1 < len and (ptr[i + 1] == 'x' or ptr[i + 1] == 'X')) {
            i += 2;
            var hex_val: u64 = 0;
            while (i < len) {
                const h = ptr[i];
                if (h >= '0' and h <= '9') {
                    hex_val = hex_val * 16 + (h - '0');
                } else if (h >= 'a' and h <= 'f') {
                    hex_val = hex_val * 16 + (h - 'a' + 10);
                } else if (h >= 'A' and h <= 'F') {
                    hex_val = hex_val * 16 + (h - 'A' + 10);
                } else break;
                i += 1;
            }
            // Write decimal number
            var num_buf: [20]u8 = undefined;
            const num_str = std.fmt.bufPrint(&num_buf, "{d}", .{hex_val}) catch "0";
            for (num_str) |ch| {
                out_buf[o] = ch;
                o += 1;
            }
            if (num_str.len > 0) last_non_ws = num_str[num_str.len - 1];
            expecting_key = false;
            continue;
        }

        // NaN → null
        if (c == 'N' and i + 2 < len and ptr[i + 1] == 'a' and ptr[i + 2] == 'N') {
            out_buf[o] = 'n';
            o += 1;
            out_buf[o] = 'u';
            o += 1;
            out_buf[o] = 'l';
            o += 1;
            out_buf[o] = 'l';
            o += 1;
            last_non_ws = 'l';
            i += 3;
            expecting_key = false;
            continue;
        }

        // Unquoted key: identifier chars before ':'
        if (expecting_key and isIdentStart(c)) {
            out_buf[o] = '"';
            o += 1;
            out_buf[o] = c;
            o += 1;
            i += 1;
            while (i < len and isIdentPart(ptr[i])) {
                out_buf[o] = ptr[i];
                o += 1;
                i += 1;
            }
            out_buf[o] = '"';
            o += 1;
            last_non_ws = '"';
            expecting_key = false;
            continue;
        }

        // Default: copy byte through
        if (c == ',') last_comma_out_pos = o;
        out_buf[o] = c;
        o += 1;
        last_non_ws = c;
        expecting_key = false;
        i += 1;
    }

    // Copy output back to input buffer
    @memcpy(ptr[0..o], out_buf[0..o]);
    return o;
}

fn isIdentStart(c: u8) bool {
    return (c >= 'a' and c <= 'z') or (c >= 'A' and c <= 'Z') or c == '_' or c == '$';
}

fn isIdentPart(c: u8) bool {
    return isIdentStart(c) or (c >= '0' and c <= '9');
}

/// Parse JSON with format awareness.
/// format: 0=json, 1=jsonl, 2=json5
/// For json5: runs preprocess_json5 first, then uses DomParserJson5.
export fn doc_parse_fmt(ptr: [*]u8, len: u32, format: i32) i32 {
    if (format != 2) return doc_parse(ptr, len);

    // JSON5 mode: preprocess, then parse with json5-aware parser
    const new_len = preprocess_json5(ptr, len);
    if (new_len == 0 and len > 0) {
        last_error_code = 99;
        return -1;
    }

    last_error_code = 0;

    const uid: usize = for (doc_active, 0..) |active, i| {
        if (!active) break i;
    } else {
        last_error_code = 2;
        return -1;
    };

    // Pad for SIMD safety
    if (new_len + 64 <= len * 2 + 64) {
        @memset(ptr[new_len..][0..64], ' ');
    }

    _ = doc_parsers_json5[uid].parseFromSlice(gpa, ptr[0..new_len]) catch |err| {
        last_error_code = mapError(err);
        return -1;
    };

    doc_active[uid] = true;
    doc_is_json5[uid] = true;
    doc_src[uid].built = false;

    return @intCast(uid);
}

/// Free a document slot, marking it available for reuse.
/// Parser buffers are retained — parseFromSlice reuses them automatically:
///   string_buffer.reset() clears data, retains capacity
///   ensureTotalCapacityForSlice only grows, never shrinks
/// Source position buffer is retained for reuse (freed when capacity needs to grow).
export fn doc_free(doc_id: i32) void {
    if (doc_id < 0 or doc_id >= MAX_DOC_SLOTS) return;
    const uid: usize = @intCast(doc_id);
    doc_active[uid] = false;
    // Note: src_positions buffer is retained (reused on next parse in this slot)
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

/// Read a doc string's source offset, raw length, and escape flag — ONE WASM call.
/// Writes source_offset to batch_buffer[0], raw_len to batch_buffer[1],
/// has_escapes (0 or 1) to batch_buffer[2].
/// Returns raw_len (0 = empty string). JS reads raw bytes from input at offset.
export fn doc_read_string_raw(doc_id: i32, index: u32) u32 {
    const p = getDocParser(doc_id) orelse return 0;
    const word = p.tape.get(index);
    const raw_len_with_flag: u24 = word.data.len;
    const raw_len: u32 = raw_len_with_flag & 0x7FFFFF;
    const has_escapes: u32 = if ((raw_len_with_flag & (1 << 23)) != 0) 1 else 0;
    batch_buffer[0] = word.data.ptr; // source byte offset after opening quote
    batch_buffer[1] = raw_len; // raw byte count between quotes
    batch_buffer[2] = has_escapes; // 1 if string contains backslash escapes
    return raw_len;
}

/// Get the base address of the input document for a doc slot.
/// JS uses this + source offset to read string bytes from WASM memory.
export fn doc_get_input_ptr(doc_id: i32) u32 {
    const p = getDocParser(doc_id) orelse return 0;
    return @intCast(p.tape.input_base_addr);
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

/// Get the source byte offset of a tape entry in the parsed input.
/// Lazily builds the src_positions array on first call (only needed for incomplete parses).
/// Returns 0xFFFFFFFF if the doc or index is invalid.
export fn doc_get_src_pos(doc_id: i32, idx: u32) u32 {
    _ = getDocParser(doc_id) orelse return 0xFFFFFFFF;
    const uid: usize = @intCast(doc_id);
    const sp = &doc_src[uid];
    if (!sp.built) {
        buildDocSrcPositions(uid);
        sp.built = true;
    }
    if (idx >= sp.len) return 0xFFFFFFFF;
    return (sp.positions orelse return 0xFFFFFFFF)[idx];
}

/// Get the tape index of a container's closing bracket.
/// For object_opening → returns tape index of object_closing.
/// For array_opening → returns tape index of array_closing.
/// Returns 0 for non-container tags.
export fn doc_get_close_index(doc_id: i32, index: u32) u32 {
    const p = getDocParser(doc_id) orelse return 0;
    const word = p.tape.get(index);
    return switch (word.tag) {
        .object_opening, .array_opening => word.data.ptr,
        else => 0,
    };
}

/// Advance past one tape value, returning the index of the next entry.
/// Containers jump to their closing bracket's successor; numbers skip their data word.
inline fn nextTapeEntry(tape: anytype, val_idx: u32) u32 {
    const w = tape.get(val_idx);
    return switch (w.tag) {
        .array_opening, .object_opening => w.data.ptr,
        .unsigned, .signed, .double => val_idx + 2,
        else => val_idx + 1,
    };
}

/// Find a field in an object by key. Returns the tape index of the VALUE,
/// or 0 if not found (0 is the root word, never a valid value position).
/// Compares raw source bytes against the key. For keys with escape sequences
/// (e.g. \n, \uXXXX), raw comparison may fail — JS falls back to ownKeys iteration.
export fn doc_find_field(doc_id: i32, obj_index: u32, key_ptr: [*]const u8, key_len: u32) u32 {
    const p = getDocParser(doc_id) orelse return 0;
    const word = p.tape.get(obj_index);
    if (word.tag != .object_opening) return 0;

    var curr: u32 = obj_index + 1; // first key position
    while (true) {
        const w = p.tape.get(curr);
        if (w.tag == .object_closing) return 0; // not found

        // Compare raw source bytes against the search key
        const src_ptr: [*]const u8 = @ptrFromInt(p.tape.input_base_addr + w.data.ptr);
        const raw_len = w.data.len;
        if (raw_len == key_len and simd.eql(src_ptr, key_ptr, key_len)) {
            return curr + 1; // value is immediately after the key
        }

        // Skip to next key: advance past key + value
        curr = nextTapeEntry(p.tape, curr + 1);
    }
}

// --- Batch iteration exports ---
// These walk a container ONCE and return all child tape indices,
// turning O(N²) sequential access into O(N).

/// Static batch buffer: 16384 u32 indices + 1 continuation token.
/// When a container has more than 16384 elements, batch_buffer[count] holds
/// the tape index to resume from on the next call.
var batch_buffer: [16385]u32 = undefined;

/// Get a pointer to the batch buffer (for JS to read results).
export fn doc_batch_ptr() [*]u32 {
    return &batch_buffer;
}

/// Walk an array, writing element tape indices into batch_buffer.
/// Returns the number of elements written (capped at 16384).
/// `resume_at`: tape index to resume from (0 = start from beginning).
/// When buffer is full and more elements remain, batch_buffer[16384] holds
/// the next tape index for resumption.
export fn doc_array_elements(doc_id: i32, arr_index: u32, resume_at: u32) u32 {
    const p = getDocParser(doc_id) orelse return 0;
    const word = p.tape.get(arr_index);
    if (word.tag != .array_opening) return 0;

    var curr: u32 = if (resume_at != 0) resume_at else arr_index + 1;
    var count: u32 = 0;
    while (count < 16384) {
        const w = p.tape.get(curr);
        if (w.tag == .array_closing) break;
        batch_buffer[count] = curr;
        count += 1;
        curr = nextTapeEntry(p.tape, curr);
    }
    // Write continuation token if there are more elements
    if (count == 16384) {
        batch_buffer[16384] = curr;
    }
    return count;
}

/// Walk an object, writing key tape indices into batch_buffer.
/// Value index = key_index + 1.
/// Returns the number of entries written (capped at 16384).
/// `resume_at`: tape index to resume from (0 = start from beginning).
/// When buffer is full and more elements remain, batch_buffer[16384] holds
/// the next tape index for resumption.
export fn doc_object_keys(doc_id: i32, obj_index: u32, resume_at: u32) u32 {
    const p = getDocParser(doc_id) orelse return 0;
    const word = p.tape.get(obj_index);
    if (word.tag != .object_opening) return 0;

    var curr: u32 = if (resume_at != 0) resume_at else obj_index + 1;
    var count: u32 = 0;
    while (count < 16384) {
        const w = p.tape.get(curr);
        if (w.tag == .object_closing) break;
        batch_buffer[count] = curr; // key index
        count += 1;
        curr = nextTapeEntry(p.tape, curr + 1);
    }
    // Write continuation token if there are more elements
    if (count == 16384) {
        batch_buffer[16384] = curr;
    }
    return count;
}

// ============================================================
// Input Classification & Autocomplete — for status-based parse API
// ============================================================
//
// classify_input: lightweight structural scan that determines whether
// the JSON input is complete, incomplete, complete_early, or invalid.
//
// autocomplete_input: appends closing suffix to incomplete JSON so
// doc_parse can handle it. Writes directly into WASM buffer after input.

/// Stored value_end offset for complete_early case.
var classify_value_end: u32 = 0;

/// Classify JSON input without parsing.
/// Returns FeedStatus: incomplete, complete, end_early, or err.
export fn classify_input(ptr: [*]const u8, len: u32) FeedStatus {
    classify_value_end = 0;

    if (len == 0) return .incomplete;

    var depth_val: i32 = 0;
    var in_string: bool = false;
    var escape_next: bool = false;
    var root_state: enum { none, string, scalar, completed } = .none;
    var scalar_start: u32 = 0;

    var i: u32 = 0;
    while (i < len) {
        const c = ptr[i];

        if (escape_next) {
            escape_next = false;
            i += 1;
            continue;
        }

        if (in_string) {
            if (c == '\\') {
                escape_next = true;
            } else if (c == '"') {
                in_string = false;
                if (depth_val == 0 and root_state == .string) {
                    root_state = .completed;
                    classify_value_end = i + 1;
                }
            }
            i += 1;
            continue;
        }

        // Any non-scalar-body char at depth 0 terminates a pending scalar
        // Scalar body: digits, signs, decimal, exponent, plus keyword letters (true/false/null)
        if (depth_val == 0 and root_state == .scalar) {
            switch (c) {
                'a'...'z', '0'...'9', '-', '.', '+', 'E' => {},
                else => { root_state = .completed; classify_value_end = i; },
            }
        }

        switch (c) {
            '"' => {
                if (depth_val == 0 and root_state == .none) {
                    root_state = .string;
                }
                in_string = true;
            },
            '{', '[' => {
                depth_val += 1;
            },
            '}', ']' => {
                depth_val -= 1;
                if (depth_val < 0) return .err; // unmatched closing bracket
                if (depth_val == 0 and root_state != .completed) {
                    root_state = .completed;
                    classify_value_end = i + 1;
                }
            },
            't', 'f', 'n', '-', '0'...'9' => {
                if (depth_val == 0 and root_state == .none) {
                    root_state = .scalar;
                    scalar_start = i;
                }
            },
            else => {},
        }
        i += 1;
    }

    // Handle pending scalar at EOF (e.g. "42" with no trailing whitespace)
    // Must validate that the scalar is actually complete — partial keywords
    // like "tr", "fal", "nul" should be treated as incomplete, not complete.
    if (root_state == .scalar and depth_val == 0 and !in_string) {
        const scalar = ptr[scalar_start..len];
        // Partial keyword prefix → incomplete (e.g. "tr", "fal", "nul")
        for ([_][]const u8{ "true", "false", "null" }) |kw| {
            if (scalar.len < kw.len and std.mem.eql(u8, scalar, kw[0..scalar.len])) return .incomplete;
        }
        // Trailing incomplete number char → incomplete (e.g. "1.", "1e", "1e-")
        if (scalar.len > 0) {
            const last_ch = scalar[scalar.len - 1];
            if (last_ch == '.' or last_ch == '-' or last_ch == '+' or last_ch == 'e' or last_ch == 'E') {
                return .incomplete;
            }
        }
        root_state = .completed;
        classify_value_end = len;
    }

    if (root_state != .completed) {
        // Nothing started, still mid-string, or depth > 0 → incomplete
        return .incomplete;
    }

    // Root value is complete. Check for trailing content.
    var j = classify_value_end;
    while (j < len) : (j += 1) {
        const c = ptr[j];
        if (c != ' ' and c != '\t' and c != '\n' and c != '\r') {
            // Non-whitespace after complete value → end_early
            return .end_early;
        }
    }

    return .complete;
}

/// Get the stored value_end offset (for end_early classification).
export fn get_value_end() u32 {
    return classify_value_end;
}

/// Autocomplete incomplete JSON5 input — extends autocomplete_input with JSON5 awareness.
/// Handles single-quoted strings, skips comments, and doesn't add filler after trailing commas.
export fn autocomplete_input_json5(ptr: [*]u8, len: u32, buf_cap: u32) u32 {
    if (len == 0) return 0;

    const max_suffix = if (buf_cap > len) buf_cap - len else @as(u32, 0);
    if (max_suffix == 0) return len;

    var container_stack: [256]u8 = undefined;
    var stack_depth: u32 = 0;
    var in_string: bool = false;
    var escape_next: bool = false;
    var quote_char: u8 = '"';
    var pending: enum { none, colon, comma_obj, comma_arr } = .none;

    var i: u32 = 0;
    while (i < len) {
        const c = ptr[i];

        if (escape_next) {
            escape_next = false;
            i += 1;
            continue;
        }

        if (in_string) {
            if (c == '\\') {
                escape_next = true;
            } else if (c == quote_char) {
                in_string = false;
            }
            i += 1;
            continue;
        }

        // Skip comments
        if (c == '/' and i + 1 < len) {
            if (ptr[i + 1] == '/') {
                i += 2;
                while (i < len and ptr[i] != '\n' and ptr[i] != '\r') i += 1;
                continue;
            }
            if (ptr[i + 1] == '*') {
                i += 2;
                while (i + 1 < len) {
                    if (ptr[i] == '*' and ptr[i + 1] == '/') {
                        i += 2;
                        break;
                    }
                    i += 1;
                } else {
                    i = len;
                }
                continue;
            }
        }

        if (c != ' ' and c != '\t' and c != '\n' and c != '\r') pending = .none;
        switch (c) {
            ':' => pending = .colon,
            ',' => {
                // In JSON5 mode, trailing commas are valid — don't generate filler
                // Just track for container closing
                pending = .none;
            },
            '"' => {
                in_string = true;
                quote_char = '"';
            },
            '\'' => {
                in_string = true;
                quote_char = '\'';
            },
            '{', '[' => {
                if (stack_depth < container_stack.len) {
                    container_stack[stack_depth] = c;
                    stack_depth += 1;
                }
            },
            '}', ']' => {
                if (stack_depth > 0) stack_depth -= 1;
            },
            else => {},
        }
        i += 1;
    }

    var write_pos: u32 = len;
    const Writer = struct {
        buf: [*]u8,
        pos: *u32,
        cap: u32,
        fn append(self: @This(), s: []const u8) void {
            for (s) |ch| {
                if (self.pos.* < self.cap) {
                    self.buf[self.pos.*] = ch;
                    self.pos.* += 1;
                }
            }
        }
    };
    const w = Writer{ .buf = ptr, .pos = &write_pos, .cap = buf_cap };

    if (in_string or escape_next) {
        if (escape_next) {
            w.append("n");
        }
        // Close with the matching quote converted to double quote for JSON compat
        w.append("\"");
    } else if (pending == .colon) {
        w.append("null");
    }

    while (stack_depth > 0) {
        stack_depth -= 1;
        w.append(if (container_stack[stack_depth] == '{') "}" else "]");
    }

    return write_pos;
}

/// Autocomplete incomplete JSON input by appending closing tokens.
/// Writes suffix directly after input[len] in the WASM buffer.
/// Returns new length (len + suffix_len). Caller must ensure buf_cap >= len + 64.
export fn autocomplete_input(ptr: [*]u8, len: u32, buf_cap: u32) u32 {
    if (len == 0) return 0;

    const max_suffix = if (buf_cap > len) buf_cap - len else @as(u32, 0);
    if (max_suffix == 0) return len;

    // Scan input to determine what needs closing
    var container_stack: [256]u8 = undefined; // '{' or '['
    var stack_depth: u32 = 0;
    var in_string: bool = false;
    var escape_next: bool = false;
    var pending: enum { none, colon, comma_obj, comma_arr } = .none;

    var i: u32 = 0;
    while (i < len) {
        const c = ptr[i];

        if (escape_next) {
            escape_next = false;
            i += 1;
            continue;
        }

        if (in_string) {
            if (c == '\\') {
                escape_next = true;
            } else if (c == '"') {
                in_string = false;
                // Flags already false — cleared when '"' opened the string
            }
            i += 1;
            continue;
        }

        // Non-whitespace tokens always clear pending-value flags
        if (c != ' ' and c != '\t' and c != '\n' and c != '\r') pending = .none;
        switch (c) {
            ':' => pending = .colon,
            ',' => pending = if (stack_depth > 0 and container_stack[stack_depth - 1] == '{') .comma_obj else .comma_arr,
            '"' => in_string = true,
            '{', '[' => {
                if (stack_depth < container_stack.len) {
                    container_stack[stack_depth] = c;
                    stack_depth += 1;
                }
            },
            '}', ']' => {
                if (stack_depth > 0) stack_depth -= 1;
            },
            else => {},
        }
        i += 1;
    }

    // Now append closing suffix
    var write_pos: u32 = len;

    // Helper: append a slice to the output buffer with bounds checking
    const Writer = struct {
        buf: [*]u8,
        pos: *u32,
        cap: u32,
        fn append(self: @This(), s: []const u8) void {
            for (s) |ch| {
                if (self.pos.* < self.cap) {
                    self.buf[self.pos.*] = ch;
                    self.pos.* += 1;
                }
            }
        }
    };
    const w = Writer{ .buf = ptr, .pos = &write_pos, .cap = buf_cap };

    // ── Partial atom completion ──
    // Detect and complete partial atoms (booleans, null, numbers with trailing dot)
    // at the tail of the input. These occur when an LLM streams mid-token.
    if (!in_string and !escape_next and pending == .none) {
        // Scan backwards past the trailing atom characters to find the atom start
        var atom_end = len;
        while (atom_end > 0) {
            const ch = ptr[atom_end - 1];
            if (ch == ' ' or ch == '\t' or ch == '\n' or ch == '\r') {
                atom_end -= 1;
            } else break;
        }
        if (atom_end > 0) {
            // Find start of the trailing atom
            var atom_start = atom_end;
            while (atom_start > 0) {
                const ch = ptr[atom_start - 1];
                if ((ch >= 'a' and ch <= 'z') or (ch >= '0' and ch <= '9') or ch == '-' or ch == '.' or ch == '+' or ch == 'e' or ch == 'E') {
                    atom_start -= 1;
                } else break;
            }
            if (atom_start < atom_end) {
                const atom = ptr[atom_start..atom_end];
                // Complete partial keywords: "tr" → "ue", "fal" → "se", "nu" → "ll", etc.
                if (for ([_][]const u8{ "true", "false", "null" }) |kw| {
                    if (atom.len <= kw.len and std.mem.eql(u8, atom, kw[0..atom.len]))
                        break kw[atom.len..];
                } else @as(?[]const u8, null)) |suffix| {
                    w.append(suffix);
                } else if (atom.len > 0) {
                    // Strip trailing incomplete number chars iteratively:
                    // "1.23e-" → strip "-" → "1.23e" → strip "e" → "1.23"
                    // "1." → strip "." → "1"
                    // "-" → strip all → atom_start (no valid prefix → leaves invalid)
                    var strip_pos = atom_start + atom.len;
                    while (strip_pos > atom_start) {
                        const ch = ptr[strip_pos - 1];
                        if (ch == '.' or ch == 'e' or ch == 'E' or ch == '-' or ch == '+') {
                            strip_pos -= 1;
                        } else break;
                    }
                    if (strip_pos < atom_start + atom.len) {
                        write_pos = if (strip_pos > atom_start) strip_pos else atom_start;
                    }
                }
            }
        }
    }

    if (in_string or escape_next) {
        if (escape_next) {
            w.append("n"); // complete dangling escape as \n
        } else {
            // Check for incomplete unicode escape at end of string: \uXX or \uXXX
            // Strip it so doc_parse doesn't choke on partial hex sequences
            var strip_to = write_pos;
            if (write_pos >= 2) {
                // Scan backwards for a trailing \uXXXX sequence
                var j: u32 = write_pos;
                while (j > 0) {
                    const ch = ptr[j - 1];
                    if ((ch >= '0' and ch <= '9') or (ch >= 'a' and ch <= 'f') or (ch >= 'A' and ch <= 'F')) {
                        j -= 1;
                    } else break;
                }
                // j now points past the backslash-u prefix (if any)
                if (j >= 2 and ptr[j - 1] == 'u' and ptr[j - 2] == '\\') {
                    const hex_count = write_pos - j;
                    if (hex_count < 4) {
                        // Incomplete \uXXXX — strip the entire escape
                        strip_to = j - 2;
                    }
                }
            }
            write_pos = strip_to;
        }
        w.append("\"");
    } else if (pending == .comma_obj) {
        w.append("\"\":null");
    } else if (pending == .colon or pending == .comma_arr) {
        w.append("null");
    }

    // Close all open containers in reverse order
    while (stack_depth > 0) {
        stack_depth -= 1;
        w.append(if (container_stack[stack_depth] == '{') "}" else "]");
    }

    return write_pos;
}

// ============================================================
// Deep Comparison — iterative, SIMD-accelerated tape equality
// ============================================================
//
// Instead of recursing into every node, we walk both tapes linearly
// in lockstep. The tape layout guarantees that two identical values
// produce identical tape shapes — so we just scan forward.
//
// SIMD acceleration (two levels):
//   1. Tape words: v128 bulk compare skips 2 entries (16 bytes) at a time
//      when neither entry is a string. Numbers get tag+data validated
//      in a single v128 op (zero branch overhead).
//   2. String bytes: SIMD 16-byte memcmp via simd.eql.
//
// Result is a single i32. Zero JS objects. Zero Proxy traps.

/// Tag byte constants — ASCII values matching zimdjson's Tag enum.
const T_NULL: u8 = 'n';
const T_TRUE: u8 = 't';
const T_FALSE: u8 = 'f';
const T_UINT: u8 = 'u';
const T_INT: u8 = 'i';
const T_DBL: u8 = 'd';
const T_STR: u8 = 's';
const T_OBJ: u8 = '{';
const T_ARR: u8 = '[';
const T_OBJ_C: u8 = '}';
const T_ARR_C: u8 = ']';

/// Check if a tag byte is one of the three numeric types.
inline fn isNumTag(tag: u8) bool {
    return tag == T_UINT or tag == T_INT or tag == T_DBL;
}

/// Tape word width: number entries occupy 2 words (tag + data), everything else 1.
inline fn wordWidth(tag: u8) u32 {
    return if (isNumTag(tag)) 2 else 1;
}

/// Extract string byte-length from a raw tape word (bits [62:40], mask off escape flag).
inline fn strLen(raw: u64) u32 {
    return @as(u24, @truncate(raw >> 40)) & 0x7FFFFF;
}

/// Extract data.ptr (source byte offset) from a raw tape word (bits [39:8]).
inline fn dataPtr(raw: u64) u32 {
    return @as(u32, @truncate(raw >> 8));
}

/// Extract child count from a container tape word (bits [63:40]).
inline fn childCount(raw: u64) u24 {
    return @truncate(raw >> 40);
}

/// Convert any numeric tape entry to f64 for cross-type comparison.
inline fn numAsF64(words: [*]const u64, idx: u32) f64 {
    const tag: u8 = @truncate(words[idx]);
    const data: u64 = words[idx + 1];
    return switch (tag) {
        T_UINT => @floatFromInt(@as(u64, data)),
        T_INT => @floatFromInt(@as(i64, @bitCast(data))),
        T_DBL => @bitCast(data),
        else => unreachable,
    };
}

/// Cheap 64-bit string fingerprint: low 32 bits = length, high 32 = first 4 bytes.
/// Used to pre-filter key comparisons in unordered object matching. Most JSON keys
/// differ in either length or first few characters, so this rejects >95% of
/// non-matching pairs without touching source bytes.
inline fn strFingerprint(raw: u64, base: usize) u64 {
    const len = strLen(raw);
    if (len == 0) return 0;
    const src: [*]const u8 = @ptrFromInt(base + dataPtr(raw));
    const prefix: u32 = if (len >= 4)
        @as(*align(1) const u32, @ptrCast(src)).*
    else blk: {
        var buf: [4]u8 = .{ 0, 0, 0, 0 };
        for (0..@min(len, 4)) |k| buf[k] = src[k];
        break :blk @as(*align(1) const u32, @ptrCast(&buf)).*;
    };
    return @as(u64, prefix) << 32 | @as(u64, len);
}

/// Compare string source bytes for two tape entries.
/// Inlines short-string comparison (≤16 bytes) to avoid simd.eql call overhead.
/// Most JSON keys ("id", "name", "type", "data") are <16 bytes, so this
/// fast path fires for the majority of string comparisons.
inline fn strEql(ra: u64, base_a: usize, rb: u64, base_b: usize) bool {
    const la = strLen(ra);
    const lb = strLen(rb);
    if (la != lb) return false;
    if (la == 0) return true;
    const src_a: [*]const u8 = @ptrFromInt(base_a + dataPtr(ra));
    const src_b: [*]const u8 = @ptrFromInt(base_b + dataPtr(rb));
    // Short string fast path: single v128 compare covers up to 16 bytes.
    // zimdjson always pads input buffers (≥SIMDJSON_PADDING), so reading
    // 16 bytes from any string start is safe even if the string is shorter.
    if (la <= 16) {
        const va: @Vector(16, u8) = src_a[0..16].*;
        const vb: @Vector(16, u8) = src_b[0..16].*;
        // Mask: only compare the first `la` bytes by shifting out the rest.
        // Create a mask where positions < la are 0xFF and positions >= la are 0x00.
        const indices = std.simd.iota(u8, 16);
        const len_splat: @Vector(16, u8) = @splat(@as(u8, @truncate(la)));
        const mask: @Vector(16, bool) = indices < len_splat;
        const diff = @select(u8, mask, va ^ vb, @as(@Vector(16, u8), @splat(0)));
        return !simd.vecAnySet(diff != @as(@Vector(16, u8), @splat(0)));
    }
    return simd.eql(src_a, src_b, la);
}

/// Skip past a tape entry and all its children, returning the index of
/// the next sibling. Numbers advance +2, containers jump past close bracket,
/// everything else +1.
inline fn nextEntryRaw(words: [*]const u64, idx: u32) u32 {
    const tag: u8 = @truncate(words[idx]);
    return switch (tag) {
        T_UINT, T_INT, T_DBL => idx + 2,
        T_ARR, T_OBJ => dataPtr(words[idx]), // data.ptr is already one-past-close (simdjson convention)
        else => idx + 1,
    };
}

/// Iterative tape-level deep equality comparison.
///
/// Walks both tapes linearly in lockstep. Uses raw u64 pointer access
/// (no struct bitcasting per entry), SIMD string byte comparison via
/// simd.eql, and a fast-path for identical raw words.
///
/// The `ra == rb` early-exit is critical: for same-structure documents it
/// fires for ~50% of entries (containers, close brackets, null/true/false)
/// because their raw u64 words are identical across parses.
///
/// `comptime unordered_objects`: when true, object openings are delegated to
/// `tapeDeepEqualUnordered` (handles key reordering) and then skipped over.
/// When false, objects are entered and walked linearly (pure ordered mode).
/// This generates two optimized variants from one function body.
fn tapeDeepEqualIterative(
    comptime unordered_objects: bool,
    words_a: [*]const u64,
    start_a: u32,
    base_a: usize,
    words_b: [*]const u64,
    start_b: u32,
    base_b: usize,
) bool {
    // Determine end of value A's tape region.
    const raw0: u64 = words_a[start_a];
    const tag0: u8 = @truncate(raw0);

    // For unordered_objects mode: if the root is an object, delegate immediately
    if (comptime unordered_objects) {
        if (tag0 == T_OBJ) {
            return tapeDeepEqualUnordered(words_a, start_a, base_a, words_b, start_b, base_b);
        }
    }

    const end_a: u32 = switch (tag0) {
        T_ARR, T_OBJ => dataPtr(raw0), // data.ptr is already one-past-close (simdjson convention)
        T_UINT, T_INT, T_DBL => start_a + 2,
        else => start_a + 1,
    };

    var ia: u32 = start_a;
    var ib: u32 = start_b;

    while (ia < end_a) {
        const ra: u64 = words_a[ia];
        const rb: u64 = words_b[ib];
        const tag_a: u8 = @truncate(ra);
        const tag_b: u8 = @truncate(rb);

        // Fast path: identical raw word (~50% hit for same-structure docs).
        if (ra == rb) {
            // In unordered mode, identical object openings still need unordered
            // comparison — keys inside may be in different order.
            if (comptime unordered_objects) {
                if (tag_a == T_OBJ) {
                    if (!tapeDeepEqualUnordered(words_a, ia, base_a, words_b, ib, base_b))
                        return false;
                    ia = dataPtr(ra);
                    ib = dataPtr(rb);
                    continue;
                }
            }
            if (tag_a == T_STR) {
                if (!strEql(ra, base_a, rb, base_b)) return false;
            } else if (isNumTag(tag_a)) {
                if (words_a[ia + 1] != words_b[ib + 1]) return false;
            }
            const w = wordWidth(tag_a);
            ia += w;
            ib += w;
            continue;
        }

        // Tags differ — cross-type numeric or mismatch
        if (tag_a != tag_b) {
            if (isNumTag(tag_a) and isNumTag(tag_b)) {
                if (numAsF64(words_a, ia) != numAsF64(words_b, ib)) return false;
                ia += 2;
                ib += 2;
                continue;
            }
            return false;
        }

        // Same tag, different word
        switch (tag_a) {
            T_NULL, T_TRUE, T_FALSE, T_OBJ_C, T_ARR_C => {
                ia += 1;
                ib += 1;
            },
            T_STR => {
                if (!strEql(ra, base_a, rb, base_b)) return false;
                ia += 1;
                ib += 1;
            },
            T_UINT, T_INT => {
                if (words_a[ia + 1] != words_b[ib + 1]) return false;
                ia += 2;
                ib += 2;
            },
            T_DBL => {
                if (@as(f64, @bitCast(words_a[ia + 1])) != @as(f64, @bitCast(words_b[ib + 1]))) return false;
                ia += 2;
                ib += 2;
            },
            T_ARR => {
                if (childCount(ra) != childCount(rb)) return false;
                ia += 1;
                ib += 1;
            },
            T_OBJ => {
                if (childCount(ra) != childCount(rb)) return false;
                if (comptime unordered_objects) {
                    // Delegate to unordered comparison and skip past the object
                    if (!tapeDeepEqualUnordered(words_a, ia, base_a, words_b, ib, base_b))
                        return false;
                    ia = dataPtr(ra);
                    ib = dataPtr(rb);
                } else {
                    ia += 1;
                    ib += 1;
                }
            },
            else => return false,
        }
    }

    return true;
}

// ── Unordered (key-order-insensitive) deep equality ──
//
// For objects: O(n log n) key matching via sorted fingerprint + binary search.
// Arrays: compared element-by-element in order (array order always matters).
// Everything else: same as ordered.

/// Sort entry for fingerprint-based key lookup.
const FpEntry = struct { fp: u64, key_idx: u32 };

fn fpLessThan(_: void, a: FpEntry, b: FpEntry) bool {
    return a.fp < b.fp;
}

/// Stack buffer size for sorted key arrays. Larger objects heap-allocate.
const SORT_STACK_MAX = 64;

/// Compare two values recursively with order-insensitive object matching.
fn tapeDeepEqualUnordered(
    words_a: [*]const u64,
    idx_a: u32,
    base_a: usize,
    words_b: [*]const u64,
    idx_b: u32,
    base_b: usize,
) bool {
    const ra: u64 = words_a[idx_a];
    const rb: u64 = words_b[idx_b];
    const tag_a: u8 = @truncate(ra);
    const tag_b: u8 = @truncate(rb);

    // Tags differ — cross-type numeric or not equal
    if (tag_a != tag_b) {
        if (isNumTag(tag_a) and isNumTag(tag_b))
            return numAsF64(words_a, idx_a) == numAsF64(words_b, idx_b);
        return false;
    }

    return switch (tag_a) {
        T_NULL, T_TRUE, T_FALSE => true,

        T_STR => strEql(ra, base_a, rb, base_b),

        T_UINT, T_INT => words_a[idx_a + 1] == words_b[idx_b + 1],

        T_DBL => @as(f64, @bitCast(words_a[idx_a + 1])) == @as(f64, @bitCast(words_b[idx_b + 1])),

        T_ARR => blk: {
            const count_a: u32 = childCount(ra);
            if (count_a != childCount(rb)) break :blk false;
            // Arrays: use iterative hybrid walk (fast for primitives/strings,
            // delegates to unordered for nested objects).
            break :blk tapeDeepEqualIterative(true, words_a, idx_a, base_a, words_b, idx_b, base_b);
        },

        T_OBJ => blk: {
            const count_a: u32 = childCount(ra);
            if (count_a != childCount(rb)) break :blk false;
            if (count_a == 0) break :blk true;

            // Try ordered comparison first (fast path: keys already in same order).
            var all_ordered = true;
            {
                var ca: u32 = idx_a + 1;
                var cb: u32 = idx_b + 1;
                var i: u32 = 0;
                while (i < count_a) : (i += 1) {
                    if (!strEql(words_a[ca], base_a, words_b[cb], base_b)) {
                        all_ordered = false;
                        break;
                    }
                    ca = nextEntryRaw(words_a, ca + 1);
                    cb = nextEntryRaw(words_b, cb + 1);
                }
            }

            if (all_ordered) {
                var ca: u32 = idx_a + 1;
                var cb: u32 = idx_b + 1;
                var k: u32 = 0;
                while (k < count_a) : (k += 1) {
                    const va: u32 = ca + 1;
                    const vb: u32 = cb + 1;
                    if (!tapeDeepEqualIterative(true, words_a, va, base_a, words_b, vb, base_b))
                        break :blk false;
                    ca = nextEntryRaw(words_a, va);
                    cb = nextEntryRaw(words_b, vb);
                }
                break :blk true;
            }

            // O(n log n) key matching: sort B keys by fingerprint, binary search for each A key.
            var stack_buf: [SORT_STACK_MAX]FpEntry = undefined;
            const heap_buf = if (count_a > SORT_STACK_MAX)
                gpa.alloc(FpEntry, count_a) catch break :blk false
            else
                null;
            defer if (heap_buf) |h| gpa.free(h);
            const b_entries: []FpEntry = if (heap_buf) |h| h else stack_buf[0..count_a];

            {
                var kb: u32 = idx_b + 1;
                var j: u32 = 0;
                while (j < count_a) : (j += 1) {
                    b_entries[j] = .{ .fp = strFingerprint(words_b[kb], base_b), .key_idx = kb };
                    kb = nextEntryRaw(words_b, kb + 1);
                }
            }
            std.sort.pdq(FpEntry, b_entries, {}, fpLessThan);

            // Match each key in A via binary search into sorted B entries.
            var ka: u32 = idx_a + 1;
            var i: u32 = 0;
            while (i < count_a) : (i += 1) {
                const val_a_idx: u32 = ka + 1;
                const fp_a = strFingerprint(words_a[ka], base_a);
                var found = false;

                // Binary search for first entry with matching fingerprint
                const n: u32 = @intCast(b_entries.len);
                var lo: u32 = 0;
                var hi: u32 = n;
                while (lo < hi) {
                    const mid = lo + (hi - lo) / 2;
                    if (b_entries[mid].fp < fp_a) lo = mid + 1 else hi = mid;
                }
                // Scan all entries with matching fingerprint (handles collisions)
                var idx = lo;
                while (idx < n and b_entries[idx].fp == fp_a) : (idx += 1) {
                    const bk = b_entries[idx].key_idx;
                    if (strEql(words_a[ka], base_a, words_b[bk], base_b)) {
                        if (!tapeDeepEqualIterative(
                            true,
                            words_a, val_a_idx, base_a,
                            words_b, bk + 1, base_b,
                        )) break :blk false;
                        found = true;
                        break;
                    }
                }

                if (!found) break :blk false;
                ka = nextEntryRaw(words_a, val_a_idx);
            }
            break :blk true;
        },

        else => false,
    };
}

/// Deep-compare two document values by walking their tapes.
/// Returns: 1 = equal, 0 = not equal, -1 = error (invalid doc_id)
/// `ordered`: 1 = key-order-sensitive (fastest), 0 = key-order-insensitive (default)
export fn doc_deep_equal(doc_a: i32, idx_a: u32, doc_b: i32, idx_b: u32, ordered: i32) i32 {
    const pa = getDocParser(doc_a) orelse return -1;
    const pb = getDocParser(doc_b) orelse return -1;

    const wa = pa.tape.words.items().ptr;
    const wb = pb.tape.words.items().ptr;

    // Fast path: same tape + same index → trivially equal (identity check)
    if (wa == wb and idx_a == idx_b) return 1;

    if (ordered != 0) {
        return if (tapeDeepEqualIterative(
            false,
            wa, idx_a, pa.tape.input_base_addr,
            wb, idx_b, pb.tape.input_base_addr,
        )) 1 else 0;
    }

    // Hybrid mode: iterative walk for arrays/primitives, unordered for objects
    return if (tapeDeepEqualIterative(
        true,
        wa, idx_a, pa.tape.input_base_addr,
        wb, idx_b, pb.tape.input_base_addr,
    )) 1 else 0;
}

// ============================================================
// Tape Export/Import — transfer parsed tape between contexts
// ============================================================
//
// Packed buffer format:
//   [0..4)   u32 LE  tape_count (number of u64 tape words)
//   [4..8)   u32 LE  input_length (byte length of JSON source)
//   [8..8+T) u64[]   tape words (T = tape_count * 8)
//   [8+T..)  u8[]    JSON source bytes
//
// Total: 8 + tape_count * 8 + input_length

/// Tape dimensions for a parsed document.
const TapeDims = struct { tape_count: u32, input_len: u32 };

fn docTapeDims(p: anytype) TapeDims {
    const root_raw: u64 = p.tape.words.items().ptr[0];
    const closing_root_idx: u32 = @truncate(root_raw >> 8);
    // document_buffer contains input + SIMD padding (16 bytes)
    const doc_buf_len: u32 = @intCast(p.document_buffer.items.len);
    return .{
        .tape_count = closing_root_idx + 1,
        .input_len = if (doc_buf_len >= 16) doc_buf_len - 16 else doc_buf_len,
    };
}

/// Returns the size needed for the packed tape buffer.
export fn doc_export_tape_size(doc_id: i32) u32 {
    const p = getDocParser(doc_id) orelse return 0;
    const d = docTapeDims(p);
    return 8 + d.tape_count * 8 + d.input_len;
}

/// Write packed tape buffer to out_ptr. Returns bytes written, or 0 on error.
export fn doc_export_tape(doc_id: i32, out_ptr: [*]u8, out_cap: u32) u32 {
    const p = getDocParser(doc_id) orelse return 0;
    const d = docTapeDims(p);
    const tape_bytes = d.tape_count * 8;
    const total: u32 = 8 + tape_bytes + d.input_len;
    if (out_cap < total) return 0;

    // Header: tape_count, input_len (WASM is always little-endian)
    const header: [*]align(1) u32 = @ptrCast(out_ptr);
    header[0] = d.tape_count;
    header[1] = d.input_len;

    // Tape words + input bytes (without SIMD padding)
    const tape_src: [*]const u8 = @ptrCast(p.tape.words.items().ptr);
    @memcpy(out_ptr[8..][0..tape_bytes], tape_src[0..tape_bytes]);
    @memcpy(out_ptr[8 + tape_bytes ..][0..d.input_len], p.document_buffer.items.ptr[0..d.input_len]);

    return total;
}

/// Import a packed tape buffer into a free document slot.
/// Returns slot ID (0..127) on success, or -1 on error.
export fn doc_import_tape(buf_ptr: [*]const u8, buf_len: u32) i32 {
    if (buf_len < 8) return -1;

    // Read header (WASM is always little-endian)
    const header: [*]align(1) const u32 = @ptrCast(buf_ptr);
    const tape_count = header[0];
    const input_len = header[1];

    // Overflow-safe size validation: check tape_bytes won't overflow u32
    const tape_bytes: u64 = @as(u64, tape_count) * 8;
    const expected: u64 = 8 + tape_bytes + @as(u64, input_len);
    if (expected > buf_len) return -1;

    // Find free slot
    const uid: usize = for (doc_active, 0..) |active, i| {
        if (!active) break i;
    } else {
        return -1;
    };

    const p = &doc_parsers[uid];
    const tape_bytes_u32: u32 = @intCast(tape_bytes);

    // Copy input into document_buffer (with 16-byte SIMD padding)
    p.document_buffer.clearRetainingCapacity();
    p.document_buffer.ensureTotalCapacity(gpa, input_len + 16) catch return -1;
    p.document_buffer.appendSliceAssumeCapacity(buf_ptr[8 + tape_bytes_u32 ..][0..input_len]);
    p.document_buffer.appendNTimesAssumeCapacity(' ', 16);

    // Copy tape words
    p.tape.words.ensureTotalCapacity(gpa, tape_count) catch return -1;
    p.tape.words.list.clearRetainingCapacity();
    const tape_dst: [*]u8 = @ptrCast(p.tape.words.list.items.ptr);
    @memcpy(tape_dst[0..tape_bytes_u32], buf_ptr[8..][0..tape_bytes_u32]);
    p.tape.words.list.items.len = tape_count;

    // Fix input_base_addr to point to new document_buffer
    p.tape.input_base_addr = @intFromPtr(p.document_buffer.items.ptr);

    // Activate slot
    doc_active[uid] = true;
    doc_is_json5[uid] = false;
    // Mark src positions as built (empty) — imported tapes lack token data
    // needed by buildDocSrcPositions, so doc_get_src_pos returns 0xFFFFFFFF.
    doc_src[uid] = .{ .positions = doc_src[uid].positions, .cap = doc_src[uid].cap, .len = 0, .built = true };

    return @intCast(uid);
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
