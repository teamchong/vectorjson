const std = @import("std");

pub fn build(b: *std.Build) void {
    const optimize = b.standardOptimizeOption(.{});

    // --- zimdjson module (local patched copy) ---
    const zimdjson = b.addModule("zimdjson", .{
        .root_source_file = b.path("deps/zimdjson/src/zimdjson.zig"),
        .target = b.resolveTargetQuery(.{
            .cpu_arch = .wasm32,
            .os_tag = .freestanding,
            .cpu_features_add = std.Target.wasm.featureSet(&.{.simd128}),
        }),
        .optimize = optimize,
    });

    // zimdjson needs build_options with enable_tracy and is_dev_mode
    const build_options = b.addOptions();
    build_options.addOption(bool, "enable_tracy", false);
    build_options.addOption(bool, "is_dev_mode", false);
    zimdjson.addImport("build_options", build_options.createModule());

    // --- Main WASM engine library ---
    const engine = b.addExecutable(.{
        .name = "engine",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/zig/main.zig"),
            .target = b.resolveTargetQuery(.{
                .cpu_arch = .wasm32,
                .os_tag = .freestanding,
                .cpu_features_add = std.Target.wasm.featureSet(&.{.simd128}),
            }),
            .optimize = optimize,
        }),
    });

    engine.root_module.addImport("zimdjson", zimdjson);

    // WASM-specific settings
    engine.entry = .disabled;
    engine.rdynamic = true;
    engine.root_module.export_symbol_names = &.{
        "alloc",
        "dealloc",
        "parse",
        "get_next_token",
        "get_token_number",
        "get_token_string_ptr",
        "get_token_string_len",
        "get_token_bool",
        "reset_tape",
        "get_error_code",
        "get_container_count",
        // Streaming exports
        "stream_create",
        "stream_destroy",
        "stream_feed",
        "stream_get_status",
        "stream_get_buffer_ptr",
        "stream_get_buffer_len",
        "stream_get_value_len",
        "stream_get_remaining_ptr",
        "stream_get_remaining_len",
        // Compare exports
        "compare_parse_a",
        "compare_set_ordered",
        "compare_parse_b",
        "compare_diff_count",
        "compare_diff_path_ptr",
        "compare_diff_path_len",
        "compare_diff_type",
        "compare_free",
        // Validate exports
        "validate_load_schema",
        "validate_check",
        "validate_error_count",
        "validate_error_path_ptr",
        "validate_error_path_len",
        "validate_error_msg_ptr",
        "validate_error_msg_len",
        "validate_free",
        // Stringify exports
        "stringify_init",
        "stringify_null",
        "stringify_bool",
        "stringify_number",
        "stringify_string",
        "stringify_key",
        "stringify_object_start",
        "stringify_object_end",
        "stringify_array_start",
        "stringify_array_end",
        "stringify_result_ptr",
        "stringify_result_len",
        "stringify_free",
        // Document slot exports (Path B: tape-direct navigation)
        "doc_parse",
        "doc_free",
        "doc_get_tag",
        "doc_get_number",
        "doc_get_string_ptr",
        "doc_get_string_len",
        "doc_get_count",
        "doc_find_field",
        "doc_array_at",
        "doc_obj_key_at",
        "doc_obj_val_at",
        // Batch iteration exports
        "doc_batch_ptr",
        "doc_array_elements",
        "doc_object_keys",
        // Doc stringify (tape → JSON bytes, one call)
        "doc_stringify",
    };

    // Install to zig-out/bin/engine.wasm
    b.installArtifact(engine);

    // --- Copy to dist/ for convenience ---
    const install_dist = b.addInstallFile(engine.getEmittedBin(), "../dist/engine.wasm");
    b.getInstallStep().dependOn(&install_dist.step);
}
