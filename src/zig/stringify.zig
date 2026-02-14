///! VectorJSON Stringify Engine
///!
///! Builds JSON text in linear memory from token-by-token calls.
///! JS walks the object tree, calls Zig exports for each value,
///! Zig handles escaping, number formatting, comma/colon insertion,
///! and buffer management. Result read out as a flat byte slice.

const std = @import("std");
const simd = @import("simd.zig");

/// Comptime-generated escape lookup table.
/// Each byte 0-255 maps to an EscapeAction describing how to escape it.
const EscapeAction = enum(u8) {
    none = 0,
    hex = 1, // \u00XX
    quote = '"',
    backslash = '\\',
    newline = 'n',
    cr = 'r',
    tab = 't',
    backspace = 'b',
    formfeed = 'f',
};

const escape_lut: [256]EscapeAction = blk: {
    var lut: [256]EscapeAction = .{.none} ** 256;
    for (0..0x20) |i| {
        lut[i] = .hex;
    }
    lut['"'] = .quote;
    lut['\\'] = .backslash;
    lut['\n'] = .newline;
    lut['\r'] = .cr;
    lut['\t'] = .tab;
    lut[0x08] = .backspace;
    lut[0x0C] = .formfeed;
    break :blk lut;
};

const MAX_DEPTH = 256;
const MAX_OUTPUT_SIZE = 64 * 1024 * 1024; // 64 MB

/// Per-depth state for comma tracking
const DepthEntry = struct {
    element_count: u32 = 0,
    container_type: u8 = 0, // '{' or '['
};

pub const Stringifier = struct {
    // Output buffer
    buffer: ?[*]u8 = null,
    buffer_len: u32 = 0,
    buffer_cap: u32 = 0,

    // Depth tracking for automatic comma insertion
    depth_stack: [MAX_DEPTH]DepthEntry = undefined,
    depth: u32 = 0,

    // After writing a key, suppress the next comma (value follows key directly)
    after_key: bool = false,

    // Error state
    has_error: bool = false,

    // Allocator
    allocator: std.mem.Allocator = undefined,

    pub fn init(self: *Stringifier, allocator: std.mem.Allocator) void {
        self.* = .{};
        self.allocator = allocator;

        const initial_cap: u32 = 4096;
        const buf = allocator.alloc(u8, initial_cap) catch {
            self.has_error = true;
            return;
        };
        self.buffer = buf.ptr;
        self.buffer_cap = initial_cap;
    }

    pub fn deinit(self: *Stringifier) void {
        if (self.buffer) |buf| {
            self.allocator.free(buf[0..self.buffer_cap]);
        }
        self.* = .{};
    }

    // --- Write primitives ---

    pub fn writeNull(self: *Stringifier) void {
        self.maybeComma();
        self.appendSlice("null");
        self.incrementCount();
    }

    pub fn writeBool(self: *Stringifier, val: i32) void {
        self.maybeComma();
        if (val != 0) {
            self.appendSlice("true");
        } else {
            self.appendSlice("false");
        }
        self.incrementCount();
    }

    pub fn writeNumber(self: *Stringifier, val: f64) void {
        self.maybeComma();

        // Handle special values (NaN, Infinity → "null" per JSON.stringify)
        if (std.math.isNan(val) or std.math.isInf(val)) {
            self.appendSlice("null");
            self.incrementCount();
            return;
        }

        // Check if it's an integer (no fractional part and in safe integer range)
        const as_int: i64 = @intFromFloat(val);
        const back: f64 = @floatFromInt(as_int);
        if (val == back and @abs(val) < 9007199254740992.0) {
            // Write as integer
            var tmp: [24]u8 = undefined;
            const written = std.fmt.bufPrint(&tmp, "{d}", .{as_int}) catch {
                self.has_error = true;
                return;
            };
            self.appendSlice(written);
        } else {
            // Write as float with enough precision
            var tmp: [32]u8 = undefined;
            const written = formatFloat(&tmp, val);
            self.appendSlice(written);
        }
        self.incrementCount();
    }

    pub fn writeString(self: *Stringifier, ptr: [*]const u8, len: u32) void {
        self.maybeComma();
        self.writeEscapedString(ptr, len);
        self.incrementCount();
    }

    pub fn writeKey(self: *Stringifier, ptr: [*]const u8, len: u32) void {
        self.maybeComma();
        self.writeEscapedString(ptr, len);
        self.appendByte(':');
        self.incrementCount();
        self.after_key = true; // suppress comma before the following value
    }

    pub fn writeObjectStart(self: *Stringifier) void {
        self.maybeComma();
        self.appendByte('{');
        if (self.depth < MAX_DEPTH) {
            self.depth_stack[self.depth] = .{
                .element_count = 0,
                .container_type = '{',
            };
            self.depth += 1;
        }
    }

    pub fn writeObjectEnd(self: *Stringifier) void {
        if (self.depth > 0) self.depth -= 1;
        self.appendByte('}');
        self.incrementCount();
    }

    pub fn writeArrayStart(self: *Stringifier) void {
        self.maybeComma();
        self.appendByte('[');
        if (self.depth < MAX_DEPTH) {
            self.depth_stack[self.depth] = .{
                .element_count = 0,
                .container_type = '[',
            };
            self.depth += 1;
        }
    }

    pub fn writeArrayEnd(self: *Stringifier) void {
        if (self.depth > 0) self.depth -= 1;
        self.appendByte(']');
        self.incrementCount();
    }

    // --- Result access ---

    pub fn getResultPtr(self: *Stringifier) [*]const u8 {
        return self.buffer orelse @as([*]const u8, @ptrFromInt(1));
    }

    pub fn getResultLen(self: *Stringifier) u32 {
        return self.buffer_len;
    }

    // --- Internal helpers ---

    fn maybeComma(self: *Stringifier) void {
        if (self.after_key) {
            self.after_key = false;
            return; // value follows key — no comma needed
        }
        if (self.depth > 0) {
            const entry = &self.depth_stack[self.depth - 1];
            if (entry.element_count > 0) {
                self.appendByte(',');
            }
        }
    }

    fn incrementCount(self: *Stringifier) void {
        if (self.depth > 0) {
            self.depth_stack[self.depth - 1].element_count += 1;
        }
    }

    fn writeEscapedString(self: *Stringifier, ptr: [*]const u8, len: u32) void {
        self.appendByte('"');
        const data = ptr[0..len];
        var i: u32 = 0;

        // SIMD: scan 16 bytes at a time for characters needing escaping
        while (i + 16 <= len) {
            const chunk: @Vector(16, u8) = data[i..][0..16].*;
            if (simd.anyMatchOrBelow(&.{ '"', '\\' }, 0x20, chunk)) {
                // At least one byte needs escaping — scalar fallback for this chunk
                for (data[i..][0..16]) |c| {
                    self.writeEscapedByte(c);
                }
            } else {
                // All 16 bytes are safe — bulk copy
                self.appendSlice(data[i..][0..16]);
            }
            i += 16;
        }

        // Scalar tail
        while (i < len) : (i += 1) {
            self.writeEscapedByte(data[i]);
        }

        self.appendByte('"');
    }

    /// Write a single byte with JSON escaping using comptime LUT
    fn writeEscapedByte(self: *Stringifier, c: u8) void {
        const action = escape_lut[c];
        switch (action) {
            .none => self.appendByte(c),
            .hex => {
                self.appendSlice("\\u00");
                self.appendHexNibble(c >> 4);
                self.appendHexNibble(c & 0x0F);
            },
            else => {
                self.appendByte('\\');
                self.appendByte(@intFromEnum(action));
            },
        }
    }

    fn appendHexNibble(self: *Stringifier, nibble: u8) void {
        const hex = "0123456789abcdef";
        self.appendByte(hex[nibble & 0x0F]);
    }

    fn appendByte(self: *Stringifier, byte: u8) void {
        if (self.has_error) return;
        if (self.buffer_len >= self.buffer_cap) {
            self.growBuffer(self.buffer_len + 1) catch {
                self.has_error = true;
                return;
            };
        }
        const buf = self.buffer orelse return;
        buf[self.buffer_len] = byte;
        self.buffer_len += 1;
    }

    fn appendSlice(self: *Stringifier, data: []const u8) void {
        if (self.has_error) return;
        const needed = self.buffer_len + @as(u32, @intCast(data.len));
        if (needed > self.buffer_cap) {
            self.growBuffer(needed) catch {
                self.has_error = true;
                return;
            };
        }
        const buf = self.buffer orelse return;
        @memcpy(buf[self.buffer_len..][0..data.len], data);
        self.buffer_len += @intCast(data.len);
    }

    fn growBuffer(self: *Stringifier, needed: u32) !void {
        var new_cap = self.buffer_cap;
        while (new_cap < needed) {
            new_cap = new_cap *| 2;
            if (new_cap > MAX_OUTPUT_SIZE) new_cap = MAX_OUTPUT_SIZE;
        }
        if (needed > MAX_OUTPUT_SIZE) return error.OutOfMemory;
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

/// Format an f64 as a JSON-compatible decimal string.
/// Returns a slice of `buf` containing the formatted number.
fn formatFloat(buf: *[32]u8, val: f64) []const u8 {
    // Use Zig's float formatting
    var fbs = std.io.fixedBufferStream(buf);
    std.fmt.format(fbs.writer(), "{d}", .{val}) catch {
        // Fallback: write "0"
        buf[0] = '0';
        return buf[0..1];
    };
    const written = fbs.getWritten();

    // Ensure the output has a decimal point or is in scientific notation
    // to distinguish from integers (JSON spec doesn't require this, but
    // it matches JSON.stringify behavior for non-integer floats)
    var has_dot = false;
    var has_e = false;
    for (written) |c| {
        if (c == '.') has_dot = true;
        if (c == 'e' or c == 'E') has_e = true;
    }

    if (!has_dot and !has_e) {
        // It looks like an integer — that's fine for JSON
        // (the value was already checked for integerness above)
    }

    return written;
}
