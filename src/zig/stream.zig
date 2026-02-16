///! VectorJSON Streaming Parser
///!
///! Lightweight streaming layer that accumulates JSON chunks in linear memory
///! and tracks JSON structural completeness (brackets, braces, string state).
///!
///! Design: each byte is scanned once for structure tracking (O(n) total).
///! Actual parsing via zimdjson's FullParser happens lazily when values are queried.

const std = @import("std");
const simd = @import("simd.zig");

/// Feed status codes returned to JS
pub const FeedStatus = enum(i32) {
    incomplete = 0,
    complete = 1,
    err = 2,
    end_early = 3,
};

/// Maximum total buffer size (64 MB)
const MAX_BUFFER_SIZE = 64 * 1024 * 1024;

pub const StreamState = struct {
    // --- Accumulation buffer ---
    buffer: ?[*]u8 = null,
    buffer_len: u32 = 0,
    buffer_cap: u32 = 0,

    // --- Structural tracking ---
    depth: i32 = 0,
    in_string: bool = false,
    escape_next: bool = false,
    scan_offset: u32 = 0,

    // --- Status ---
    status: FeedStatus = .incomplete,
    remaining_offset: u32 = 0,

    // Root value tracking
    root_value_started: bool = false,
    root_value_completed: bool = false,
    pending_scalar_root: bool = false,
    root_is_string: bool = false,

    // --- Allocator ---
    allocator: std.mem.Allocator = undefined,

    pub fn init(allocator: std.mem.Allocator) !*StreamState {
        const self = try allocator.create(StreamState);
        self.* = .{};
        self.allocator = allocator;

        const initial_cap: u32 = 4096;
        const buf = try allocator.alloc(u8, initial_cap);
        self.buffer = buf.ptr;
        self.buffer_cap = initial_cap;

        return self;
    }

    pub fn deinit(self: *StreamState) void {
        if (self.buffer) |buf| {
            self.allocator.free(buf[0..self.buffer_cap]);
        }
        self.allocator.destroy(self);
    }

    /// Append a chunk of bytes to the accumulation buffer
    pub fn feed(self: *StreamState, data: [*]const u8, len: u32) FeedStatus {
        if (self.status == .complete or self.status == .err) {
            return self.status;
        }

        const new_len = self.buffer_len + len;
        if (new_len > MAX_BUFFER_SIZE) {
            self.status = .err;
            return .err;
        }
        if (new_len > self.buffer_cap) {
            self.growBuffer(new_len) catch {
                self.status = .err;
                return .err;
            };
        }

        const buf = self.buffer orelse {
            self.status = .err;
            return .err;
        };
        @memcpy(buf[self.buffer_len..][0..len], data[0..len]);
        self.buffer_len = new_len;

        self.scanStructure();
        return self.status;
    }

    fn scanStructure(self: *StreamState) void {
        const buf = self.buffer orelse return;
        var i = self.scan_offset;

        while (i < self.buffer_len) {
            // Stop scanning once root is complete
            if (self.root_value_completed) break;

            // SIMD fast-skip for string content: scan 16 bytes at a time for '"' or '\'
            if (self.in_string and !self.escape_next) {
                while (i + 16 <= self.buffer_len) {
                    const chunk: @Vector(16, u8) = (buf + i)[0..16].*;
                    if (simd.anyMatch(&.{ '"', '\\' }, chunk)) break;
                    i += 16;
                }
                if (i >= self.buffer_len) break;
            }

            const c = buf[i];

            if (self.escape_next) {
                self.escape_next = false;
                i += 1;
                continue;
            }

            if (self.in_string) {
                if (c == '\\') {
                    self.escape_next = true;
                } else if (c == '"') {
                    self.in_string = false;
                    if (self.depth == 0 and self.root_is_string) {
                        self.markRootComplete(i + 1);
                    }
                }
                i += 1;
                continue;
            }

            switch (c) {
                '"' => {
                    self.in_string = true;
                    if (self.depth == 0 and !self.root_value_started) {
                        self.root_value_started = true;
                        self.root_is_string = true;
                    }
                },
                '{', '[' => {
                    if (self.depth == 0 and !self.root_value_started) {
                        self.root_value_started = true;
                    }
                    self.depth += 1;
                },
                '}', ']' => {
                    self.depth -= 1;
                    if (self.depth == 0) {
                        self.markRootComplete(i + 1);
                    }
                    if (self.depth < 0) {
                        self.status = .err;
                        self.scan_offset = i + 1;
                        return;
                    }
                },
                't', 'f', 'n', '-', '0'...'9' => {
                    if (self.depth == 0 and !self.root_value_started) {
                        self.root_value_started = true;
                        self.pending_scalar_root = true;
                    }
                },
                ' ', '\t', '\n', '\r' => {
                    if (self.depth == 0 and self.pending_scalar_root) {
                        self.markRootComplete(i);
                    }
                },
                else => {},
            }
            i += 1;
        }

        self.scan_offset = i;

        // End of buffer: if we have a pending scalar at root, mark complete
        if (!self.root_value_completed and self.depth == 0 and !self.in_string and self.pending_scalar_root) {
            self.markRootComplete(self.buffer_len);
        }
    }

    fn markRootComplete(self: *StreamState, end_offset: u32) void {
        self.pending_scalar_root = false;
        self.root_value_completed = true;

        const buf = self.buffer orelse return;
        var remaining = end_offset;

        // SIMD: skip whitespace 16 bytes at a time
        while (remaining + 16 <= self.buffer_len) {
            const chunk: @Vector(16, u8) = (buf + remaining)[0..16].*;
            if (!simd.allMatch(&.{ ' ', '\t', '\n', '\r' }, chunk)) break;
            remaining += 16;
        }

        // Scalar tail
        while (remaining < self.buffer_len) : (remaining += 1) {
            const c = buf[remaining];
            if (c != ' ' and c != '\t' and c != '\n' and c != '\r') {
                self.status = .end_early;
                self.remaining_offset = remaining;
                return;
            }
        }

        self.status = .complete;
        self.remaining_offset = end_offset;
    }

    pub fn getBufferPtr(self: *StreamState) [*]const u8 {
        return self.buffer orelse @ptrFromInt(1);
    }

    /// Get the length of the complete JSON value (excluding trailing data).
    /// For "complete" status, this is the full buffer length.
    /// For "end_early", this is the offset where the first value ends.
    pub fn getValueLen(self: *StreamState) u32 {
        return if (self.status == .end_early) self.remaining_offset else self.buffer_len;
    }

    pub fn getRemaining(self: *StreamState) struct { ptr: [*]const u8, len: u32 } {
        const buf = self.buffer orelse return .{ .ptr = @ptrFromInt(1), .len = 0 };
        if (self.remaining_offset >= self.buffer_len) {
            return .{ .ptr = @ptrFromInt(1), .len = 0 };
        }
        return .{
            .ptr = buf + self.remaining_offset,
            .len = self.buffer_len - self.remaining_offset,
        };
    }

    fn growBuffer(self: *StreamState, needed: u32) !void {
        var new_cap = self.buffer_cap;
        while (new_cap < needed) {
            new_cap = new_cap *| 2;
            if (new_cap > MAX_BUFFER_SIZE) new_cap = MAX_BUFFER_SIZE;
        }
        if (self.buffer) |old_buf| {
            const old_slice = old_buf[0..self.buffer_cap];
            if (self.allocator.resize(old_slice, new_cap)) {
                self.buffer_cap = new_cap;
                return;
            }
            const new_buf = try self.allocator.alloc(u8, new_cap);
            @memcpy(new_buf[0..self.buffer_len], old_buf[0..self.buffer_len]);
            self.allocator.free(old_slice);
            self.buffer = new_buf.ptr;
            self.buffer_cap = new_cap;
        }
    }
};
