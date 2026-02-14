///! VectorJSON Deep Compare Engine
///!
///! Compares two JSON documents structurally and produces a list of diffs.
///! Works on serialized token streams to avoid needing two live tapes.
///!
///! Algorithm:
///!   1. Parse JSON A → walk tape → serialize tokens to snapshot buffer A
///!   2. Parse JSON B → walk tape → serialize tokens to snapshot buffer B
///!   3. Walk both snapshots simultaneously, recording structural diffs
///!
///! Object comparison is key-order-independent: {a:1, b:2} == {b:2, a:1}.
///! Array comparison is index-based: [1,2,3] vs [1,3] has changes at [1] and removal at [2].

const std = @import("std");
const simd = @import("simd.zig");

/// Token types in serialized stream
pub const TokenTag = enum(u8) {
    null_val = 0,
    true_val = 1,
    false_val = 2,
    number = 3, // followed by f64 (8 bytes LE)
    string = 4, // followed by u32 len + bytes
    key = 5, // followed by u32 len + bytes
    object_start = 6,
    object_end = 7,
    array_start = 8,
    array_end = 9,
    end = 10,
};

/// Diff categories
pub const DiffType = enum(u8) {
    changed = 0, // value differs at same path
    added = 1, // path exists in B but not A
    removed = 2, // path exists in A but not B
    type_changed = 3, // different JSON types at same path
};

pub const DiffEntry = struct {
    path_offset: u32, // offset into path_buffer
    path_len: u32,
    diff_type: DiffType,
};

const MAX_DIFFS = 1024;
const MAX_PATH_BUF = 64 * 1024;

/// Serialized token stream — a flat buffer of tokens with inline values.
pub const TokenStream = struct {
    data: ?[*]u8 = null,
    len: u32 = 0,
    cap: u32 = 0,
    allocator: std.mem.Allocator = undefined,

    pub fn init(allocator: std.mem.Allocator) TokenStream {
        const initial_cap: u32 = 8192;
        const buf = allocator.alloc(u8, initial_cap) catch return .{ .allocator = allocator };
        return .{
            .data = buf.ptr,
            .cap = initial_cap,
            .allocator = allocator,
        };
    }

    pub fn deinit(self: *TokenStream) void {
        if (self.data) |d| {
            self.allocator.free(d[0..self.cap]);
        }
        self.* = .{};
    }

    pub fn reset(self: *TokenStream) void {
        self.len = 0;
    }

    fn ensureSpace(self: *TokenStream, needed: u32) bool {
        const total = self.len + needed;
        if (total <= self.cap) return true;
        var new_cap = self.cap;
        while (new_cap < total) {
            new_cap = new_cap *| 2;
        }
        if (self.data) |old| {
            const old_slice = old[0..self.cap];
            if (self.allocator.resize(old_slice, new_cap)) {
                self.cap = new_cap;
                return true;
            }
            const new_buf = self.allocator.alloc(u8, new_cap) catch return false;
            @memcpy(new_buf[0..self.len], old[0..self.len]);
            self.allocator.free(old_slice);
            self.data = new_buf.ptr;
            self.cap = new_cap;
            return true;
        }
        return false;
    }

    pub fn writeByte(self: *TokenStream, b: u8) void {
        if (!self.ensureSpace(1)) return;
        const d = self.data orelse return;
        d[self.len] = b;
        self.len += 1;
    }

    pub fn writeTag(self: *TokenStream, tag: TokenTag) void {
        self.writeByte(@intFromEnum(tag));
    }

    pub fn writeF64(self: *TokenStream, val: f64) void {
        if (!self.ensureSpace(8)) return;
        const d = self.data orelse return;
        const bytes: [8]u8 = @bitCast(val);
        @memcpy(d[self.len..][0..8], &bytes);
        self.len += 8;
    }

    pub fn writeU32(self: *TokenStream, val: u32) void {
        if (!self.ensureSpace(4)) return;
        const d = self.data orelse return;
        const bytes: [4]u8 = @bitCast(val);
        @memcpy(d[self.len..][0..4], &bytes);
        self.len += 4;
    }

    pub fn writeStringData(self: *TokenStream, tag: TokenTag, ptr: [*]const u8, slen: u32) void {
        self.writeTag(tag);
        self.writeU32(slen);
        if (slen > 0) {
            if (!self.ensureSpace(slen)) return;
            const d = self.data orelse return;
            @memcpy(d[self.len..][0..slen], ptr[0..slen]);
            self.len += slen;
        }
    }
};

/// Reader for walking a serialized token stream
pub const TokenReader = struct {
    data: [*]const u8,
    len: u32,
    pos: u32 = 0,

    pub fn fromStream(stream: *const TokenStream) TokenReader {
        return .{
            .data = stream.data orelse @as([*]const u8, @ptrFromInt(1)),
            .len = stream.len,
        };
    }

    pub fn atEnd(self: *const TokenReader) bool {
        return self.pos >= self.len;
    }

    pub fn peekTag(self: *const TokenReader) TokenTag {
        if (self.pos >= self.len) return .end;
        return @enumFromInt(self.data[self.pos]);
    }

    pub fn readByte(self: *TokenReader) u8 {
        if (self.pos >= self.len) return @intFromEnum(TokenTag.end);
        const b = self.data[self.pos];
        self.pos += 1;
        return b;
    }

    pub fn readTag(self: *TokenReader) TokenTag {
        return @enumFromInt(self.readByte());
    }

    pub fn readF64(self: *TokenReader) f64 {
        if (self.pos + 8 > self.len) return 0;
        const bytes = self.data[self.pos..][0..8];
        self.pos += 8;
        return @bitCast(bytes.*);
    }

    pub fn readU32(self: *TokenReader) u32 {
        if (self.pos + 4 > self.len) return 0;
        const bytes = self.data[self.pos..][0..4];
        self.pos += 4;
        return @bitCast(bytes.*);
    }

    pub fn readStringBytes(self: *TokenReader) struct { ptr: [*]const u8, len: u32 } {
        const slen = self.readU32();
        if (self.pos + slen > self.len) return .{ .ptr = @ptrFromInt(1), .len = 0 };
        const ptr = self.data + self.pos;
        self.pos += slen;
        return .{ .ptr = ptr, .len = slen };
    }

    /// Skip an entire value (scalar or nested container)
    pub fn skipValue(self: *TokenReader) void {
        const tag = self.readTag();
        switch (tag) {
            .null_val, .true_val, .false_val => {},
            .number => self.pos += 8,
            .string => {
                const slen = self.readU32();
                self.pos += slen;
            },
            .object_start => {
                // Read key-value pairs until object_end
                while (true) {
                    const next = self.peekTag();
                    if (next == .object_end or next == .end) {
                        _ = self.readTag(); // consume end marker
                        break;
                    }
                    // Skip key
                    _ = self.readTag(); // key tag
                    const klen = self.readU32();
                    self.pos += klen;
                    // Skip value
                    self.skipValue();
                }
            },
            .array_start => {
                while (true) {
                    const next = self.peekTag();
                    if (next == .array_end or next == .end) {
                        _ = self.readTag();
                        break;
                    }
                    self.skipValue();
                }
            },
            else => {},
        }
    }

    // savePos/restorePos removed — unused (unordered compare collects keys upfront)
};

/// Key-value entry for object comparison
const KeyEntry = struct {
    key_ptr: [*]const u8,
    key_len: u32,
    value_pos: u32, // position of value in token stream
};

/// Main comparison state
pub const CompareState = struct {
    // Serialized token streams
    stream_a: TokenStream = .{},
    stream_b: TokenStream = .{},

    // Diff results
    diffs: [MAX_DIFFS]DiffEntry = undefined,
    diff_count: u32 = 0,

    // Path buffer for all diff paths
    path_buffer: ?[*]u8 = null,
    path_buffer_len: u32 = 0,
    path_buffer_cap: u32 = 0,

    // Current path (built during comparison)
    current_path: ?[*]u8 = null,
    current_path_len: u32 = 0,
    current_path_cap: u32 = 0,

    // Scratch space for object key collection
    keys_scratch_a: [256]KeyEntry = undefined,
    keys_scratch_b: [256]KeyEntry = undefined,

    allocator: std.mem.Allocator = undefined,
    has_error: bool = false,
    /// Whether to compare objects in ordered mode (key order matters)
    ordered: bool = false,

    pub fn init(allocator: std.mem.Allocator) !*CompareState {
        const self = try allocator.create(CompareState);
        self.* = .{};
        self.allocator = allocator;
        self.stream_a = TokenStream.init(allocator);
        self.stream_b = TokenStream.init(allocator);

        // Allocate path buffers
        const path_buf = try allocator.alloc(u8, MAX_PATH_BUF);
        self.path_buffer = path_buf.ptr;
        self.path_buffer_cap = MAX_PATH_BUF;

        const cur_path = try allocator.alloc(u8, 4096);
        self.current_path = cur_path.ptr;
        self.current_path_cap = 4096;
        // Start with "$"
        cur_path[0] = '$';
        self.current_path_len = 1;

        return self;
    }

    pub fn deinit(self: *CompareState) void {
        self.stream_a.deinit();
        self.stream_b.deinit();
        if (self.path_buffer) |buf| {
            self.allocator.free(buf[0..self.path_buffer_cap]);
        }
        if (self.current_path) |buf| {
            self.allocator.free(buf[0..self.current_path_cap]);
        }
        self.allocator.destroy(self);
    }

    pub fn reset(self: *CompareState) void {
        self.stream_a.reset();
        self.stream_b.reset();
        self.diff_count = 0;
        self.path_buffer_len = 0;
        self.current_path_len = 1; // "$"
        self.has_error = false;
        self.ordered = false;
    }

    /// Run the comparison on the two serialized streams.
    /// If ordered=true, object key order matters (raw compare).
    /// If ordered=false (default), object keys are matched by name.
    pub fn compare(self: *CompareState) void {
        var reader_a = TokenReader.fromStream(&self.stream_a);
        var reader_b = TokenReader.fromStream(&self.stream_b);
        self.current_path_len = 1; // "$"
        self.compareValues(&reader_a, &reader_b);
    }

    fn compareValues(self: *CompareState, ra: *TokenReader, rb: *TokenReader) void {
        if (self.diff_count >= MAX_DIFFS) return;

        const tag_a = ra.peekTag();
        const tag_b = rb.peekTag();

        // Type-level comparison
        const type_a = classifyType(tag_a);
        const type_b = classifyType(tag_b);

        if (type_a != type_b) {
            // Different types at this path
            self.recordDiff(.type_changed);
            ra.skipValue();
            rb.skipValue();
            return;
        }

        switch (tag_a) {
            .null_val => {
                _ = ra.readTag();
                _ = rb.readTag();
                // Both null — equal
            },
            .true_val, .false_val => {
                const ta = ra.readTag();
                const tb = rb.readTag();
                if (ta != tb) {
                    self.recordDiff(.changed);
                }
            },
            .number => {
                _ = ra.readTag();
                _ = rb.readTag();
                const na = ra.readF64();
                const nb = rb.readF64();
                if (na != nb) {
                    // Handle NaN: NaN != NaN but they should be "equal" for comparison
                    if (!(std.math.isNan(na) and std.math.isNan(nb))) {
                        self.recordDiff(.changed);
                    }
                }
            },
            .string => {
                _ = ra.readTag();
                _ = rb.readTag();
                const sa = ra.readStringBytes();
                const sb = rb.readStringBytes();
                if (!strEqual(sa.ptr, sa.len, sb.ptr, sb.len)) {
                    self.recordDiff(.changed);
                }
            },
            .object_start => {
                self.compareObjects(ra, rb);
            },
            .array_start => {
                self.compareArrays(ra, rb);
            },
            else => {
                // Unexpected — skip both
                ra.skipValue();
                rb.skipValue();
            },
        }
    }

    fn compareObjects(self: *CompareState, ra: *TokenReader, rb: *TokenReader) void {
        _ = ra.readTag(); // consume object_start
        _ = rb.readTag();

        if (self.ordered) {
            self.compareObjectsOrdered(ra, rb);
        } else {
            self.compareObjectsUnordered(ra, rb);
        }
    }

    /// Ordered comparison: keys must appear in same order
    fn compareObjectsOrdered(self: *CompareState, ra: *TokenReader, rb: *TokenReader) void {
        const saved_path_len = self.current_path_len;

        while (true) {
            const tag_a = ra.peekTag();
            const tag_b = rb.peekTag();
            const a_done = (tag_a == .object_end or tag_a == .end);
            const b_done = (tag_b == .object_end or tag_b == .end);

            if (a_done and b_done) break;

            if (a_done) {
                // B has extra keys
                while (rb.peekTag() == .key) {
                    _ = rb.readTag();
                    const kdata = rb.readStringBytes();
                    self.pushKeyPath(kdata.ptr, kdata.len);
                    self.recordDiff(.added);
                    self.current_path_len = saved_path_len;
                    rb.skipValue();
                }
                break;
            }

            if (b_done) {
                // A has extra keys
                while (ra.peekTag() == .key) {
                    _ = ra.readTag();
                    const kdata = ra.readStringBytes();
                    self.pushKeyPath(kdata.ptr, kdata.len);
                    self.recordDiff(.removed);
                    self.current_path_len = saved_path_len;
                    ra.skipValue();
                }
                break;
            }

            // Both have keys — read them
            _ = ra.readTag(); // key tag
            const ka = ra.readStringBytes();
            _ = rb.readTag(); // key tag
            const kb = rb.readStringBytes();

            if (strEqual(ka.ptr, ka.len, kb.ptr, kb.len)) {
                // Same key — compare values
                self.pushKeyPath(ka.ptr, ka.len);
                self.compareValues(ra, rb);
                self.current_path_len = saved_path_len;
            } else {
                // Different keys at same position — record both
                self.pushKeyPath(ka.ptr, ka.len);
                self.recordDiff(.removed);
                self.current_path_len = saved_path_len;
                ra.skipValue();

                self.pushKeyPath(kb.ptr, kb.len);
                self.recordDiff(.added);
                self.current_path_len = saved_path_len;
                rb.skipValue();
            }
        }

        // Consume object_end markers
        if (ra.peekTag() == .object_end) _ = ra.readTag();
        if (rb.peekTag() == .object_end) _ = rb.readTag();
    }

    /// Unordered comparison: keys matched by name regardless of order (default)
    fn compareObjectsUnordered(self: *CompareState, ra: *TokenReader, rb: *TokenReader) void {
        // Collect keys from A
        const keys_a_count = self.collectKeys(ra, &self.keys_scratch_a);
        if (ra.peekTag() == .object_end) _ = ra.readTag();

        // Collect keys from B
        const keys_b_count = self.collectKeys(rb, &self.keys_scratch_b);
        if (rb.peekTag() == .object_end) _ = rb.readTag();

        const saved_path_len = self.current_path_len;

        // Compare matching keys and find keys only in A
        for (self.keys_scratch_a[0..keys_a_count]) |ka| {
            var found = false;
            for (self.keys_scratch_b[0..keys_b_count]) |kb| {
                if (strEqual(ka.key_ptr, ka.key_len, kb.key_ptr, kb.key_len)) {
                    found = true;
                    self.pushKeyPath(ka.key_ptr, ka.key_len);
                    var sub_ra = TokenReader{
                        .data = self.stream_a.data orelse @as([*]const u8, @ptrFromInt(1)),
                        .len = self.stream_a.len,
                        .pos = ka.value_pos,
                    };
                    var sub_rb = TokenReader{
                        .data = self.stream_b.data orelse @as([*]const u8, @ptrFromInt(1)),
                        .len = self.stream_b.len,
                        .pos = kb.value_pos,
                    };
                    self.compareValues(&sub_ra, &sub_rb);
                    self.current_path_len = saved_path_len;
                    break;
                }
            }
            if (!found) {
                self.pushKeyPath(ka.key_ptr, ka.key_len);
                self.recordDiff(.removed);
                self.current_path_len = saved_path_len;
            }
        }

        // Find keys only in B → added
        for (self.keys_scratch_b[0..keys_b_count]) |kb| {
            var found = false;
            for (self.keys_scratch_a[0..keys_a_count]) |ka| {
                if (strEqual(ka.key_ptr, ka.key_len, kb.key_ptr, kb.key_len)) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                self.pushKeyPath(kb.key_ptr, kb.key_len);
                self.recordDiff(.added);
                self.current_path_len = saved_path_len;
            }
        }
    }

    /// Collect all key entries from an object (reads until object_end).
    /// Returns the number of keys collected.
    fn collectKeys(self: *CompareState, reader: *TokenReader, keys: *[256]KeyEntry) u32 {
        _ = self;
        var count: u32 = 0;
        while (count < 256) {
            const tag = reader.peekTag();
            if (tag == .object_end or tag == .end) break;
            if (tag != .key) break;

            _ = reader.readTag(); // consume key tag
            const kdata = reader.readStringBytes();

            // Record the value position
            const value_pos = reader.pos;
            keys[count] = .{
                .key_ptr = kdata.ptr,
                .key_len = kdata.len,
                .value_pos = value_pos,
            };
            count += 1;

            // Skip the value
            reader.skipValue();
        }
        return count;
    }

    fn compareArrays(self: *CompareState, ra: *TokenReader, rb: *TokenReader) void {
        _ = ra.readTag(); // consume array_start
        _ = rb.readTag();

        const saved_path_len = self.current_path_len;
        var index: u32 = 0;

        while (true) {
            const tag_a = ra.peekTag();
            const tag_b = rb.peekTag();
            const a_done = (tag_a == .array_end or tag_a == .end);
            const b_done = (tag_b == .array_end or tag_b == .end);

            if (a_done and b_done) break;

            if (a_done) {
                // B has extra elements
                while (rb.peekTag() != .array_end and rb.peekTag() != .end) {
                    self.pushIndexPath(index);
                    self.recordDiff(.added);
                    self.current_path_len = saved_path_len;
                    rb.skipValue();
                    index += 1;
                }
                break;
            }

            if (b_done) {
                // A has extra elements
                while (ra.peekTag() != .array_end and ra.peekTag() != .end) {
                    self.pushIndexPath(index);
                    self.recordDiff(.removed);
                    self.current_path_len = saved_path_len;
                    ra.skipValue();
                    index += 1;
                }
                break;
            }

            // Both have elements — compare
            self.pushIndexPath(index);
            self.compareValues(ra, rb);
            self.current_path_len = saved_path_len;
            index += 1;
        }

        // Consume array_end markers
        if (ra.peekTag() == .array_end) _ = ra.readTag();
        if (rb.peekTag() == .array_end) _ = rb.readTag();
    }

    // --- Path management ---

    fn pushKeyPath(self: *CompareState, key_ptr: [*]const u8, key_len: u32) void {
        const path = self.current_path orelse return;
        // Append ".key"
        const needed = self.current_path_len + 1 + key_len;
        if (needed > self.current_path_cap) return;
        path[self.current_path_len] = '.';
        @memcpy(path[self.current_path_len + 1 ..][0..key_len], key_ptr[0..key_len]);
        self.current_path_len = needed;
    }

    fn pushIndexPath(self: *CompareState, index: u32) void {
        const path = self.current_path orelse return;
        // Append "[index]"
        var tmp: [16]u8 = undefined;
        const idx_str = std.fmt.bufPrint(&tmp, "[{d}]", .{index}) catch return;
        const needed = self.current_path_len + @as(u32, @intCast(idx_str.len));
        if (needed > self.current_path_cap) return;
        @memcpy(path[self.current_path_len..][0..idx_str.len], idx_str);
        self.current_path_len = needed;
    }

    fn recordDiff(self: *CompareState, diff_type: DiffType) void {
        if (self.diff_count >= MAX_DIFFS) return;
        const path = self.current_path orelse return;
        const path_buf = self.path_buffer orelse return;

        // Copy current path to path buffer
        const path_len = self.current_path_len;
        if (self.path_buffer_len + path_len > self.path_buffer_cap) return;

        @memcpy(path_buf[self.path_buffer_len..][0..path_len], path[0..path_len]);

        self.diffs[self.diff_count] = .{
            .path_offset = self.path_buffer_len,
            .path_len = path_len,
            .diff_type = diff_type,
        };
        self.diff_count += 1;
        self.path_buffer_len += path_len;
    }

    // --- Accessors ---

    pub fn getDiffCount(self: *const CompareState) u32 {
        return self.diff_count;
    }

    pub fn getDiffPathPtr(self: *const CompareState, index: u32) [*]const u8 {
        if (index >= self.diff_count) return @ptrFromInt(1);
        const entry = self.diffs[index];
        const buf = self.path_buffer orelse return @ptrFromInt(1);
        return buf + entry.path_offset;
    }

    pub fn getDiffPathLen(self: *const CompareState, index: u32) u32 {
        if (index >= self.diff_count) return 0;
        return self.diffs[index].path_len;
    }

    pub fn getDiffType(self: *const CompareState, index: u32) u8 {
        if (index >= self.diff_count) return 0;
        return @intFromEnum(self.diffs[index].diff_type);
    }
};

// --- Helpers ---

/// Classify token tag into a broad JSON type for type_changed detection
fn classifyType(tag: TokenTag) u8 {
    return switch (tag) {
        .null_val => 0,
        .true_val, .false_val => 1,
        .number => 2,
        .string => 3,
        .object_start => 4,
        .array_start => 5,
        else => 255,
    };
}

fn strEqual(a_ptr: [*]const u8, a_len: u32, b_ptr: [*]const u8, b_len: u32) bool {
    if (a_len != b_len) return false;
    if (a_len == 0) return true;
    return simd.eql(a_ptr, b_ptr, a_len);
}
