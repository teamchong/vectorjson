/// Polyfill for std.BoundedArray removed in Zig 0.15
const std = @import("std");

pub fn BoundedArray(comptime T: type, comptime cap: usize) type {
    return struct {
        const Self = @This();

        buffer: [cap]T = undefined,
        len: usize = 0,

        pub fn init(initial_len: usize) error{Overflow}!Self {
            if (initial_len > cap) return error.Overflow;
            var self: Self = .{};
            self.len = initial_len;
            return self;
        }

        pub fn fromSlice(src: []const T) error{Overflow}!Self {
            if (src.len > cap) return error.Overflow;
            var self: Self = .{};
            @memcpy(self.buffer[0..src.len], src);
            self.len = src.len;
            return self;
        }

        pub fn slice(self: anytype) switch (@TypeOf(self)) {
            *const Self => []const T,
            *Self => []T,
            else => @compileError("expected pointer to BoundedArray"),
        } {
            const buf_ptr = if (@TypeOf(self) == *Self) &self.buffer else &self.buffer;
            return buf_ptr[0..self.len];
        }

        pub fn get(self: Self, i: usize) T {
            return self.buffer[i];
        }

        pub fn capacity(self: Self) usize {
            _ = self;
            return cap;
        }

        pub fn append(self: *Self, item: T) error{Overflow}!void {
            if (self.len >= cap) return error.Overflow;
            self.buffer[self.len] = item;
            self.len += 1;
        }

        pub fn appendAssumeCapacity(self: *Self, item: T) void {
            self.buffer[self.len] = item;
            self.len += 1;
        }

        pub fn appendSliceAssumeCapacity(self: *Self, items: []const T) void {
            @memcpy(self.buffer[self.len..][0..items.len], items);
            self.len += items.len;
        }

        pub fn resize(self: *Self, new_len: usize) error{Overflow}!void {
            if (new_len > cap) return error.Overflow;
            self.len = new_len;
        }
    };
}
