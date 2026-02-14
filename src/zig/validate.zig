///! VectorJSON Schema Validator
///!
///! Validates parsed JSON data against a JSON Schema (subset).
///! Schema is compiled from its token stream into a flat array of SchemaNode
///! structs. Data tape is walked and checked against the compiled schema.
///!
///! Supported JSON Schema keywords:
///!   type, properties, required, items, additionalProperties,
///!   minimum, maximum, exclusiveMinimum, exclusiveMaximum,
///!   minLength, maxLength, minItems, maxItems, enum, const

const std = @import("std");
const compare_mod = @import("compare.zig");
const TokenStream = compare_mod.TokenStream;
const TokenReader = compare_mod.TokenReader;
const TokenTag = compare_mod.TokenTag;

/// Type mask bits for the "type" keyword
pub const TypeMask = struct {
    pub const NULL: u8 = 1 << 0;
    pub const BOOLEAN: u8 = 1 << 1;
    pub const NUMBER: u8 = 1 << 2;
    pub const INTEGER: u8 = 1 << 3;
    pub const STRING: u8 = 1 << 4;
    pub const OBJECT: u8 = 1 << 5;
    pub const ARRAY: u8 = 1 << 6;
    pub const ANY: u8 = 0x7F;
};

const MAX_NODES: u16 = 512;
const MAX_PROPERTIES: u16 = 1024;
const MAX_REQUIRED: u16 = 512;
const MAX_ERRORS: u32 = 256;
const MAX_PATH_BUF: u32 = 32 * 1024;
const MAX_MSG_BUF: u32 = 32 * 1024;

/// A reference to a string in the schema token stream
const StrRef = struct {
    ptr: [*]const u8,
    len: u32,
};

/// A property definition: key name → sub-schema node index
const PropertyDef = struct {
    key: StrRef,
    schema_idx: u16,
};

/// A compiled schema node
pub const SchemaNode = struct {
    type_mask: u8 = TypeMask.ANY,

    // Number constraints
    has_minimum: bool = false,
    has_maximum: bool = false,
    has_exclusive_min: bool = false,
    has_exclusive_max: bool = false,
    minimum: f64 = 0,
    maximum: f64 = 0,
    exclusive_min: f64 = 0,
    exclusive_max: f64 = 0,

    // String constraints
    has_min_length: bool = false,
    has_max_length: bool = false,
    min_length: u32 = 0,
    max_length: u32 = 0xFFFFFFFF,

    // Array constraints
    has_min_items: bool = false,
    has_max_items: bool = false,
    min_items: u32 = 0,
    max_items: u32 = 0xFFFFFFFF,
    items_idx: u16 = 0xFFFF, // index of items sub-schema, 0xFFFF = none

    // Object constraints
    additional_properties: bool = true,
    properties_start: u16 = 0,
    properties_count: u16 = 0,
    required_start: u16 = 0,
    required_count: u16 = 0,

    // Enum constraint
    has_enum: bool = false,
    enum_pos: u32 = 0, // position in schema stream where enum array starts
    enum_count: u16 = 0,

    // Const constraint
    has_const: bool = false,
    const_pos: u32 = 0, // position in schema stream where const value starts
};

/// A validation error
const ValidationError = struct {
    path_offset: u32,
    path_len: u32,
    msg_offset: u32,
    msg_len: u32,
};

pub const ValidatorState = struct {
    // Schema storage
    schema_stream: TokenStream = .{},
    nodes: [MAX_NODES]SchemaNode = undefined,
    node_count: u16 = 0,
    properties: [MAX_PROPERTIES]PropertyDef = undefined,
    prop_count: u16 = 0,
    required_keys: [MAX_REQUIRED]StrRef = undefined,
    req_count: u16 = 0,

    // Errors
    errors: [MAX_ERRORS]ValidationError = undefined,
    error_count: u32 = 0,
    error_path_buf: ?[*]u8 = null,
    error_path_len: u32 = 0,
    error_path_cap: u32 = 0,
    error_msg_buf: ?[*]u8 = null,
    error_msg_len: u32 = 0,
    error_msg_cap: u32 = 0,

    // Current path during validation
    cur_path: ?[*]u8 = null,
    cur_path_len: u32 = 0,
    cur_path_cap: u32 = 0,

    schema_loaded: bool = false,
    allocator: std.mem.Allocator = undefined,

    pub fn init(allocator: std.mem.Allocator) !*ValidatorState {
        const self = try allocator.create(ValidatorState);
        self.* = .{};
        self.allocator = allocator;
        self.schema_stream = TokenStream.init(allocator);

        const path_buf = try allocator.alloc(u8, MAX_PATH_BUF);
        self.error_path_buf = path_buf.ptr;
        self.error_path_cap = MAX_PATH_BUF;

        const msg_buf = try allocator.alloc(u8, MAX_MSG_BUF);
        self.error_msg_buf = msg_buf.ptr;
        self.error_msg_cap = MAX_MSG_BUF;

        const cur = try allocator.alloc(u8, 4096);
        self.cur_path = cur.ptr;
        self.cur_path_cap = 4096;
        cur[0] = '$';
        self.cur_path_len = 1;

        return self;
    }

    pub fn deinit(self: *ValidatorState) void {
        self.schema_stream.deinit();
        if (self.error_path_buf) |b| self.allocator.free(b[0..self.error_path_cap]);
        if (self.error_msg_buf) |b| self.allocator.free(b[0..self.error_msg_cap]);
        if (self.cur_path) |b| self.allocator.free(b[0..self.cur_path_cap]);
        self.allocator.destroy(self);
    }

    pub fn resetErrors(self: *ValidatorState) void {
        self.error_count = 0;
        self.error_path_len = 0;
        self.error_msg_len = 0;
        self.cur_path_len = 1; // "$"
    }

    // =============================================
    // Schema compilation from token stream
    // =============================================

    pub fn compileSchema(self: *ValidatorState) bool {
        self.node_count = 0;
        self.prop_count = 0;
        self.req_count = 0;

        var reader = TokenReader.fromStream(&self.schema_stream);
        const root = self.compileNode(&reader);
        if (root == 0xFFFF) return false;
        self.schema_loaded = true;
        return true;
    }

    /// Compile a single schema node. Returns node index or 0xFFFF on error.
    fn compileNode(self: *ValidatorState, reader: *TokenReader) u16 {
        const tag = reader.peekTag();

        // Boolean schemas: true = accept all, false = reject all
        if (tag == .true_val) {
            _ = reader.readTag();
            return self.addNode(.{});
        }
        if (tag == .false_val) {
            _ = reader.readTag();
            return self.addNode(.{ .type_mask = 0 }); // rejects everything
        }

        if (tag != .object_start) {
            reader.skipValue();
            return self.addNode(.{}); // unknown schema → accept all
        }

        _ = reader.readTag(); // consume object_start

        var node = SchemaNode{};
        const node_idx = self.addNode(.{}); // placeholder
        if (node_idx == 0xFFFF) return 0xFFFF;

        // Read schema keywords
        while (reader.peekTag() == .key) {
            _ = reader.readTag();
            const kw = reader.readStringBytes();

            if (strEql(kw.ptr, kw.len, "type")) {
                node.type_mask = self.parseTypeKeyword(reader);
            } else if (strEql(kw.ptr, kw.len, "properties")) {
                self.parseProperties(&node, reader);
            } else if (strEql(kw.ptr, kw.len, "required")) {
                self.parseRequired(&node, reader);
            } else if (strEql(kw.ptr, kw.len, "items")) {
                const items_idx = self.compileNode(reader);
                node.items_idx = items_idx;
            } else if (strEql(kw.ptr, kw.len, "additionalProperties")) {
                const t = reader.peekTag();
                if (t == .true_val) {
                    _ = reader.readTag();
                    node.additional_properties = true;
                } else if (t == .false_val) {
                    _ = reader.readTag();
                    node.additional_properties = false;
                } else {
                    reader.skipValue();
                }
            } else if (strEql(kw.ptr, kw.len, "minimum")) {
                if (reader.peekTag() == .number) {
                    _ = reader.readTag();
                    node.minimum = reader.readF64();
                    node.has_minimum = true;
                } else reader.skipValue();
            } else if (strEql(kw.ptr, kw.len, "maximum")) {
                if (reader.peekTag() == .number) {
                    _ = reader.readTag();
                    node.maximum = reader.readF64();
                    node.has_maximum = true;
                } else reader.skipValue();
            } else if (strEql(kw.ptr, kw.len, "exclusiveMinimum")) {
                if (reader.peekTag() == .number) {
                    _ = reader.readTag();
                    node.exclusive_min = reader.readF64();
                    node.has_exclusive_min = true;
                } else reader.skipValue();
            } else if (strEql(kw.ptr, kw.len, "exclusiveMaximum")) {
                if (reader.peekTag() == .number) {
                    _ = reader.readTag();
                    node.exclusive_max = reader.readF64();
                    node.has_exclusive_max = true;
                } else reader.skipValue();
            } else if (strEql(kw.ptr, kw.len, "minLength")) {
                if (reader.peekTag() == .number) {
                    _ = reader.readTag();
                    node.min_length = @intFromFloat(reader.readF64());
                    node.has_min_length = true;
                } else reader.skipValue();
            } else if (strEql(kw.ptr, kw.len, "maxLength")) {
                if (reader.peekTag() == .number) {
                    _ = reader.readTag();
                    node.max_length = @intFromFloat(reader.readF64());
                    node.has_max_length = true;
                } else reader.skipValue();
            } else if (strEql(kw.ptr, kw.len, "minItems")) {
                if (reader.peekTag() == .number) {
                    _ = reader.readTag();
                    node.min_items = @intFromFloat(reader.readF64());
                    node.has_min_items = true;
                } else reader.skipValue();
            } else if (strEql(kw.ptr, kw.len, "maxItems")) {
                if (reader.peekTag() == .number) {
                    _ = reader.readTag();
                    node.max_items = @intFromFloat(reader.readF64());
                    node.has_max_items = true;
                } else reader.skipValue();
            } else if (strEql(kw.ptr, kw.len, "enum")) {
                if (reader.peekTag() == .array_start) {
                    node.has_enum = true;
                    node.enum_pos = reader.pos;
                    // Count elements
                    _ = reader.readTag(); // array_start
                    var count: u16 = 0;
                    while (reader.peekTag() != .array_end and reader.peekTag() != .end) {
                        reader.skipValue();
                        count += 1;
                    }
                    if (reader.peekTag() == .array_end) _ = reader.readTag();
                    node.enum_count = count;
                } else reader.skipValue();
            } else if (strEql(kw.ptr, kw.len, "const")) {
                node.has_const = true;
                node.const_pos = reader.pos;
                reader.skipValue();
            } else {
                // Unknown keyword — skip
                reader.skipValue();
            }
        }

        // Consume object_end
        if (reader.peekTag() == .object_end) _ = reader.readTag();

        // Update the node in place
        self.nodes[node_idx] = node;
        return node_idx;
    }

    fn parseTypeKeyword(self: *ValidatorState, reader: *TokenReader) u8 {
        _ = self;
        const tag = reader.peekTag();
        if (tag == .string) {
            _ = reader.readTag();
            const s = reader.readStringBytes();
            return typeStringToMask(s.ptr, s.len);
        }
        if (tag == .array_start) {
            _ = reader.readTag();
            var mask: u8 = 0;
            while (reader.peekTag() == .string) {
                _ = reader.readTag();
                const s = reader.readStringBytes();
                mask |= typeStringToMask(s.ptr, s.len);
            }
            if (reader.peekTag() == .array_end) _ = reader.readTag();
            return mask;
        }
        reader.skipValue();
        return TypeMask.ANY;
    }

    fn parseProperties(self: *ValidatorState, node: *SchemaNode, reader: *TokenReader) void {
        if (reader.peekTag() != .object_start) {
            reader.skipValue();
            return;
        }
        _ = reader.readTag(); // object_start

        node.properties_start = self.prop_count;
        while (reader.peekTag() == .key) {
            _ = reader.readTag();
            const kdata = reader.readStringBytes();
            const sub_idx = self.compileNode(reader);

            if (self.prop_count < MAX_PROPERTIES) {
                self.properties[self.prop_count] = .{
                    .key = .{ .ptr = kdata.ptr, .len = kdata.len },
                    .schema_idx = sub_idx,
                };
                self.prop_count += 1;
            }
        }
        node.properties_count = self.prop_count - node.properties_start;
        if (reader.peekTag() == .object_end) _ = reader.readTag();
    }

    fn parseRequired(self: *ValidatorState, node: *SchemaNode, reader: *TokenReader) void {
        if (reader.peekTag() != .array_start) {
            reader.skipValue();
            return;
        }
        _ = reader.readTag(); // array_start

        node.required_start = self.req_count;
        while (reader.peekTag() == .string) {
            _ = reader.readTag();
            const s = reader.readStringBytes();
            if (self.req_count < MAX_REQUIRED) {
                self.required_keys[self.req_count] = .{ .ptr = s.ptr, .len = s.len };
                self.req_count += 1;
            }
        }
        node.required_count = self.req_count - node.required_start;
        if (reader.peekTag() == .array_end) _ = reader.readTag();
    }

    fn addNode(self: *ValidatorState, node: SchemaNode) u16 {
        if (self.node_count >= MAX_NODES) return 0xFFFF;
        self.nodes[self.node_count] = node;
        const idx = self.node_count;
        self.node_count += 1;
        return idx;
    }

    // =============================================
    // Data validation against compiled schema
    // =============================================

    /// Validate data tokens against root schema node (index 0).
    pub fn validateData(self: *ValidatorState, data_reader: *TokenReader) void {
        self.resetErrors();
        if (!self.schema_loaded or self.node_count == 0) return;
        self.validateValue(data_reader, 0);
    }

    fn validateValue(self: *ValidatorState, dr: *TokenReader, schema_idx: u16) void {
        if (schema_idx >= self.node_count) {
            dr.skipValue();
            return;
        }
        const node = &self.nodes[schema_idx];
        const tag = dr.peekTag();

        // Type check
        const data_type_mask = tagToTypeMask(tag);
        if (node.type_mask != TypeMask.ANY and (data_type_mask & node.type_mask) == 0) {
            self.addError("type mismatch");
            dr.skipValue();
            return;
        }

        switch (tag) {
            .null_val => {
                _ = dr.readTag();
                self.checkEnum(node, tag, .{ .ptr = @ptrFromInt(1), .len = 0 }, 0);
                self.checkConst(node, tag, .{ .ptr = @ptrFromInt(1), .len = 0 }, 0);
            },
            .true_val, .false_val => {
                _ = dr.readTag();
                self.checkEnum(node, tag, .{ .ptr = @ptrFromInt(1), .len = 0 }, 0);
                self.checkConst(node, tag, .{ .ptr = @ptrFromInt(1), .len = 0 }, 0);
            },
            .number => {
                _ = dr.readTag();
                const val = dr.readF64();
                self.validateNumber(node, val);
                self.checkEnum(node, tag, .{ .ptr = @ptrFromInt(1), .len = 0 }, val);
                self.checkConst(node, tag, .{ .ptr = @ptrFromInt(1), .len = 0 }, val);
            },
            .string => {
                _ = dr.readTag();
                const s = dr.readStringBytes();
                self.validateString(node, s.len);
                const sref = StrRef{ .ptr = s.ptr, .len = s.len };
                self.checkEnum(node, tag, sref, 0);
                self.checkConst(node, tag, sref, 0);
            },
            .object_start => {
                self.validateObject(dr, node);
            },
            .array_start => {
                self.validateArray(dr, node);
            },
            else => {
                dr.skipValue();
            },
        }
    }

    fn validateNumber(self: *ValidatorState, node: *const SchemaNode, val: f64) void {
        if (node.has_minimum and val < node.minimum) {
            self.addError("value below minimum");
        }
        if (node.has_maximum and val > node.maximum) {
            self.addError("value above maximum");
        }
        if (node.has_exclusive_min and val <= node.exclusive_min) {
            self.addError("value not above exclusiveMinimum");
        }
        if (node.has_exclusive_max and val >= node.exclusive_max) {
            self.addError("value not below exclusiveMaximum");
        }
        // Integer check
        if ((node.type_mask & TypeMask.INTEGER) != 0 and (node.type_mask & TypeMask.NUMBER) == 0) {
            const as_int: i64 = @intFromFloat(val);
            const back: f64 = @floatFromInt(as_int);
            if (val != back) {
                self.addError("expected integer");
            }
        }
    }

    fn validateString(self: *ValidatorState, node: *const SchemaNode, len: u32) void {
        if (node.has_min_length and len < node.min_length) {
            self.addError("string shorter than minLength");
        }
        if (node.has_max_length and len > node.max_length) {
            self.addError("string longer than maxLength");
        }
    }

    fn validateObject(self: *ValidatorState, dr: *TokenReader, node: *const SchemaNode) void {
        _ = dr.readTag(); // consume object_start

        const saved_path = self.cur_path_len;

        // Collect data keys for required/additionalProperties checks
        var data_keys: [256]StrRef = undefined;
        var data_key_count: u32 = 0;

        while (dr.peekTag() == .key) {
            _ = dr.readTag(); // key tag
            const kdata = dr.readStringBytes();

            // Save key for later checks
            if (data_key_count < 256) {
                data_keys[data_key_count] = .{ .ptr = kdata.ptr, .len = kdata.len };
                data_key_count += 1;
            }

            // Find matching property schema
            const prop_schema = self.findPropertySchema(node, kdata.ptr, kdata.len);

            self.pushKeyPath(kdata.ptr, kdata.len);

            if (prop_schema) |ps_idx| {
                self.validateValue(dr, ps_idx);
            } else {
                if (!node.additional_properties) {
                    self.addError("additional property not allowed");
                }
                dr.skipValue();
            }

            self.cur_path_len = saved_path;
        }

        // Consume object_end
        if (dr.peekTag() == .object_end) _ = dr.readTag();

        // Check required keys
        if (node.required_count > 0) {
            const req_end = node.required_start + node.required_count;
            for (self.required_keys[node.required_start..req_end]) |req| {
                var found = false;
                for (data_keys[0..data_key_count]) |dk| {
                    if (strEqlRaw(req.ptr, req.len, dk.ptr, dk.len)) {
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    self.pushKeyPath(req.ptr, req.len);
                    self.addError("required property missing");
                    self.cur_path_len = saved_path;
                }
            }
        }
    }

    fn validateArray(self: *ValidatorState, dr: *TokenReader, node: *const SchemaNode) void {
        _ = dr.readTag(); // consume array_start

        const saved_path = self.cur_path_len;
        var count: u32 = 0;

        while (dr.peekTag() != .array_end and dr.peekTag() != .end) {
            self.pushIndexPath(count);
            if (node.items_idx != 0xFFFF) {
                self.validateValue(dr, node.items_idx);
            } else {
                dr.skipValue();
            }
            self.cur_path_len = saved_path;
            count += 1;
        }

        if (dr.peekTag() == .array_end) _ = dr.readTag();

        // Check array length constraints
        if (node.has_min_items and count < node.min_items) {
            self.addError("array has fewer items than minItems");
        }
        if (node.has_max_items and count > node.max_items) {
            self.addError("array has more items than maxItems");
        }
    }

    fn findPropertySchema(self: *const ValidatorState, node: *const SchemaNode, key_ptr: [*]const u8, key_len: u32) ?u16 {
        if (node.properties_count == 0) return null;
        const props_end = node.properties_start + node.properties_count;
        for (self.properties[node.properties_start..props_end]) |prop| {
            if (strEqlRaw(prop.key.ptr, prop.key.len, key_ptr, key_len)) {
                return prop.schema_idx;
            }
        }
        return null;
    }

    fn checkEnum(self: *ValidatorState, node: *const SchemaNode, tag: TokenTag, str_data: StrRef, num_val: f64) void {
        if (!node.has_enum) return;

        var sr = TokenReader{
            .data = self.schema_stream.data orelse return,
            .len = self.schema_stream.len,
            .pos = node.enum_pos,
        };
        _ = sr.readTag(); // array_start

        var found = false;
        while (sr.peekTag() != .array_end and sr.peekTag() != .end) {
            if (valuesMatch(tag, str_data, num_val, &sr)) {
                found = true;
                break;
            }
        }

        if (!found) {
            self.addError("value not in enum");
        }
    }

    fn checkConst(self: *ValidatorState, node: *const SchemaNode, tag: TokenTag, str_data: StrRef, num_val: f64) void {
        if (!node.has_const) return;

        var sr = TokenReader{
            .data = self.schema_stream.data orelse return,
            .len = self.schema_stream.len,
            .pos = node.const_pos,
        };

        if (!valuesMatch(tag, str_data, num_val, &sr)) {
            self.addError("value does not match const");
        }
    }

    // --- Path management ---

    fn pushKeyPath(self: *ValidatorState, key_ptr: [*]const u8, key_len: u32) void {
        const path = self.cur_path orelse return;
        const needed = self.cur_path_len + 1 + key_len;
        if (needed > self.cur_path_cap) return;
        path[self.cur_path_len] = '.';
        @memcpy(path[self.cur_path_len + 1 ..][0..key_len], key_ptr[0..key_len]);
        self.cur_path_len = needed;
    }

    fn pushIndexPath(self: *ValidatorState, index: u32) void {
        const path = self.cur_path orelse return;
        var tmp: [16]u8 = undefined;
        const idx_str = std.fmt.bufPrint(&tmp, "[{d}]", .{index}) catch return;
        const needed = self.cur_path_len + @as(u32, @intCast(idx_str.len));
        if (needed > self.cur_path_cap) return;
        @memcpy(path[self.cur_path_len..][0..idx_str.len], idx_str);
        self.cur_path_len = needed;
    }

    fn addError(self: *ValidatorState, msg: []const u8) void {
        if (self.error_count >= MAX_ERRORS) return;
        const path = self.cur_path orelse return;
        const pbuf = self.error_path_buf orelse return;
        const mbuf = self.error_msg_buf orelse return;

        const plen = self.cur_path_len;
        const mlen: u32 = @intCast(msg.len);

        if (self.error_path_len + plen > self.error_path_cap) return;
        if (self.error_msg_len + mlen > self.error_msg_cap) return;

        @memcpy(pbuf[self.error_path_len..][0..plen], path[0..plen]);
        @memcpy(mbuf[self.error_msg_len..][0..mlen], msg);

        self.errors[self.error_count] = .{
            .path_offset = self.error_path_len,
            .path_len = plen,
            .msg_offset = self.error_msg_len,
            .msg_len = mlen,
        };
        self.error_count += 1;
        self.error_path_len += plen;
        self.error_msg_len += mlen;
    }

    // --- Accessors ---

    pub fn getErrorCount(self: *const ValidatorState) u32 {
        return self.error_count;
    }

    pub fn getErrorPathPtr(self: *const ValidatorState, i: u32) [*]const u8 {
        if (i >= self.error_count) return @ptrFromInt(1);
        const buf = self.error_path_buf orelse return @ptrFromInt(1);
        return buf + self.errors[i].path_offset;
    }

    pub fn getErrorPathLen(self: *const ValidatorState, i: u32) u32 {
        if (i >= self.error_count) return 0;
        return self.errors[i].path_len;
    }

    pub fn getErrorMsgPtr(self: *const ValidatorState, i: u32) [*]const u8 {
        if (i >= self.error_count) return @ptrFromInt(1);
        const buf = self.error_msg_buf orelse return @ptrFromInt(1);
        return buf + self.errors[i].msg_offset;
    }

    pub fn getErrorMsgLen(self: *const ValidatorState, i: u32) u32 {
        if (i >= self.error_count) return 0;
        return self.errors[i].msg_len;
    }
};

// --- Helpers ---

fn typeStringToMask(ptr: [*]const u8, len: u32) u8 {
    const s = ptr[0..len];
    if (std.mem.eql(u8, s, "null")) return TypeMask.NULL;
    if (std.mem.eql(u8, s, "boolean")) return TypeMask.BOOLEAN;
    if (std.mem.eql(u8, s, "number")) return TypeMask.NUMBER | TypeMask.INTEGER;
    if (std.mem.eql(u8, s, "integer")) return TypeMask.INTEGER;
    if (std.mem.eql(u8, s, "string")) return TypeMask.STRING;
    if (std.mem.eql(u8, s, "object")) return TypeMask.OBJECT;
    if (std.mem.eql(u8, s, "array")) return TypeMask.ARRAY;
    return TypeMask.ANY;
}

fn tagToTypeMask(tag: TokenTag) u8 {
    return switch (tag) {
        .null_val => TypeMask.NULL,
        .true_val, .false_val => TypeMask.BOOLEAN,
        .number => TypeMask.NUMBER | TypeMask.INTEGER,
        .string => TypeMask.STRING,
        .object_start => TypeMask.OBJECT,
        .array_start => TypeMask.ARRAY,
        else => 0,
    };
}

fn strEql(a_ptr: [*]const u8, a_len: u32, comptime b: []const u8) bool {
    if (a_len != b.len) return false;
    return std.mem.eql(u8, a_ptr[0..a_len], b);
}

fn strEqlRaw(a_ptr: [*]const u8, a_len: u32, b_ptr: [*]const u8, b_len: u32) bool {
    if (a_len != b_len) return false;
    if (a_len == 0) return true;
    return std.mem.eql(u8, a_ptr[0..a_len], b_ptr[0..b_len]);
}

/// Check if a data value matches a schema enum/const value.
/// Reads and advances the schema reader past the enum element.
fn valuesMatch(data_tag: TokenTag, data_str: StrRef, data_num: f64, sr: *TokenReader) bool {
    const schema_tag = sr.readTag();
    switch (schema_tag) {
        .null_val => return data_tag == .null_val,
        .true_val => return data_tag == .true_val,
        .false_val => return data_tag == .false_val,
        .number => {
            const sn = sr.readF64();
            if (data_tag != .number) return false;
            return data_num == sn;
        },
        .string => {
            const ss = sr.readStringBytes();
            if (data_tag != .string) return false;
            return strEqlRaw(data_str.ptr, data_str.len, ss.ptr, ss.len);
        },
        else => {
            // Complex values in enum (objects/arrays) — skip, don't match scalars
            // Position is already advanced past the tag; skip the rest if it's a container
            if (schema_tag == .object_start or schema_tag == .array_start) {
                // Need to skip the container body. Since we already read the tag,
                // create a dummy position and use skipValue-like logic.
                var depth: i32 = 1;
                while (depth > 0 and !sr.atEnd()) {
                    const t = sr.readTag();
                    if (t == .object_start or t == .array_start) depth += 1;
                    if (t == .object_end or t == .array_end) depth -= 1;
                    if (t == .number) _ = sr.readF64();
                    if (t == .string or t == .key) {
                        const slen = sr.readU32();
                        sr.pos += slen;
                    }
                }
            }
            return false;
        },
    }
}
