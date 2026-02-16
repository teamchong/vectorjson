const std = @import("std");

pub fn build(b: *std.Build) void {
    const optimize = b.standardOptimizeOption(.{});

    const wasm_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
        .cpu_features_add = std.Target.wasm.featureSet(&.{.simd128}),
    });

    // --- zimdjson module (local patched copy) ---
    const zimdjson = b.addModule("zimdjson", .{
        .root_source_file = b.path("deps/zimdjson/src/zimdjson.zig"),
        .target = wasm_target,
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
            .target = wasm_target,
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
        // Document slot exports (tape-direct navigation)
        "doc_parse",
        "doc_free",
        "doc_get_tag",
        "doc_get_number",
        "doc_read_string_raw",
        "doc_get_count",
        "doc_get_src_pos",
        "doc_get_close_index",
        "doc_find_field",
        "doc_batch_ptr",
        "doc_array_elements",
        "doc_object_keys",
        // Streaming parser
        "stream_create",
        "stream_destroy",
        "stream_feed",
        "stream_get_status",
        "stream_get_buffer_ptr",
        "stream_get_value_len",
        "stream_get_remaining_ptr",
        "stream_get_remaining_len",
        // Input classification & autocomplete
        "classify_input",
        "autocomplete_input",
        "get_value_end",
        // Error code
        "get_error_code",
    };

    // Install to zig-out/bin/engine.wasm
    b.installArtifact(engine);

    // --- Copy to dist/ for convenience ---
    const install_dist = b.addInstallFile(engine.getEmittedBin(), "../dist/engine.wasm");
    b.getInstallStep().dependOn(&install_dist.step);
}
