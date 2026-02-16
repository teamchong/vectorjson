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

/// Global stream state slots (support multiple concurrent streams)
var streams: [4]?*stream.StreamState = .{ null, null, null, null };

fn getStream(id: i32) ?*stream.StreamState {
    if (id < 0 or id >= streams.len) return null;
    return streams[@intCast(id)];
}

export fn stream_create() i32 {
    for (&streams, 0..) |*slot, i| {
        if (slot.* == null) {
            slot.* = stream.StreamState.init(gpa) catch return -1;
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

const MAX_DOC_SLOTS = 256;
var doc_parsers: [MAX_DOC_SLOTS]DomParser = .{DomParser.init} ** MAX_DOC_SLOTS;
var doc_active: [MAX_DOC_SLOTS]bool = .{false} ** MAX_DOC_SLOTS;

// --- Source position tracking ---
// Per-slot arrays mapping tape index → byte offset in the parsed input.
// Built lazily on first doc_get_src_pos call by correlating tape words with token indices.
// Used by JS isComplete() to check if a value was autocompleted.
var doc_src_positions: [MAX_DOC_SLOTS]?[*]u32 = .{null} ** MAX_DOC_SLOTS;
var doc_src_pos_cap: [MAX_DOC_SLOTS]u32 = .{0} ** MAX_DOC_SLOTS;
var doc_src_pos_len: [MAX_DOC_SLOTS]u32 = .{0} ** MAX_DOC_SLOTS;
var doc_src_pos_built: [MAX_DOC_SLOTS]bool = .{false} ** MAX_DOC_SLOTS;

/// Build source position array for a document slot by walking tape + tokens in parallel.
/// Token indices contain byte offsets of ALL structural characters ({, }, [, ], :, ", etc.).
/// Tape words correspond to value-producing tokens. We skip `:` and `,` tokens that don't
/// produce tape entries.
fn buildDocSrcPositions(uid: usize) void {
    const p = &doc_parsers[uid];

    // Compute tape length from root word (non-streaming mode uses pointer arithmetic,
    // so words.items().len is 0; the root word stores the closing root index).
    const root_raw: u64 = p.tape.words.items().ptr[0];
    const closing_root_idx: u32 = @truncate(root_raw >> 8);
    const tape_count: u32 = closing_root_idx + 1;

    // Reuse existing allocation if large enough, else grow
    if (doc_src_pos_cap[uid] < tape_count) {
        if (doc_src_positions[uid]) |old_ptr| {
            gpa.free(old_ptr[0..doc_src_pos_cap[uid]]);
        }
        const positions = gpa.alloc(u32, tape_count) catch {
            doc_src_positions[uid] = null;
            doc_src_pos_cap[uid] = 0;
            doc_src_pos_len[uid] = 0;
            return;
        };
        doc_src_positions[uid] = positions.ptr;
        doc_src_pos_cap[uid] = tape_count;
    }

    const positions = doc_src_positions[uid] orelse return;
    doc_src_pos_len[uid] = tape_count;

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
    return &doc_parsers[uid];
}

/// Read a string value from a parser's tape at the given index.
/// Returns the raw byte slice pointing into the parser's string buffer.
/// String buffer layout per string: [u32 length][string_bytes]
/// Tape word data.len stores the string ordinal (index into string_meta).
const STR_HEADER_SIZE: u32 = @sizeOf(u32); // 4

fn readTapeString(p: *DomParser, index: u32) []const u8 {
    const native_endian = @import("builtin").cpu.arch.endian();
    const word = p.tape.get(index);
    const str_offset = word.data.ptr;
    const strings = p.tape.string_buffer.strings.items();
    const str_len = std.mem.readInt(u32, strings.ptr[str_offset..][0..@sizeOf(u32)], native_endian);
    return strings.ptr[str_offset + STR_HEADER_SIZE ..][0..str_len];
}

/// Parse JSON bytes and store the result in a document slot.
/// Returns slot ID (0..255) on success, or -1 on error.
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
    doc_src_pos_built[uid] = false; // mark for lazy build on first src_pos query

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

/// Read a doc string as raw UTF-8 — ONE WASM call.
/// Writes ptr to batch_buffer[0], len to batch_buffer[1].
/// Returns len (0 = empty string). JS reads raw bytes via ptr.
export fn doc_read_string_raw(doc_id: i32, index: u32) u32 {
    const p = getDocParser(doc_id) orelse return 0;
    const str = readTapeString(p, index);
    batch_buffer[0] = @intFromPtr(str.ptr);
    batch_buffer[1] = @intCast(str.len);
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

/// Get the source byte offset of a tape entry in the parsed input.
/// Lazily builds the src_positions array on first call (only needed for incomplete parses).
/// Returns 0xFFFFFFFF if the doc or index is invalid.
export fn doc_get_src_pos(doc_id: i32, idx: u32) u32 {
    _ = getDocParser(doc_id) orelse return 0xFFFFFFFF;
    const uid: usize = @intCast(doc_id);
    if (!doc_src_pos_built[uid]) {
        buildDocSrcPositions(uid);
        doc_src_pos_built[uid] = true;
    }
    if (idx >= doc_src_pos_len[uid]) return 0xFFFFFFFF;
    const positions = doc_src_positions[uid] orelse return 0xFFFFFFFF;
    return positions[idx];
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
        curr = nextTapeEntry(p.tape, curr + 1);
    }
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
/// Returns the number of elements written (capped at 16384).
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
        curr = nextTapeEntry(p.tape, curr);
    }
    return count;
}

/// Walk an object once, writing key tape indices into batch_buffer.
/// Value index = key_index + 1.
/// Returns the number of entries written (capped at 16384).
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
        curr = nextTapeEntry(p.tape, curr + 1);
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
/// Returns: 0=incomplete, 1=complete, 2=complete_early, 3=invalid
export fn classify_input(ptr: [*]const u8, len: u32) u32 {
    classify_value_end = 0;

    if (len == 0) return 0; // empty = incomplete

    var depth_val: i32 = 0;
    var in_string: bool = false;
    var escape_next: bool = false;
    var root_completed: bool = false;
    var root_type: enum { none, string, scalar } = .none;
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
                if (depth_val == 0 and root_type == .string and !root_completed) {
                    root_completed = true;
                    classify_value_end = i + 1;
                }
            }
            i += 1;
            continue;
        }

        // Any non-scalar-body char at depth 0 terminates a pending scalar
        // Scalar body: digits, signs, decimal, exponent, plus keyword letters (true/false/null)
        if (depth_val == 0 and root_type == .scalar and !root_completed) {
            switch (c) {
                'a'...'z', '0'...'9', '-', '.', '+', 'E' => {},
                else => { root_completed = true; classify_value_end = i; },
            }
        }

        switch (c) {
            '"' => {
                if (depth_val == 0 and !root_completed and root_type == .none) {
                    root_type = .string;
                }
                in_string = true;
            },
            '{', '[' => {
                depth_val += 1;
            },
            '}', ']' => {
                depth_val -= 1;
                if (depth_val < 0) return 3; // invalid: unmatched closing bracket
                if (depth_val == 0 and !root_completed) {
                    root_completed = true;
                    classify_value_end = i + 1;
                }
            },
            't', 'f', 'n', '-', '0'...'9' => {
                if (depth_val == 0 and !root_completed and root_type != .scalar) {
                    root_type = .scalar;
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
    if (!root_completed and depth_val == 0 and !in_string and root_type == .scalar) {
        const scalar = ptr[scalar_start..len];
        // Partial keyword prefix → incomplete (e.g. "tr", "fal", "nul")
        for ([_][]const u8{ "true", "false", "null" }) |kw| {
            if (scalar.len < kw.len and std.mem.eql(u8, scalar, kw[0..scalar.len])) return 0;
        }
        // Trailing incomplete number char → incomplete (e.g. "1.", "1e", "1e-")
        if (scalar.len > 0) {
            const last_ch = scalar[scalar.len - 1];
            if (last_ch == '.' or last_ch == '-' or last_ch == '+' or last_ch == 'e' or last_ch == 'E') {
                return 0;
            }
        }
        root_completed = true;
        classify_value_end = len;
    }

    if (!root_completed) {
        // Nothing started, still mid-string, or depth > 0 → incomplete
        return 0;
    }

    // Root value is complete. Check for trailing content.
    var j = classify_value_end;
    while (j < len) : (j += 1) {
        const c = ptr[j];
        if (c != ' ' and c != '\t' and c != '\n' and c != '\r') {
            // Non-whitespace after complete value → complete_early
            return 2;
        }
    }

    return 1; // complete (only whitespace after)
}

/// Get the stored value_end offset (for complete_early classification).
export fn get_value_end() u32 {
    return classify_value_end;
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
                var atom_handled = false;
                // Complete partial keywords: "tr" → "ue", "fal" → "se", "nu" → "ll", etc.
                const keywords = [_][]const u8{ "true", "false", "null" };
                for (keywords) |kw| {
                    if (atom.len <= kw.len and std.mem.eql(u8, atom, kw[0..atom.len])) {
                        w.append(kw[atom.len..]);
                        atom_handled = true;
                        break;
                    }
                }
                // Strip trailing incomplete number chars iteratively:
                // "1.23e-" → strip "-" → "1.23e" → strip "e" → "1.23"
                // "1." → strip "." → "1"
                // "-" → strip all → atom_start (no valid prefix → leaves invalid)
                if (!atom_handled and atom.len > 0) {
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
