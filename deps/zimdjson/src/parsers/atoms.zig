const std = @import("std");
const builtin = @import("builtin");
const common = @import("../common.zig");
const types = @import("../types.zig");
const tokens = @import("../tokens.zig");
const Error = types.ParseError;
const readInt = std.mem.readInt;
const native_endian = builtin.cpu.arch.endian();

pub inline fn checkTrue(ptr: [*]const u8) Error!void {
    const chunk = ptr[0..5];
    const dword_true = readInt(u32, "true", native_endian);
    const dword_atom = readInt(u32, chunk[0..4], native_endian);
    const not_struct_white = common.tables.is_structural_or_whitespace_negated;
    if ((dword_true ^ dword_atom | @intFromBool(not_struct_white[chunk[4]])) != 0)
        return error.IncorrectType;
}

pub inline fn checkFalse(ptr: [*]const u8) Error!void {
    const chunk = ptr[0..6];
    const dword_alse = readInt(u32, "alse", native_endian);
    const dword_atom = readInt(u32, chunk[1..][0..4], native_endian);
    const not_struct_white = common.tables.is_structural_or_whitespace_negated;
    if ((dword_alse ^ dword_atom | @intFromBool(not_struct_white[chunk[5]])) != 0)
        return error.IncorrectType;
}

pub inline fn checkNull(ptr: [*]const u8) Error!void {
    const chunk = ptr[0..5];
    const dword_null = readInt(u32, "null", native_endian);
    const dword_atom = readInt(u32, chunk[0..4], native_endian);
    const not_struct_white = common.tables.is_structural_or_whitespace_negated;
    if ((dword_null ^ dword_atom | @intFromBool(not_struct_white[chunk[4]])) != 0)
        return error.IncorrectType;
}

/// Check "Infinity" literal (8 chars + structural/whitespace after).
pub inline fn checkInfinity(ptr: [*]const u8) Error!void {
    const not_struct_white = common.tables.is_structural_or_whitespace_negated;
    // Check "Infi" as u32
    const dword_infi = readInt(u32, "Infi", native_endian);
    const dword_atom1 = readInt(u32, ptr[0..4], native_endian);
    if (dword_infi ^ dword_atom1 != 0) return error.IncorrectType;
    // Check "nity" as u32
    const dword_nity = readInt(u32, "nity", native_endian);
    const dword_atom2 = readInt(u32, ptr[4..8], native_endian);
    if ((dword_nity ^ dword_atom2 | @intFromBool(not_struct_white[ptr[8]])) != 0)
        return error.IncorrectType;
}

/// Check "NaN" literal (3 chars + structural/whitespace after).
pub inline fn checkNaN(ptr: [*]const u8) Error!void {
    const not_struct_white = common.tables.is_structural_or_whitespace_negated;
    if (ptr[0] != 'N' or ptr[1] != 'a' or ptr[2] != 'N' or not_struct_white[ptr[3]])
        return error.IncorrectType;
}
