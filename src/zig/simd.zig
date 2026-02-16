///! Shared SIMD utilities for VectorJSON.
///!
///! Uses comptime generics + `inline for` to generate optimal
///! WASM SIMD128 instructions at compile time. Each call site gets
///! a specialized version with zero loop overhead — the compiler
///! unrolls comparisons into a fixed sequence of v128 instructions.

/// SIMD-accelerated memory equality: compares 16 bytes at a time.
pub fn eql(a: [*]const u8, b: [*]const u8, len: u32) bool {
    var i: u32 = 0;
    while (i + 16 <= len) {
        const va: @Vector(16, u8) = (a + i)[0..16].*;
        const vb: @Vector(16, u8) = (b + i)[0..16].*;
        if (vecAnySet(va != vb)) return false;
        i += 16;
    }
    while (i < len) : (i += 1) {
        if (a[i] != b[i]) return false;
    }
    return true;
}

/// Does any byte in `chunk` match any of the comptime-known `targets`?
/// `inline for` unrolls to N parallel `i8x16.eq` + `v128.or` chains.
pub fn anyMatch(comptime targets: []const u8, chunk: @Vector(16, u8)) bool {
    var m: @Vector(16, bool) = @splat(false);
    inline for (targets) |t| {
        m |= chunk == @as(@Vector(16, u8), @splat(t));
    }
    return vecAnySet(m);
}

/// Do ALL bytes match one of the comptime-known `targets`?
/// Useful for checking if a 16-byte block is entirely whitespace.
pub fn allMatch(comptime targets: []const u8, chunk: @Vector(16, u8)) bool {
    var m: @Vector(16, bool) = @splat(false);
    inline for (targets) |t| {
        m |= chunk == @as(@Vector(16, u8), @splat(t));
    }
    return vecAllSet(m);
}

// --- Internal helpers ---

/// Reduce a bool vector: true if ANY lane is set.
/// Compiles to WASM `v128.any_true`.
inline fn vecAnySet(mask: anytype) bool {
    return @reduce(.Or, mask);
}

/// Reduce a bool vector: true if ALL lanes are set.
/// Compiles to WASM `i8x16.all_true`.
inline fn vecAllSet(mask: anytype) bool {
    return @reduce(.And, mask);
}
