const std = @import("std");
const builtin = @import("builtin");
const common = @import("../common.zig");
const types = @import("../types.zig");
const tokens = @import("../tokens.zig");
const vector = types.vector;
const Vector = types.Vector;
const Predicate = types.Predicate;

pub const SkipResult = struct {
    src_end: [*]const u8,
    has_escapes: bool,
};

/// SIMD scan for closing quote. No copy, no decode. Just find the end.
/// Returns pointer to the closing quote character and whether any backslash
/// escapes were encountered (so JS can decide whether JSON.parse is needed).
pub inline fn skipString(src: [*]const u8) SkipResult {
    var read = src[1..]; // skip opening quote
    var has_escapes = false;
    while (true) {
        const chunk = read[0..Vector.bytes_len].*;
        const slash = Predicate.pack(Vector.slash == chunk);
        const quote = Predicate.pack(Vector.quote == chunk);

        // Quote found before any backslash → string ends here
        if (((slash -% 1) & quote) != 0) {
            return .{
                .src_end = read + @as(u8, @ctz(quote)),
                .has_escapes = has_escapes,
            };
        }

        // Backslash found before any quote → skip escape sequences
        if (((quote -% 1) & slash) != 0) {
            has_escapes = true;
            read += @as(u8, @ctz(slash));
            while (read[0] == '\\') : (read += 2) {
                if (read[1] == 'u') read += 4; // \uXXXX = 6 total
            }
        } else {
            read += Vector.bytes_len;
        }
    }
}
