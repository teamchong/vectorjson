const std = @import("std");
const builtin = @import("builtin");
const types = @import("types.zig");
const cpu = builtin.cpu;
const simd = std.simd;
const umask = types.umask;
const vector = types.vector;
const Vector = types.Vector;

// --- WASM SIMD128 intrinsics via LLVM builtins ---
// These map directly to single WASM SIMD instructions.
const wasm = struct {
    /// i8x16.swizzle — runtime vector table lookup (0 for out-of-range indices)
    extern fn @"llvm.wasm.swizzle"(@Vector(16, u8), @Vector(16, u8)) @Vector(16, u8);
    /// i16x8.narrow_i32x4_u — pack two i32x4 into one u16x8 with unsigned saturation
    extern fn @"llvm.wasm.narrow.unsigned.v8i16.v4i32"(@Vector(4, i32), @Vector(4, i32)) @Vector(8, u16);
};

pub inline fn clmul(quotes_mask: umask) umask {
    // No CLMUL instruction in WASM SIMD — scalar prefix-XOR for all non-x86 targets.
    switch (builtin.cpu.arch) {
        .x86_64 => {
            const ones: @Vector(16, u8) = @splat(0xFF);
            return asm (
                \\vpclmulqdq $0, %[ones], %[quotes], %[ret]
                : [ret] "=v" (-> umask),
                : [ones] "v" (ones),
                  [quotes] "v" (quotes_mask),
            );
        },
        else => {
            var bitmask = quotes_mask;
            bitmask ^= bitmask << 1;
            bitmask ^= bitmask << 2;
            bitmask ^= bitmask << 4;
            bitmask ^= bitmask << 8;
            bitmask ^= bitmask << 16;
            bitmask ^= bitmask << 32;
            return bitmask;
        },
    }
}

pub inline fn lookupTable(table: vector, nibbles: vector) vector {
    switch (cpu.arch) {
        .x86_64 => {
            return asm (
                \\vpshufb %[nibbles], %[table], %[ret]
                : [ret] "=v" (-> vector),
                : [table] "v" (table),
                  [nibbles] "v" (nibbles),
            );
        },
        .aarch64 => {
            return asm (
                \\tbl %[ret].16b, {%[table].16b}, %[nibbles].16b
                : [ret] "=w" (-> vector),
                : [table] "w" (table),
                  [nibbles] "w" (nibbles),
            );
        },
        .wasm32 => {
            // i8x16.swizzle: result[i] = if indices[i] >= 16 then 0 else table[indices[i]]
            // vpshufb semantics: if nibbles[i] & 0x80 != 0 → 0, else table[nibbles[i] & 0x0F]
            // Compatible: simdjson always passes nibbles masked to 0x0F or with high bit set.
            return wasm.@"llvm.wasm.swizzle"(table, nibbles);
        },
        else => @compileError("Intrinsic not implemented for this target"),
    }
}

// Pack two i32x4 vectors into one u16x8 with unsigned saturation.
pub inline fn pack(vec1: @Vector(4, i32), vec2: @Vector(4, i32)) @Vector(8, u16) {
    switch (cpu.arch) {
        .x86_64 => {
            return asm (
                \\vpackusdw %[vec1], %[vec2], %[ret]
                : [ret] "=v" (-> @Vector(8, u16)),
                : [vec1] "v" (vec1),
                  [vec2] "v" (vec2),
            );
        },
        .wasm32 => {
            // i16x8.narrow_i32x4_u — single WASM SIMD instruction
            return wasm.@"llvm.wasm.narrow.unsigned.v8i16.v4i32"(vec2, vec1);
        },
        else => {
            // Portable fallback for aarch64 etc.
            const zero: @Vector(4, i32) = @splat(0);
            const max_u16: @Vector(4, i32) = @splat(65535);
            const clamped1 = @min(@max(vec2, zero), max_u16);
            const clamped2 = @min(@max(vec1, zero), max_u16);
            const t1: @Vector(4, u16) = @truncate(@as(@Vector(4, u32), @bitCast(clamped1)));
            const t2: @Vector(4, u16) = @truncate(@as(@Vector(4, u32), @bitCast(clamped2)));
            return @shuffle(u16, t1, t2, .{ 0, 1, 2, 3, -1, -2, -3, -4 });
        },
    }
}

// Multiply unsigned bytes by signed bytes, pairwise horizontal add with saturation → i16x8.
// x86_64: vpmaddubsw; wasm32: widen + multiply + add (LLVM auto-vectorizes)
pub inline fn mulSaturatingAdd(vec1: @Vector(16, u8), vec2: @Vector(16, u8)) @Vector(8, u16) {
    switch (builtin.cpu.arch) {
        .x86_64 => {
            return asm (
                \\vpmaddubsw %[vec1], %[vec2], %[ret]
                : [ret] "=v" (-> @Vector(8, u16)),
                : [vec1] "v" (vec1),
                  [vec2] "v" (vec2),
            );
        },
        .wasm32 => {
            // WASM SIMD has no single instruction for this.
            // Use vector widening ops that LLVM lowers to WASM SIMD extend + multiply + add.
            const v1_even: @Vector(8, u16) = @intCast(deinterleave(0, vec1));
            const v1_odd: @Vector(8, u16) = @intCast(deinterleave(1, vec1));
            const v2_even: @Vector(8, i16) = @bitCast(@as(@Vector(8, u16), @intCast(deinterleave(0, vec2))));
            const v2_odd: @Vector(8, i16) = @bitCast(@as(@Vector(8, u16), @intCast(deinterleave(1, vec2))));

            const prod_even: @Vector(8, i16) = @bitCast(v1_even *% @as(@Vector(8, u16), @bitCast(v2_even)));
            const prod_odd: @Vector(8, i16) = @bitCast(v1_odd *% @as(@Vector(8, u16), @bitCast(v2_odd)));
            const sum = prod_even +| prod_odd; // saturating add
            return @bitCast(sum);
        },
        else => {
            var result: @Vector(8, u16) = @splat(0);
            const v1_arr: [16]u8 = vec1;
            const v2_arr: [16]u8 = vec2;
            inline for (0..8) |i| {
                const a: i16 = @as(i16, @intCast(v2_arr[2 * i])) * @as(i16, @intCast(@as(i8, @bitCast(v1_arr[2 * i]))));
                const b: i16 = @as(i16, @intCast(v2_arr[2 * i + 1])) * @as(i16, @intCast(@as(i8, @bitCast(v1_arr[2 * i + 1]))));
                const sum = @as(i32, a) + @as(i32, b);
                const clamped = std.math.clamp(sum, std.math.minInt(i16), std.math.maxInt(i16));
                result[i] = @bitCast(@as(i16, @intCast(clamped)));
            }
            return result;
        },
    }
}

// Multiply i16 pairs and horizontal add → i32x4.
// x86_64: vpmaddwd; wasm32: widen + multiply + add
pub inline fn mulWrappingAdd(vec1: @Vector(8, i16), vec2: @Vector(8, i16)) @Vector(4, i32) {
    switch (builtin.cpu.arch) {
        .x86_64 => {
            return asm (
                \\vpmaddwd %[vec1], %[vec2], %[ret]
                : [ret] "=v" (-> @Vector(4, i32)),
                : [vec1] "v" (vec1),
                  [vec2] "v" (vec2),
            );
        },
        .wasm32 => {
            // Widen to i32, multiply, add adjacent pairs using vector ops
            const v1_even = deinterleaveI16(0, vec1);
            const v1_odd = deinterleaveI16(1, vec1);
            const v2_even = deinterleaveI16(0, vec2);
            const v2_odd = deinterleaveI16(1, vec2);

            const w1e: @Vector(4, i32) = v1_even;
            const w1o: @Vector(4, i32) = v1_odd;
            const w2e: @Vector(4, i32) = v2_even;
            const w2o: @Vector(4, i32) = v2_odd;

            return w1e *% w2e +% w1o *% w2o;
        },
        else => {
            var result: @Vector(4, i32) = @splat(0);
            const v1_arr: [8]i16 = vec1;
            const v2_arr: [8]i16 = vec2;
            inline for (0..4) |i| {
                const a: i32 = @as(i32, v1_arr[2 * i]) * @as(i32, v2_arr[2 * i]);
                const b: i32 = @as(i32, v1_arr[2 * i + 1]) * @as(i32, v2_arr[2 * i + 1]);
                result[i] = a +% b;
            }
            return result;
        },
    }
}

// --- Deinterleave helpers for WASM SIMD vector widening ---

inline fn deinterleave(comptime phase: u1, vec: @Vector(16, u8)) @Vector(8, u8) {
    // Extract even (phase=0) or odd (phase=1) bytes
    const indices: @Vector(8, i32) = .{ phase, 2 + phase, 4 + phase, 6 + phase, 8 + phase, 10 + phase, 12 + phase, 14 + phase };
    return @shuffle(u8, vec, undefined, indices);
}

inline fn deinterleaveI16(comptime phase: u1, vec: @Vector(8, i16)) @Vector(4, i16) {
    const indices: @Vector(4, i32) = .{ phase, 2 + phase, 4 + phase, 6 + phase };
    return @shuffle(i16, vec, undefined, indices);
}
