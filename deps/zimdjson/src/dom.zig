//! Document Object Model (DOM) parser.
//!
//! The entire document is parsed, validated, and stored in memory as a tree-like
//! structure. Only after the process is complete can the programmer access and
//! navigate the content.
//!
//! ## Lifetimes
//! During parsing, the input must remain unmodified. Once parsing finishes, the input
//! can safely be discarded.
//!
//! A parser instance manages one document at a time and owns all allocated resources.
//! For optimal performance, it should be reused over several documents when possible.
//! If there is a need to have multiple documents in memory, multiple parser instances
//! should be used.

const std = @import("std");
const builtin = @import("builtin");
const common = @import("common.zig");
const types = @import("types.zig");
const tokens = @import("tokens.zig");
const Allocator = std.mem.Allocator;
const Number = types.Number;
const assert = std.debug.assert;
const native_endian = builtin.cpu.arch.endian();

/// The available options for parsing.
pub const FullOptions = struct {
    pub const default: @This() = .{};

    /// Use this literal if parsing is exclusively done from a reader.
    pub const reader_only: @This() = .{ .aligned = true, .assume_padding = true };

    /// This option forces the input type to have a [`zimdjson.alignment`](#zimdjson.alignment).
    /// When enabled, aligned SIMD vector instruction will be used during parsing, which may
    /// improve performance.
    ///
    /// It is useful when parsing from a reader, as the data is always loaded with alignment.
    ///
    /// When parsing from a slice, you must ensure it is aligned or a compiler error will
    /// occur.
    aligned: bool = false,

    /// This option assumes the input is padded with [`zimdjson.padding`](#zimdjson.padding).
    /// When enabled, there will be no bounds checking during parsing, improving performance.
    ///
    /// It is useful when parsing from a reader, as the data is always loaded with padding.
    ///
    /// When parsing from a slice, you must ensure it is padded or undefined behavior will
    /// occur.
    assume_padding: bool = false,
};

pub fn FullParser(comptime options: FullOptions) type {
    return Parser(options);
}

pub const ParseError = types.ParseError;
pub const IndexerError = @import("indexer.zig").Error;

pub fn Parser(comptime options: FullOptions) type {
    const aligned = options.aligned;

    return struct {
        const Self = @This();

        const Aligned = types.Aligned(aligned);
        const Tokens = tokens.iterator.Iterator(.{
            .aligned = aligned,
            .assume_padding = options.assume_padding,
        });

        pub const Error = Tokens.Error || ParseError || Allocator.Error;

        /// The parser supports JSON documents up to **4GiB**.
        /// If the document exceeds this limit, an `error.ExceededCapacity` is returned.
        pub const max_capacity_bound = std.math.maxInt(u32);

        document_buffer: std.ArrayListAlignedUnmanaged(u8, types.Aligned(true).mem_alignment),

        tape: Tape,

        max_capacity: usize,

        pub const init: Self = .{
            .tape = .init,
            .max_capacity = max_capacity_bound,
            .document_buffer = .empty,
        };

        /// Release all allocated memory, including the strings.
        pub fn deinit(self: *Self, allocator: Allocator) void {
            self.tape.deinit(allocator);
            self.document_buffer.deinit(allocator);
        }

        /// Set the maximum capacity of a JSON document.
        pub fn setMaximumCapacity(self: *Self, new_capacity: usize) Error!void {
            if (new_capacity > max_capacity_bound) return error.ExceededCapacity;
            self.max_capacity = new_capacity;
        }

        fn ensureTotalCapacity(self: *Self, allocator: Allocator, new_capacity: usize) Error!void {
            if (new_capacity > self.max_capacity) return error.ExceededCapacity;

            try self.tape.tokens.ensureTotalCapacity(allocator, new_capacity
                // root words
                + 2);
        }

        /// Parse a JSON document from slice. Allocated resources are owned by the parser.
        /// Input is copied into document_buffer so source-offset string references
        /// survive after the caller's buffer is reused.
        pub fn parseFromSlice(self: *Self, allocator: Allocator, document: Aligned.slice) Error!Document {
            try self.ensureTotalCapacity(allocator, document.len);

            // Copy input into document_buffer — strings now reference source offsets,
            // so the input bytes must persist for the lifetime of this parse result.
            self.document_buffer.clearRetainingCapacity();
            try self.document_buffer.ensureTotalCapacity(allocator, document.len + types.Vector.bytes_len);
            self.document_buffer.appendSliceAssumeCapacity(document);
            self.document_buffer.appendNTimesAssumeCapacity(' ', types.Vector.bytes_len);

            try self.tape.buildFromSlice(allocator, self.document_buffer.items[0..document.len]);
            return .{
                .tape = &self.tape,
                .index = 1,
            };
        }

        /// Represents a JSON document (tape pointer + root index).
        /// VectorJSON navigates the tape directly — no convenience methods needed.
        pub const Document = struct {
            tape: *const Tape,
            index: u32,
        };

        const Tape = struct {
            const State = enum(u8) {
                start = 0,
                object_begin = '{',
                object_field = 1,
                object_continue = '{' + 1,
                object_end = '}',
                array_begin = '[',
                array_value = 2,
                array_continue = '[' + 1,
                array_end = ']',
                end = 3,
            };

            const Tag = enum(u8) {
                root = 'r',
                true = 't',
                false = 'f',
                null = 'n',
                unsigned = @intFromEnum(Number.unsigned),
                signed = @intFromEnum(Number.signed),
                double = @intFromEnum(Number.double),
                string = 's',
                object_opening = '{',
                object_closing = '}',
                array_opening = '[',
                array_closing = ']',
            };

            const Word = packed struct(u64) {
                tag: Tag,
                data: packed struct {
                    ptr: u32,
                    len: u24,
                },
            };

            const Stack = struct {
                const Context = struct {
                    pub const Data = struct {
                        len: u32,
                        ptr: u32,
                    };
                    tag: Tag,
                    data: Data,
                };

                max_depth: usize = common.default_max_depth,
                multi: std.MultiArrayList(Context) = .empty,

                pub const empty: @This() = .{};

                pub fn deinit(self: *Stack, allocator: Allocator) void {
                    self.multi.deinit(allocator);
                }

                pub inline fn ensureTotalCapacity(
                    self: *Stack,
                    allocator: Allocator,
                    new_depth: usize,
                ) Error!void {
                    if (new_depth > self.max_depth) return error.ExceededDepth;
                    return self.setMaxDepth(allocator, new_depth);
                }

                pub inline fn setMaxDepth(self: *Stack, allocator: Allocator, new_depth: usize) Error!void {
                    try self.multi.setCapacity(allocator, new_depth);
                    self.max_depth = new_depth;
                }

                pub inline fn push(self: *Stack, item: Context) Error!void {
                    if (self.multi.len >= self.multi.capacity) return error.ExceededDepth;
                    assert(self.multi.capacity != 0);
                    self.multi.appendAssumeCapacity(item);
                }

                pub inline fn pop(self: *Stack) void {
                    self.multi.len -= 1;
                }

                pub inline fn len(self: Stack) usize {
                    return self.multi.len;
                }

                pub inline fn clearRetainingCapacity(self: *Stack) void {
                    self.multi.clearRetainingCapacity();
                }

                pub inline fn incrementContainerCount(self: *Stack) void {
                    assert(self.multi.capacity != 0);
                    const scope = &self.multi.items(.data)[self.multi.len - 1];
                    scope.len += 1;
                }

                pub inline fn getScopeData(self: Stack) Context.Data {
                    assert(self.multi.capacity != 0);
                    return self.multi.items(.data)[self.multi.len - 1];
                }

                pub inline fn getScopeType(self: Stack) Tag {
                    assert(self.multi.capacity != 0);
                    return self.multi.items(.tag)[self.multi.len - 1];
                }
            };

            tokens: Tokens,

            words: types.BoundedArrayList(u64, max_capacity_bound),
            stack: Stack,

            input_base_addr: usize = 0,

            words_ptr: [*]u64 = undefined,

            pub const init: Tape = .{
                .tokens = .init,
                .words = .empty,
                .stack = .empty,
            };

            pub fn deinit(self: *Tape, allocator: Allocator) void {
                self.words.deinit(allocator);
                self.stack.deinit(allocator);
                self.tokens.deinit(allocator);
            }

            pub inline fn buildFromSlice(self: *Tape, allocator: Allocator, document: Aligned.slice) Error!void {
                try self.tokens.build(allocator, document);
                try self.stack.ensureTotalCapacity(allocator, self.stack.max_depth);

                const tokens_count = self.tokens.indexes.items.len;
                // if there are only n numbers, there must be n - 1 commas plus an ending container token, so almost half of the tokens are numbers
                try self.words.ensureTotalCapacity(allocator, tokens_count + (tokens_count >> 1) + 1
                    // root words
                + 2);

                self.words.list.clearRetainingCapacity();
                self.stack.clearRetainingCapacity();
                self.input_base_addr = @intFromPtr(document.ptr);

                self.words_ptr = self.words.items().ptr;

                return self.dispatch(allocator);
            }

            pub inline fn get(self: Tape, index: u32) Word {
                return @bitCast(self.words.items().ptr[index]);
            }

            inline fn currentWord(self: Tape) u32 {
                return @intCast((@intFromPtr(self.words_ptr) - @intFromPtr(self.words.items().ptr)) / @sizeOf(Word));
            }

            inline fn advanceWord(self: *Tape, len_: usize) void {
                self.words_ptr += len_;
            }

            inline fn appendWordAssumeCapacity(self: *Tape, word: Word) void {
                self.words_ptr[0] = @bitCast(word);
                self.advanceWord(1);
            }

            inline fn appendTwoWordsAssumeCapacity(self: *Tape, words: [2]Word) void {
                const vec: @Vector(2, u64) = @bitCast(words);
                const slice: *const [2]u64 = &vec;
                @memcpy(self.words_ptr, slice);
                self.advanceWord(2);
            }

            fn dispatch(self: *Tape, allocator: Allocator) Error!void {
                _ = allocator;

                try self.stack.push(.{
                    .tag = .root,
                    .data = .{
                        .ptr = self.currentWord(),
                        .len = undefined,
                    },
                });
                self.advanceWord(1);

                state: switch (State.start) {
                    .start => {
                        const t = try self.tokens.next();
                        switch (t[0]) {
                            '{', '[' => |container_begin| {
                                if (self.tokens.peekChar() == container_begin + 2) {
                                    @branchHint(.unlikely);
                                    self.visitEmptyContainer(container_begin);
                                    continue :state .end;
                                }
                                continue :state @enumFromInt(container_begin);
                            },
                            else => {
                                try self.visitPrimitive(t);
                                continue :state .end;
                            },
                        }
                    },
                    .object_begin => {
                        try self.stack.push(.{
                            .tag = .object_opening,
                            .data = .{
                                .ptr = self.currentWord(),
                                .len = 1,
                            },
                        });

                        self.advanceWord(1);

                        continue :state .object_field;
                    },
                    .object_field => {
                        {
                            const t = try self.tokens.next();
                            if (t[0] == '"') {
                                self.visitString(t);
                            } else {
                                return error.ExpectedKey;
                            }
                        }
                        if ((try self.tokens.next())[0] == ':') {
                            const t = try self.tokens.next();
                            switch (t[0]) {
                                '{', '[' => |container_begin| {
                                    if (self.tokens.peekChar() == container_begin + 2) {
                                        self.visitEmptyContainer(container_begin);
                                        continue :state .object_continue;
                                    }
                                    continue :state @enumFromInt(container_begin);
                                },
                                else => {
                                    try self.visitPrimitive(t);
                                    continue :state .object_continue;
                                },
                            }
                        } else {
                            return error.ExpectedColon;
                        }
                    },
                    .object_continue => {
                        switch ((try self.tokens.next())[0]) {
                            ',' => {
                                self.stack.incrementContainerCount();
                                continue :state .object_field;
                            },
                            '}' => continue :state .object_end,
                            else => return error.ExpectedObjectCommaOrEnd,
                        }
                    },
                    .array_begin => {
                        try self.stack.push(.{
                            .tag = .array_opening,
                            .data = .{
                                .ptr = self.currentWord(),
                                .len = 1,
                            },
                        });

                        self.advanceWord(1);

                        continue :state .array_value;
                    },
                    .array_value => {
                        const t = try self.tokens.next();
                        switch (t[0]) {
                            '{', '[' => |container_begin| {
                                if (self.tokens.peekChar() == container_begin + 2) {
                                    self.visitEmptyContainer(container_begin);
                                    continue :state .array_continue;
                                }
                                continue :state @enumFromInt(container_begin);
                            },
                            else => {
                                try self.visitPrimitive(t);
                                continue :state .array_continue;
                            },
                        }
                    },
                    .array_continue => {
                        switch ((try self.tokens.next())[0]) {
                            ',' => {
                                self.stack.incrementContainerCount();
                                continue :state .array_value;
                            },
                            ']' => continue :state .array_end,
                            else => return error.ExpectedArrayCommaOrEnd,
                        }
                    },
                    .object_end, .array_end => |tag| {
                        const scope = self.stack.getScopeData();
                        self.appendWordAssumeCapacity(.{
                            .tag = @enumFromInt(@intFromEnum(tag)),
                            .data = .{
                                .ptr = scope.ptr,
                                .len = undefined,
                            },
                        });
                        self.words.items().ptr[scope.ptr] = @bitCast(Word{
                            .tag = @enumFromInt(@intFromEnum(tag) - 2),
                            .data = .{
                                .ptr = self.currentWord(),
                                .len = @intCast(@min(scope.len, std.math.maxInt(u24))),
                            },
                        });
                        self.stack.pop();
                        if (self.stack.len() == 1) {
                            @branchHint(.unlikely);
                            continue :state .end;
                        }
                        const parent = self.stack.getScopeType();
                        continue :state @enumFromInt(@intFromEnum(parent) + 1);
                    },
                    .end => {
                        const trail = try self.tokens.next();
                        if (!common.tables.is_whitespace[trail[0]]) return error.TrailingContent;
                        if (self.currentWord() == 0) return error.Empty;

                        assert(self.stack.getScopeType() == .root);
                        const root = self.stack.getScopeData();
                        self.appendWordAssumeCapacity(.{
                            .tag = .root,
                            .data = .{
                                .ptr = root.ptr,
                                .len = undefined,
                            },
                        });
                        self.words.items().ptr[root.ptr] = @bitCast(Word{
                            .tag = .root,
                            .data = .{
                                .ptr = self.currentWord(),
                                .len = undefined,
                            },
                        });
                        self.stack.pop();
                        assert(self.stack.len() == 0);
                    },
                }
            }

            inline fn visitPrimitive(self: *Tape, ptr: [*]const u8) Error!void {
                const t = ptr[0];
                switch (t) {
                    '"' => {
                        @branchHint(.likely);
                        return self.visitString(ptr);
                    },
                    't' => return self.visitTrue(ptr),
                    'f' => return self.visitFalse(ptr),
                    'n' => return self.visitNull(ptr),
                    else => {
                        @branchHint(.likely);
                        return self.visitNumber(ptr);
                    },
                }
            }

            inline fn visitEmptyContainer(self: *Tape, tag: u8) void {
                const curr = self.currentWord();
                self.appendTwoWordsAssumeCapacity(.{
                    .{
                        .tag = @enumFromInt(tag),
                        .data = .{
                            .ptr = curr + 2,
                            .len = 0,
                        },
                    },
                    .{
                        .tag = @enumFromInt(tag + 2),
                        .data = .{
                            .ptr = curr,
                            .len = undefined,
                        },
                    },
                });
                _ = self.tokens.next() catch unreachable;
            }

            inline fn visitString(self: *Tape, ptr: [*]const u8) void {
                const string_parser = @import("parsers/string.zig");
                const result = string_parser.skipString(ptr);
                const input_offset: u32 = (self.tokens.token - 1)[0] + 1; // byte offset after opening quote
                const raw_len: u32 = @intCast(result.src_end - (ptr + 1));

                // Pack has_escapes into MSB of len field (bit 23).
                // Bits 0-22 = raw string length (max ~8MB), bit 23 = has_escapes flag.
                const escape_bit: u24 = if (result.has_escapes) (1 << 23) else 0;
                self.appendWordAssumeCapacity(.{
                    .tag = .string,
                    .data = .{
                        .ptr = input_offset,
                        .len = @intCast((raw_len & 0x7FFFFF) | escape_bit),
                    },
                });
            }

            inline fn visitNumber(self: *Tape, ptr: [*]const u8) Error!void {
                const number = try @import("parsers/number/parser.zig").parse(null, ptr);
                switch (number) {
                    inline else => |n| {
                        self.appendTwoWordsAssumeCapacity(.{
                            .{
                                .tag = @enumFromInt(@intFromEnum(number)),
                                .data = undefined,
                            },
                            @bitCast(n),
                        });
                    },
                }
            }

            inline fn visitTrue(self: *Tape, ptr: [*]const u8) Error!void {
                const check = @import("parsers/atoms.zig").checkTrue;
                try check(ptr);
                self.appendWordAssumeCapacity(.{
                    .tag = .true,
                    .data = undefined,
                });
            }

            inline fn visitFalse(self: *Tape, ptr: [*]const u8) Error!void {
                const check = @import("parsers/atoms.zig").checkFalse;
                try check(ptr);
                self.appendWordAssumeCapacity(.{
                    .tag = .false,
                    .data = undefined,
                });
            }

            inline fn visitNull(self: *Tape, ptr: [*]const u8) Error!void {
                const check = @import("parsers/atoms.zig").checkNull;
                try check(ptr);
                self.appendWordAssumeCapacity(.{
                    .tag = .null,
                    .data = undefined,
                });
            }
        };
    };
}

test "dom" {
    const allocator = std.testing.allocator;
    var parser = FullParser(.default).init;
    defer parser.deinit(allocator);

    const document = try parser.parseFromSlice(allocator,
        \\{
        \\  "Image": {
        \\      "Width":  800,
        \\      "Height": 600,
        \\      "Title":  "View from 15th Floor",
        \\      "Thumbnail": {
        \\          "Url":    "http://www.example.com/image/481989943",
        \\          "Height": 125,
        \\          "Width":  100
        \\      },
        \\      "Animated" : false,
        \\      "IDs": [116, 943, 234, 38793]
        \\    }
        \\}
    );

    const image = try document.at("Image").asObject();

    const title = try image.at("Title").asString();
    try std.testing.expectEqualStrings("View from 15th Floor", title);

    const third_id = try image.at("IDs").atIndex(2).asUnsigned();
    try std.testing.expectEqual(234, third_id);
}
