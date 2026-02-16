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

pub const ReaderError = types.ReaderError;
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
        reader_error: ?std.meta.Int(.unsigned, @bitSizeOf(anyerror)),

        tape: Tape,

        max_capacity: usize,

        pub const init: Self = .{
            .tape = .init,
            .max_capacity = max_capacity_bound,
            .document_buffer = .empty,
            .reader_error = null,
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

        /// Set the maximum depth of a JSON document.
        pub fn setMaximumDepth(self: *Self, new_depth: usize) void {
            self.max_depth = new_depth;
        }

        /// Recover the error returned from the reader.
        /// This method should be used only when the parser returns [`error.AnyReader`](#zimdjson.types.ReaderError).
        /// Otherwise, it results in undefined behavior.
        pub fn recoverReaderError(self: Self, comptime Reader: type) Reader.Error {
            assert(self.reader_error != null);
            return @errorCast(@errorFromInt(self.reader_error.?));
        }

        /// This method preallocates the necessary memory for a document based on its size.
        /// It should not be used when parsing from a slice, as the document size is already
        /// known, resulting in unnecessary allocations.
        pub fn expectDocumentSize(self: *Self, allocator: Allocator, size: usize) Error!void {
            return self.ensureTotalCapacityForReader(allocator, size);
        }

        fn ensureTotalCapacityForSlice(self: *Self, allocator: Allocator, new_capacity: usize) Error!void {
            if (new_capacity > self.max_capacity) return error.ExceededCapacity;

            try self.tape.tokens.ensureTotalCapacity(allocator, new_capacity
                // root words
                + 2);

            self.tape.string_buffer.allocator = allocator;
            try self.tape.string_buffer.ensureTotalCapacity(new_capacity);
        }

        fn ensureTotalCapacityForReader(self: *Self, allocator: Allocator, new_capacity: usize) Error!void {
            if (new_capacity > self.max_capacity) return error.ExceededCapacity;

            try self.document_buffer.ensureTotalCapacity(allocator, new_capacity + types.Vector.bytes_len);
            try self.tape.tokens.ensureTotalCapacity(allocator, new_capacity
                // root words
                + 2);

            self.tape.string_buffer.allocator = allocator;
            try self.tape.string_buffer.ensureTotalCapacity(new_capacity);
        }

        /// Parse a JSON document from slice. Allocated resources are owned by the parser.
        pub fn parseFromSlice(self: *Self, allocator: Allocator, document: Aligned.slice) Error!Document {
            self.reader_error = null;

            self.tape.string_buffer.reset();
            self.tape.string_buffer.allocator = allocator;

            try self.ensureTotalCapacityForSlice(allocator, document.len);
            try self.tape.buildFromSlice(allocator, document);
            // Update string_buffer length: strings_ptr tracks how far we wrote,
            // but the list length isn't updated by advanceString.
            self.tape.string_buffer.strings.list.items.len = @intFromPtr(self.tape.strings_ptr) - @intFromPtr(self.tape.string_buffer.strings.list.items.ptr);
            // string_meta length is tracked by string_meta_count (appended via appendAssumeCapacity)
            self.tape.string_meta.list.items.len = self.tape.string_meta_count;
            return .{
                .tape = &self.tape,
                .index = 1,
            };
        }

        /// Parse a JSON document from reader. Allocated resources are owned by the parser.
        pub fn parseFromReader(self: *Self, allocator: Allocator, reader: std.io.AnyReader) (Error || ReaderError)!Document {
            self.reader_error = null;

            self.tape.string_buffer.reset();
            self.tape.string_buffer.allocator = allocator;

            self.document_buffer.clearRetainingCapacity();
            common.readAllRetainingCapacity(
                allocator,
                reader,
                types.Aligned(true).alignment,
                &self.document_buffer,
                self.max_capacity,
            ) catch |err| switch (err) {
                Allocator.Error.OutOfMemory => |e| return e,
                else => |e| {
                    self.reader_error = @intFromError(e);
                    return error.AnyReader;
                },
            };
            const len = self.document_buffer.items.len;
            try self.ensureTotalCapacityForReader(allocator, len);
            self.document_buffer.appendNTimesAssumeCapacity(' ', types.Vector.bytes_len);
            try self.tape.buildFromSlice(allocator, self.document_buffer.items[0..len]);
            // Update string_buffer length
            self.tape.string_buffer.strings.list.items.len = @intFromPtr(self.tape.strings_ptr) - @intFromPtr(self.tape.string_buffer.strings.list.items.ptr);
            self.tape.string_meta.list.items.len = self.tape.string_meta_count;
            return .{
                .tape = &self.tape,
                .index = 1,
            };
        }

        /// Represents any valid JSON value.
        pub const AnyValue = union(types.ValueType) {
            null,
            bool: bool,
            number: Number,
            string: []const u8,
            object: Object,
            array: Array,
        };

        /// Represents a JSON document.
        pub const Document = struct {
            tape: *const Tape,
            index: u32,

            /// Cast the document to a JSON value.
            pub fn asValue(self: Document) Value {
                return .{ .tape = self.tape, .index = self.index };
            }

            /// Cast the document to an object.
            pub fn asObject(self: Document) Error!Object {
                return self.asValue().asObject();
            }

            /// Cast the document to an array.
            pub fn asArray(self: Document) Error!Array {
                return self.asValue().asArray();
            }

            /// Cast the document to a string.
            /// The string is guaranteed to be valid UTF-8.
            ///
            /// **Note**: The string is stored in the parser and will be invalidated the next time it
            /// parses a document or when it is destroyed.
            pub fn asString(self: Document) Error![]const u8 {
                return self.asValue().asString();
            }

            /// Cast the document to a number.
            pub fn asNumber(self: Document) Error!Number {
                return self.asValue().asNumber();
            }

            /// Cast the document to an unsigned integer.
            pub fn asUnsigned(self: Document) Error!u64 {
                return self.asValue().asUnsigned();
            }

            /// Cast the document to a signed integer.
            pub fn asSigned(self: Document) Error!i64 {
                return self.asValue().asSigned();
            }

            /// Cast the document to a double floating point.
            pub fn asDouble(self: Document) Error!f64 {
                return self.asValue().asDouble();
            }

            /// Cast the document to a bool.
            pub fn asBool(self: Document) Error!bool {
                return self.asValue().asBool();
            }

            /// Check whether the document is a JSON `null`.
            pub fn isNull(self: Document) Error!bool {
                return self.asValue().isNull();
            }

            /// Cast the document to any valid JSON value.
            pub fn asAny(self: Document) Error!AnyValue {
                return self.asValue().asAny();
            }

            /// Cast the document to the specified type.
            pub fn as(self: Document, comptime T: type) Error!T {
                return self.asValue().as(T);
            }

            /// Get the type of the document.
            pub fn getType(self: Document) Error!types.ValueType {
                return self.asValue().getType();
            }

            /// Get the value associated with the given key.
            /// The key is matched against **unescaped** JSON.
            /// This method has linear-time complexity.
            pub fn at(self: Document, key: []const u8) Value {
                return self.asValue().at(key);
            }

            /// Get the value at the given index.
            /// This method has linear-time complexity.
            pub fn atIndex(self: Document, index: usize) Value {
                return self.asValue().atIndex(index);
            }

            /// Get the size of the array (number of immediate children).
            /// It is a saturated value with a maximum of `std.math.maxInt(u24)`.
            pub fn getArraySize(self: Document) Error!u24 {
                return self.asValue().getArraySize();
            }

            /// Get the size of the object (number of keys).
            /// It is a saturated value with a maximum of `std.math.maxInt(u24)`.
            pub fn getObjectSize(self: Document) Error!u24 {
                return self.asValue().getObjectSize();
            }
        };

        /// Represents a value in a JSON document.
        pub const Value = struct {
            tape: *const Tape,
            index: u32,
            err: ?Error = null,

            /// Cast the value to an object.
            pub fn asObject(self: Value) Error!Object {
                if (self.err) |err| return err;

                return switch (self.tape.get(self.index).tag) {
                    .object_opening => Object{ .tape = self.tape, .root = self.index },
                    else => error.IncorrectType,
                };
            }

            /// Cast the value to an array.
            pub fn asArray(self: Value) Error!Array {
                if (self.err) |err| return err;

                return switch (self.tape.get(self.index).tag) {
                    .array_opening => Array{ .tape = self.tape, .root = self.index },
                    else => error.IncorrectType,
                };
            }

            /// Cast the value to a string.
            /// The string is guaranteed to be valid UTF-8.
            ///
            /// **Note**: The string is stored in the parser and will be invalidated the next time it
            /// parses a document or when it is destroyed.
            pub fn asString(self: Value) Error![]const u8 {
                if (self.err) |err| return err;

                const w = self.tape.get(self.index);
                return switch (w.tag) {
                    .string => brk: {
                        const len = std.mem.readInt(u32, self.tape.string_buffer.strings.items().ptr[w.data.ptr..][0..@sizeOf(u32)], native_endian);
                        const ptr = self.tape.string_buffer.strings.items().ptr[w.data.ptr + @sizeOf(u32) ..];
                        break :brk ptr[0..len];
                    },
                    else => error.IncorrectType,
                };
            }

            /// Cast the value to a number.
            pub fn asNumber(self: Value) Error!Number {
                if (self.err) |err| return err;

                const w = self.tape.get(self.index);
                const number = self.tape.get(self.index + 1);
                return switch (w.tag) {
                    inline .unsigned, .signed, .double => |t| @unionInit(Number, @tagName(t), @bitCast(number)),
                    else => error.IncorrectType,
                };
            }

            /// Cast the value to an unsigned integer.
            pub fn asUnsigned(self: Value) Error!u64 {
                if (self.err) |err| return err;

                const w = self.tape.get(self.index);
                const number = self.tape.get(self.index + 1);
                return switch (w.tag) {
                    .unsigned => @bitCast(number),
                    .signed => std.math.cast(u64, @as(i64, @bitCast(number))) orelse error.NumberOutOfRange,
                    else => error.IncorrectType,
                };
            }

            /// Cast the value to a signed integer.
            pub fn asSigned(self: Value) Error!i64 {
                if (self.err) |err| return err;

                const w = self.tape.get(self.index);
                const number = self.tape.get(self.index + 1);
                return switch (w.tag) {
                    .signed => @bitCast(number),
                    .unsigned => std.math.cast(i64, @as(u64, @bitCast(number))) orelse error.NumberOutOfRange,
                    else => error.IncorrectType,
                };
            }

            /// Cast the value to a double floating point.
            pub fn asDouble(self: Value) Error!f64 {
                if (self.err) |err| return err;

                const w = self.tape.get(self.index);
                const number = self.tape.get(self.index + 1);
                return switch (w.tag) {
                    .double => @bitCast(number),
                    .unsigned => @floatFromInt(@as(u64, @bitCast(number))),
                    .signed => @floatFromInt(@as(i64, @bitCast(number))),
                    else => error.IncorrectType,
                };
            }

            /// Cast the value to a bool.
            pub fn asBool(self: Value) Error!bool {
                if (self.err) |err| return err;

                return switch (self.tape.get(self.index).tag) {
                    .true => true,
                    .false => false,
                    else => error.IncorrectType,
                };
            }

            /// Check whether the value is a JSON `null`.
            pub fn isNull(self: Value) Error!bool {
                if (self.err) |err| return err;

                return self.tape.get(self.index).tag == .null;
            }

            /// Cast the value to any valid JSON value.
            pub fn asAny(self: Value) Error!AnyValue {
                if (self.err) |err| return err;

                const w = self.tape.get(self.index);
                return switch (w.tag) {
                    .true => .{ .bool = true },
                    .false => .{ .bool = false },
                    .null => .null,
                    .unsigned, .signed, .double => .{ .number = self.asNumber() catch unreachable },
                    .string => .{ .string = self.asString() catch unreachable },
                    .object_opening => .{ .object = .{ .tape = self.tape, .root = self.index } },
                    .array_opening => .{ .array = .{ .tape = self.tape, .root = self.index } },
                    else => unreachable,
                };
            }

            /// Cast the value to the specified type.
            pub fn as(self: Value, comptime T: type) Error!T {
                const info = @typeInfo(T);
                switch (info) {
                    .int => {
                        const n = try self.asNumber();
                        return switch (n) {
                            .double => error.IncorrectType,
                            inline else => n.cast(T) orelse error.NumberOutOfRange,
                        };
                    },
                    .float => return @floatCast(try self.asDouble()),
                    .bool => return self.asBool(),
                    .optional => |opt| {
                        if (try self.isNull()) return null;
                        const child = try self.as(opt.child);
                        return child;
                    },
                    .void => {
                        if (try self.isNull()) return {};
                        return error.IncorrectType;
                    },
                    else => {
                        if (T == []const u8) return self.asString();
                        if (T == Number) return self.asNumber();
                        if (T == Array) return self.asArray();
                        if (T == Object) return self.asObject();
                        if (T == AnyValue) return self.asAny();
                        @compileError("Unable to parse into type '" ++ @typeName(T) ++ "'");
                    },
                }
            }

            /// Get the type of the value.
            pub fn getType(self: Value) Error!types.ValueType {
                if (self.err) |err| return err;

                const w = self.tape.get(self.index);
                return switch (w.tag) {
                    .true, .false => .bool,
                    .null => .null,
                    .number => .number,
                    .string => .string,
                    .object_opening => .object,
                    .array_opening => .array,
                    else => unreachable,
                };
            }

            /// Get the value associated with the given key.
            /// The key is matched against **unescaped** JSON.
            /// This method has linear-time complexity.
            pub fn at(self: Value, key: []const u8) Value {
                if (self.err) |_| return self;
                const obj = self.asObject() catch |err| return .{
                    .tape = self.tape,
                    .index = self.index,
                    .err = err,
                };
                return obj.at(key);
            }

            /// Get the value at the given index.
            /// This method has linear-time complexity.
            pub fn atIndex(self: Value, index: usize) Value {
                if (self.err) |_| return self;
                const arr = self.asArray() catch |err| return .{
                    .tape = self.tape,
                    .index = self.index,
                    .err = err,
                };
                return arr.at(index);
            }

            /// Get the size of the array (number of immediate children).
            /// It is a saturated value with a maximum of `std.math.maxInt(u24)`.
            pub fn getArraySize(self: Value) Error!u24 {
                if (self.err) |err| return err;
                const arr = try self.asArray();
                return arr.getSize();
            }

            /// Get the size of the object (number of keys).
            /// It is a saturated value with a maximum of `std.math.maxInt(u24)`.
            pub fn getObjectSize(self: Value) Error!u24 {
                if (self.err) |err| return err;
                const obj = try self.asObject();
                return obj.getSize();
            }
        };

        /// A valid JSON array.
        pub const Array = struct {
            tape: *const Tape,
            root: u32,

            pub const Iterator = struct {
                tape: *const Tape,
                curr: u32,

                /// Go to the next value in the array, if any.
                pub fn next(self: *Iterator) ?Value {
                    const curr = self.tape.get(self.curr);
                    if (curr.tag == .array_closing) return null;
                    defer self.curr = switch (curr.tag) {
                        .array_opening, .object_opening => curr.data.ptr,
                        .unsigned, .signed, .double => self.curr + 2,
                        else => self.curr + 1,
                    };
                    return .{ .tape = self.tape, .index = self.curr };
                }
            };

            /// Iterate over the values in the array.
            pub fn iterator(self: Array) Iterator {
                return .{
                    .tape = self.tape,
                    .curr = self.root + 1,
                };
            }

            /// Get the value at the given index.
            /// This method has linear-time complexity.
            pub fn at(self: Array, index: usize) Value {
                var it = self.iterator();
                var i: u32 = 0;
                while (it.next()) |v| : (i += 1) if (i == index) return v;
                return .{
                    .tape = self.tape,
                    .index = self.root,
                    .err = error.IndexOutOfBounds,
                };
            }

            /// Check whether the array is empty.
            pub fn isEmpty(self: Array) bool {
                return self.getSize() == 0;
            }

            /// Get the size of the array (number of immediate children).
            /// It is a saturated value with a maximum of `std.math.maxInt(u24)`.
            pub fn getSize(self: Array) u24 {
                assert(self.tape.get(self.root).tag == .array_opening);
                return self.tape.get(self.root).data.len;
            }
        };

        /// A valid JSON object.
        pub const Object = struct {
            tape: *const Tape,
            root: u32,

            pub const Field = struct {
                key: []const u8,
                value: Value,
            };

            pub const Iterator = struct {
                tape: *const Tape,
                curr: u32,

                /// Go to the next field in the object, if any.
                pub fn next(self: *Iterator) ?Field {
                    if (self.tape.get(self.curr).tag == .object_closing) return null;
                    const field = Value{ .tape = self.tape, .index = self.curr };
                    const value = Value{ .tape = self.tape, .index = self.curr + 1 };
                    const curr = self.tape.get(self.curr + 1);
                    defer self.curr = switch (curr.tag) {
                        .array_opening, .object_opening => curr.data.ptr,
                        .unsigned, .signed, .double => self.curr + 3,
                        else => self.curr + 2,
                    };
                    return .{
                        .key = field.asString() catch unreachable,
                        .value = value,
                    };
                }
            };

            /// Iterate over the fields in the object.
            pub fn iterator(self: Object) Iterator {
                return .{
                    .tape = self.tape,
                    .curr = self.root + 1,
                };
            }

            /// Get the value associated with the given key.
            /// The key is matched against **unescaped** JSON.
            /// This method has linear-time complexity.
            pub fn at(self: Object, key: []const u8) Value {
                var it = self.iterator();
                while (it.next()) |field| if (std.mem.eql(u8, field.key, key)) return field.value;
                return .{
                    .tape = self.tape,
                    .index = self.root,
                    .err = error.MissingField,
                };
            }

            /// Check whether the object is empty.
            pub fn isEmpty(self: Object) bool {
                return self.getSize() == 0;
            }

            /// Get the size of the object (number of keys).
            /// It is a saturated value with a maximum of `std.math.maxInt(u24)`.
            pub fn getSize(self: Object) u24 {
                assert(self.tape.get(self.root).tag == .object_opening);
                return self.tape.get(self.root).data.len;
            }
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

            string_buffer: types.StringBuffer(max_capacity_bound),

            /// Per-string metadata: packed (input_byte_offset: u32, raw_len | has_escapes<<31: u32).
            /// Indexed by string ordinal (0th string parsed, 1st, etc.).
            /// Populated during visitString. Used by bulk column reads to enable
            /// zero-copy JS input.slice() for clean (non-escaped) strings.
            string_meta: types.BoundedArrayList(u64, max_capacity_bound) = .empty,
            string_meta_count: u32 = 0,
            input_base_addr: usize = 0,

            words_ptr: [*]u64 = undefined,
            strings_ptr: [*]u8 = undefined,

            pub const init: Tape = .{
                .tokens = .init,
                .words = .empty,
                .stack = .empty,
                .string_buffer = .init,
            };

            pub fn deinit(self: *Tape, allocator: Allocator) void {
                self.words.deinit(allocator);
                self.stack.deinit(allocator);
                self.tokens.deinit(allocator);
                self.string_buffer.deinit();
                self.string_meta.deinit(allocator);
            }

            pub inline fn buildFromSlice(self: *Tape, allocator: Allocator, document: Aligned.slice) Error!void {
                try self.tokens.build(allocator, document);
                try self.stack.ensureTotalCapacity(allocator, self.stack.max_depth);

                const tokens_count = self.tokens.indexes.items.len;
                // if there are only n numbers, there must be n - 1 commas plus an ending container token, so almost half of the tokens are numbers
                try self.words.ensureTotalCapacity(allocator, tokens_count + (tokens_count >> 1) + 1
                    // root words
                + 2);

                // String metadata: at most tokens_count/2 strings (every other token could be a string)
                try self.string_meta.ensureTotalCapacity(allocator, (tokens_count >> 1) + 1);

                self.words.list.clearRetainingCapacity();
                self.stack.clearRetainingCapacity();
                self.string_meta.list.clearRetainingCapacity();
                self.string_meta_count = 0;
                self.input_base_addr = @intFromPtr(document.ptr);

                self.words_ptr = self.words.items().ptr;
                self.strings_ptr = self.string_buffer.strings.items().ptr;

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

            inline fn currentString(self: Tape) [*]u8 {
                return self.strings_ptr;
            }

            inline fn advanceString(self: *Tape, len_: usize) void {
                self.strings_ptr += len_;
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
                const curr_str = self.currentString();
                const next_str = curr_str + @sizeOf(u32);
                const result = string_parser.writeString(ptr, next_str) catch unreachable;
                const next_len = result.dst_end - next_str;

                // Store per-string metadata: (input_byte_offset, raw_len | has_escapes<<31)
                const ordinal = self.string_meta_count;
                const input_offset: u32 = (self.tokens.token - 1)[0] + 1; // +1 to skip opening quote
                const raw_len: u32 = @intCast(result.src_end - (ptr + 1));
                const has_escapes: u32 = if (next_len != raw_len) @as(u32, 1) << 31 else 0;
                self.string_meta.appendAssumeCapacity(@as(u64, input_offset) | (@as(u64, raw_len | has_escapes) << 32));
                self.string_meta_count += 1;

                self.appendWordAssumeCapacity(.{
                    .tag = .string,
                    .data = .{
                        .ptr = @intCast(curr_str - self.string_buffer.strings.items().ptr),
                        .len = @intCast(ordinal),
                    },
                });
                // Full string length in u32 header (self-contained, no split encoding)
                std.mem.writeInt(u32, curr_str[0..@sizeOf(u32)], @intCast(next_len), native_endian);
                self.advanceString(next_len + @sizeOf(u32));
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
