//! Trimmed zimdjson: only the DOM tape parser + SIMD indexer.
//! On-demand parser, streaming, schema maps, and tracing removed.

const std = @import("std");
const types = @import("types.zig");

pub const dom = @import("dom.zig");

pub const alignment = types.Aligned(true).alignment;
pub const padding = std.simd.suggestVectorLength(u8) orelse @compileError("No SIMD features available");
