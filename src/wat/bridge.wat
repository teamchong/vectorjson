;; VectorJSON WasmGC Bridge
;;
;; Pure WasmGC. One path. No materialization.
;;
;; Zig engine parses JSON → tape. This shim reads the tape and builds
;; a GC object tree (struct.new / array.new). Returns externref to JS.
;; JS uses accessor exports to read values lazily through Proxy.
;;
;; Token types from Zig engine:
;;   0=null, 1=true, 2=false, 3=unsigned, 4=signed, 5=double,
;;   6=string, 7=object_start, 8=object_end, 9=array_start,
;;   10=array_end, 11=key, 12=end_of_tape, 13=error

(module
  ;; ============================================================
  ;; WasmGC Type Hierarchy
  ;; ============================================================

  (type $ByteArray (array (mut i8)))
  (type $JsonValue (sub (struct)))
  (type $JsonNull (sub final $JsonValue (struct)))
  (type $JsonBool (sub final $JsonValue (struct (field $val i32))))
  (type $JsonNumber (sub final $JsonValue (struct (field $val f64))))
  (type $JsonString (sub final $JsonValue (struct (field $bytes (ref $ByteArray)))))
  (type $ValueArray (array (mut (ref null $JsonValue))))
  (type $KeyEntry (struct (field $bytes (ref $ByteArray))))
  (type $KeyArray (array (mut (ref null $KeyEntry))))
  (type $JsonArray (sub final $JsonValue (struct
    (field $items (ref $ValueArray))
    (field $count i32)
  )))
  (type $JsonObject (sub final $JsonValue (struct
    (field $keys (ref $KeyArray))
    (field $values (ref $ValueArray))
    (field $count i32)
  )))

  ;; ============================================================
  ;; Engine Imports
  ;; ============================================================
  (import "engine" "memory" (memory $engine_mem 1))
  (import "engine" "alloc" (func $engine_alloc (param i32) (result i32)))
  (import "engine" "dealloc" (func $engine_dealloc (param i32 i32)))
  (import "engine" "parse" (func $engine_parse (param i32 i32) (result i32)))
  (import "engine" "get_next_token" (func $engine_get_next_token (result i32)))
  (import "engine" "get_token_number" (func $engine_get_token_number (result f64)))
  (import "engine" "get_token_string_ptr" (func $engine_get_token_string_ptr (result i32)))
  (import "engine" "get_token_string_len" (func $engine_get_token_string_len (result i32)))
  (import "engine" "get_token_bool" (func $engine_get_token_bool (result i32)))
  (import "engine" "reset_tape" (func $engine_reset_tape))
  (import "engine" "get_error_code" (func $engine_get_error_code (result i32)))
  (import "engine" "get_container_count" (func $engine_get_container_count (result i32)))

  ;; Streaming
  (import "engine" "stream_create" (func $engine_stream_create (result i32)))
  (import "engine" "stream_destroy" (func $engine_stream_destroy (param i32)))
  (import "engine" "stream_feed" (func $engine_stream_feed (param i32 i32 i32) (result i32)))
  (import "engine" "stream_get_status" (func $engine_stream_get_status (param i32) (result i32)))
  (import "engine" "stream_get_buffer_ptr" (func $engine_stream_get_buffer_ptr (param i32) (result i32)))
  (import "engine" "stream_get_buffer_len" (func $engine_stream_get_buffer_len (param i32) (result i32)))
  (import "engine" "stream_get_remaining_ptr" (func $engine_stream_get_remaining_ptr (param i32) (result i32)))
  (import "engine" "stream_get_value_len" (func $engine_stream_get_value_len (param i32) (result i32)))
  (import "engine" "stream_get_remaining_len" (func $engine_stream_get_remaining_len (param i32) (result i32)))

  ;; Compare
  (import "engine" "compare_parse_a" (func $engine_compare_parse_a (param i32 i32) (result i32)))
  (import "engine" "compare_set_ordered" (func $engine_compare_set_ordered (param i32)))
  (import "engine" "compare_parse_b" (func $engine_compare_parse_b (param i32 i32) (result i32)))
  (import "engine" "compare_diff_count" (func $engine_compare_diff_count (result i32)))
  (import "engine" "compare_diff_path_ptr" (func $engine_compare_diff_path_ptr (param i32) (result i32)))
  (import "engine" "compare_diff_path_len" (func $engine_compare_diff_path_len (param i32) (result i32)))
  (import "engine" "compare_diff_type" (func $engine_compare_diff_type (param i32) (result i32)))
  (import "engine" "compare_free" (func $engine_compare_free))

  ;; Validate
  (import "engine" "validate_load_schema" (func $engine_validate_load_schema (param i32 i32) (result i32)))
  (import "engine" "validate_check" (func $engine_validate_check (param i32 i32) (result i32)))
  (import "engine" "validate_error_count" (func $engine_validate_error_count (result i32)))
  (import "engine" "validate_error_path_ptr" (func $engine_validate_error_path_ptr (param i32) (result i32)))
  (import "engine" "validate_error_path_len" (func $engine_validate_error_path_len (param i32) (result i32)))
  (import "engine" "validate_error_msg_ptr" (func $engine_validate_error_msg_ptr (param i32) (result i32)))
  (import "engine" "validate_error_msg_len" (func $engine_validate_error_msg_len (param i32) (result i32)))
  (import "engine" "validate_free" (func $engine_validate_free))

  ;; Stringify
  (import "engine" "stringify_init" (func $engine_stringify_init))
  (import "engine" "stringify_null" (func $engine_stringify_null))
  (import "engine" "stringify_bool" (func $engine_stringify_bool (param i32)))
  (import "engine" "stringify_number" (func $engine_stringify_number (param f64)))
  (import "engine" "stringify_string" (func $engine_stringify_string (param i32 i32)))
  (import "engine" "stringify_key" (func $engine_stringify_key (param i32 i32)))
  (import "engine" "stringify_object_start" (func $engine_stringify_object_start))
  (import "engine" "stringify_object_end" (func $engine_stringify_object_end))
  (import "engine" "stringify_array_start" (func $engine_stringify_array_start))
  (import "engine" "stringify_array_end" (func $engine_stringify_array_end))
  (import "engine" "stringify_result_ptr" (func $engine_stringify_result_ptr (result i32)))
  (import "engine" "stringify_result_len" (func $engine_stringify_result_len (result i32)))
  (import "engine" "stringify_free" (func $engine_stringify_free))

  ;; ============================================================
  ;; Helpers
  ;; ============================================================

  (func $copy_to_gc (param $ptr i32) (param $len i32) (result (ref $ByteArray))
    (local $arr (ref $ByteArray))
    (local $i i32)
    (local.set $arr (array.new $ByteArray (i32.const 0) (local.get $len)))
    (local.set $i (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
      (array.set $ByteArray (local.get $arr) (local.get $i)
        (i32.load8_u (i32.add (local.get $ptr) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (local.get $arr))

  (func $copy_from_gc (param $arr (ref $ByteArray)) (param $ptr i32)
    (local $i i32) (local $len i32)
    (local.set $len (array.len (local.get $arr)))
    (local.set $i (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
      (i32.store8 (i32.add (local.get $ptr) (local.get $i))
        (array.get_u $ByteArray (local.get $arr) (local.get $i)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop))))

  (func $bytes_equal (param $arr (ref $ByteArray)) (param $mem_ptr i32) (param $len i32) (result i32)
    (local $i i32)
    (if (i32.ne (array.len (local.get $arr)) (local.get $len))
      (then (return (i32.const 0))))
    (local.set $i (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
      (if (i32.ne
            (array.get_u $ByteArray (local.get $arr) (local.get $i))
            (i32.load8_u (i32.add (local.get $mem_ptr) (local.get $i))))
        (then (return (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (i32.const 1))

  ;; ============================================================
  ;; GC Tree Builder — zero JS calls
  ;; ============================================================

  (func $build_gc (result (ref null $JsonValue))
    (local $token i32) (local $count i32) (local $i i32)
    (local $items (ref $ValueArray))
    (local $keys (ref $KeyArray)) (local $values (ref $ValueArray))

    (local.set $token (call $engine_get_next_token))

    (if (i32.eq (local.get $token) (i32.const 0))
      (then (return (struct.new $JsonNull))))
    (if (i32.eq (local.get $token) (i32.const 1))
      (then (return (struct.new $JsonBool (i32.const 1)))))
    (if (i32.eq (local.get $token) (i32.const 2))
      (then (return (struct.new $JsonBool (i32.const 0)))))
    (if (i32.or (i32.eq (local.get $token) (i32.const 3))
          (i32.or (i32.eq (local.get $token) (i32.const 4))
                  (i32.eq (local.get $token) (i32.const 5))))
      (then (return (struct.new $JsonNumber (call $engine_get_token_number)))))
    (if (i32.eq (local.get $token) (i32.const 6))
      (then (return (struct.new $JsonString
        (call $copy_to_gc (call $engine_get_token_string_ptr) (call $engine_get_token_string_len))))))

    ;; array
    (if (i32.eq (local.get $token) (i32.const 9)) (then
      (local.set $count (call $engine_get_container_count))
      (local.set $items (array.new $ValueArray (ref.null none) (local.get $count)))
      (local.set $i (i32.const 0))
      (block $done (loop $loop
        (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
        (array.set $ValueArray (local.get $items) (local.get $i) (call $build_gc))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
      (drop (call $engine_get_next_token))
      (return (struct.new $JsonArray (local.get $items) (local.get $count)))))

    ;; object
    (if (i32.eq (local.get $token) (i32.const 7)) (then
      (local.set $count (call $engine_get_container_count))
      (local.set $keys (array.new $KeyArray (ref.null none) (local.get $count)))
      (local.set $values (array.new $ValueArray (ref.null none) (local.get $count)))
      (local.set $i (i32.const 0))
      (block $done (loop $loop
        (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
        (drop (call $engine_get_next_token))
        (array.set $KeyArray (local.get $keys) (local.get $i)
          (struct.new $KeyEntry
            (call $copy_to_gc (call $engine_get_token_string_ptr) (call $engine_get_token_string_len))))
        (array.set $ValueArray (local.get $values) (local.get $i) (call $build_gc))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
      (drop (call $engine_get_next_token))
      (return (struct.new $JsonObject (local.get $keys) (local.get $values) (local.get $count)))))

    (ref.null $JsonValue))

  ;; ============================================================
  ;; Parse — one path, GC only
  ;; ============================================================

  (func (export "parseJSON") (param $ptr i32) (param $len i32) (result externref)
    (if (i32.ne (call $engine_parse (local.get $ptr) (local.get $len)) (i32.const 0))
      (then (return (ref.null extern))))
    (extern.convert_any (call $build_gc)))

  ;; ============================================================
  ;; GC Accessors
  ;; ============================================================

  (func (export "gcGetTag") (param $ref externref) (result i32)
    (local $val (ref null any))
    (if (ref.is_null (local.get $ref)) (then (return (i32.const 0))))
    (local.set $val (any.convert_extern (local.get $ref)))
    (if (ref.is_null (local.get $val)) (then (return (i32.const 0))))
    (if (ref.test (ref $JsonNull) (local.get $val)) (then (return (i32.const 0))))
    (if (ref.test (ref $JsonBool) (local.get $val)) (then (return (i32.const 1))))
    (if (ref.test (ref $JsonNumber) (local.get $val)) (then (return (i32.const 2))))
    (if (ref.test (ref $JsonString) (local.get $val)) (then (return (i32.const 3))))
    (if (ref.test (ref $JsonArray) (local.get $val)) (then (return (i32.const 4))))
    (if (ref.test (ref $JsonObject) (local.get $val)) (then (return (i32.const 5))))
    (i32.const -1))

  (func (export "gcGetBool") (param $ref externref) (result i32)
    (local $val (ref null any))
    (local.set $val (any.convert_extern (local.get $ref)))
    (if (ref.test (ref $JsonBool) (local.get $val)) (then
      (return (struct.get $JsonBool $val (ref.cast (ref $JsonBool) (local.get $val))))))
    (i32.const 0))

  (func (export "gcGetNumber") (param $ref externref) (result f64)
    (local $val (ref null any))
    (local.set $val (any.convert_extern (local.get $ref)))
    (if (ref.test (ref $JsonNumber) (local.get $val)) (then
      (return (struct.get $JsonNumber $val (ref.cast (ref $JsonNumber) (local.get $val))))))
    (f64.const 0))

  (func (export "gcGetStringLen") (param $ref externref) (result i32)
    (local $val (ref null any))
    (local.set $val (any.convert_extern (local.get $ref)))
    (if (ref.test (ref $JsonString) (local.get $val)) (then
      (return (array.len (struct.get $JsonString $bytes
        (ref.cast (ref $JsonString) (local.get $val)))))))
    (i32.const 0))

  (func (export "gcCopyString") (param $ref externref) (param $dst i32)
    (local $val (ref null any))
    (local.set $val (any.convert_extern (local.get $ref)))
    (if (ref.test (ref $JsonString) (local.get $val)) (then
      (call $copy_from_gc
        (struct.get $JsonString $bytes (ref.cast (ref $JsonString) (local.get $val)))
        (local.get $dst)))))

  (func (export "gcGetArrayLen") (param $ref externref) (result i32)
    (local $val (ref null any))
    (local.set $val (any.convert_extern (local.get $ref)))
    (if (ref.test (ref $JsonArray) (local.get $val)) (then
      (return (struct.get $JsonArray $count (ref.cast (ref $JsonArray) (local.get $val))))))
    (i32.const 0))

  (func (export "gcGetArrayItem") (param $ref externref) (param $idx i32) (result externref)
    (local $val (ref null any)) (local $arr (ref $JsonArray))
    (local.set $val (any.convert_extern (local.get $ref)))
    (if (i32.eqz (ref.test (ref $JsonArray) (local.get $val)))
      (then (return (ref.null extern))))
    (local.set $arr (ref.cast (ref $JsonArray) (local.get $val)))
    (if (i32.ge_u (local.get $idx) (struct.get $JsonArray $count (local.get $arr)))
      (then (return (ref.null extern))))
    (extern.convert_any
      (array.get $ValueArray (struct.get $JsonArray $items (local.get $arr)) (local.get $idx))))

  (func (export "gcGetObjectLen") (param $ref externref) (result i32)
    (local $val (ref null any))
    (local.set $val (any.convert_extern (local.get $ref)))
    (if (ref.test (ref $JsonObject) (local.get $val)) (then
      (return (struct.get $JsonObject $count (ref.cast (ref $JsonObject) (local.get $val))))))
    (i32.const 0))

  (func (export "gcGetObjectKeyLen") (param $ref externref) (param $idx i32) (result i32)
    (local $val (ref null any)) (local $obj (ref $JsonObject)) (local $key (ref $KeyEntry))
    (local.set $val (any.convert_extern (local.get $ref)))
    (if (i32.eqz (ref.test (ref $JsonObject) (local.get $val)))
      (then (return (i32.const 0))))
    (local.set $obj (ref.cast (ref $JsonObject) (local.get $val)))
    (if (i32.ge_u (local.get $idx) (struct.get $JsonObject $count (local.get $obj)))
      (then (return (i32.const 0))))
    (local.set $key (ref.cast (ref $KeyEntry)
      (array.get $KeyArray (struct.get $JsonObject $keys (local.get $obj)) (local.get $idx))))
    (array.len (struct.get $KeyEntry $bytes (local.get $key))))

  (func (export "gcCopyObjectKey") (param $ref externref) (param $idx i32) (param $dst i32)
    (local $val (ref null any)) (local $obj (ref $JsonObject)) (local $key (ref $KeyEntry))
    (local.set $val (any.convert_extern (local.get $ref)))
    (if (i32.eqz (ref.test (ref $JsonObject) (local.get $val))) (then (return)))
    (local.set $obj (ref.cast (ref $JsonObject) (local.get $val)))
    (if (i32.ge_u (local.get $idx) (struct.get $JsonObject $count (local.get $obj)))
      (then (return)))
    (local.set $key (ref.cast (ref $KeyEntry)
      (array.get $KeyArray (struct.get $JsonObject $keys (local.get $obj)) (local.get $idx))))
    (call $copy_from_gc (struct.get $KeyEntry $bytes (local.get $key)) (local.get $dst)))

  (func (export "gcGetObjectValue") (param $ref externref) (param $idx i32) (result externref)
    (local $val (ref null any)) (local $obj (ref $JsonObject))
    (local.set $val (any.convert_extern (local.get $ref)))
    (if (i32.eqz (ref.test (ref $JsonObject) (local.get $val)))
      (then (return (ref.null extern))))
    (local.set $obj (ref.cast (ref $JsonObject) (local.get $val)))
    (if (i32.ge_u (local.get $idx) (struct.get $JsonObject $count (local.get $obj)))
      (then (return (ref.null extern))))
    (extern.convert_any
      (array.get $ValueArray (struct.get $JsonObject $values (local.get $obj)) (local.get $idx))))

  (func (export "gcFindProperty") (param $ref externref) (param $key_ptr i32) (param $key_len i32) (result externref)
    (local $val (ref null any)) (local $obj (ref $JsonObject))
    (local $count i32) (local $i i32) (local $key_entry (ref $KeyEntry))
    (local.set $val (any.convert_extern (local.get $ref)))
    (if (i32.eqz (ref.test (ref $JsonObject) (local.get $val)))
      (then (return (ref.null extern))))
    (local.set $obj (ref.cast (ref $JsonObject) (local.get $val)))
    (local.set $count (struct.get $JsonObject $count (local.get $obj)))
    (local.set $i (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $key_entry (ref.cast (ref $KeyEntry)
        (array.get $KeyArray (struct.get $JsonObject $keys (local.get $obj)) (local.get $i))))
      (if (call $bytes_equal (struct.get $KeyEntry $bytes (local.get $key_entry))
            (local.get $key_ptr) (local.get $key_len))
        (then (return (extern.convert_any
          (array.get $ValueArray (struct.get $JsonObject $values (local.get $obj)) (local.get $i))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (ref.null extern))

  ;; Compare two GC byte arrays for equality (no JS strings created)
  (func $gc_bytes_equal (param $a (ref $ByteArray)) (param $b (ref $ByteArray)) (result i32)
    (local $len i32) (local $i i32)
    (local.set $len (array.len (local.get $a)))
    (if (i32.ne (local.get $len) (array.len (local.get $b)))
      (then (return (i32.const 0))))
    (local.set $i (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
      (if (i32.ne
            (array.get_u $ByteArray (local.get $a) (local.get $i))
            (array.get_u $ByteArray (local.get $b) (local.get $i)))
        (then (return (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (i32.const 1))

  ;; Create a $JsonString GC struct from linear memory bytes.
  ;; Used by the doc-slot path to wrap string values as WasmString
  ;; without building the full GC tree. The GC byte array survives
  ;; even after the doc slot is freed.
  (func (export "createGCString") (param $ptr i32) (param $len i32) (result externref)
    (extern.convert_any
      (struct.new $JsonString
        (call $copy_to_gc (local.get $ptr) (local.get $len)))))

  ;; Compare two $JsonString externrefs for equality without creating JS strings
  (func (export "gcStringEquals") (param $ref1 externref) (param $ref2 externref) (result i32)
    (local $v1 (ref null any)) (local $v2 (ref null any))
    (local.set $v1 (any.convert_extern (local.get $ref1)))
    (local.set $v2 (any.convert_extern (local.get $ref2)))
    (if (i32.eqz (ref.test (ref $JsonString) (local.get $v1)))
      (then (return (i32.const 0))))
    (if (i32.eqz (ref.test (ref $JsonString) (local.get $v2)))
      (then (return (i32.const 0))))
    (call $gc_bytes_equal
      (struct.get $JsonString $bytes (ref.cast (ref $JsonString) (local.get $v1)))
      (struct.get $JsonString $bytes (ref.cast (ref $JsonString) (local.get $v2)))))

  ;; ============================================================
  ;; GC Stringify — walk GC tree, produce JSON bytes in engine memory
  ;; Zero JS calls. One WASM call from JS → full JSON output.
  ;; ============================================================

  (func $gc_stringify_value (param $ref (ref null $JsonValue))
    (local $arr (ref $JsonArray)) (local $obj (ref $JsonObject))
    (local $count i32) (local $i i32) (local $str (ref $ByteArray))
    (local $str_ptr i32) (local $str_len i32)

    ;; null
    (if (ref.is_null (local.get $ref))
      (then (call $engine_stringify_null) (return)))
    (if (ref.test (ref $JsonNull) (local.get $ref))
      (then (call $engine_stringify_null) (return)))

    ;; bool
    (if (ref.test (ref $JsonBool) (local.get $ref)) (then
      (call $engine_stringify_bool
        (struct.get $JsonBool $val (ref.cast (ref $JsonBool) (local.get $ref))))
      (return)))

    ;; number
    (if (ref.test (ref $JsonNumber) (local.get $ref)) (then
      (call $engine_stringify_number
        (struct.get $JsonNumber $val (ref.cast (ref $JsonNumber) (local.get $ref))))
      (return)))

    ;; string — copy GC bytes to linear memory, call stringify_string
    (if (ref.test (ref $JsonString) (local.get $ref)) (then
      (local.set $str (struct.get $JsonString $bytes (ref.cast (ref $JsonString) (local.get $ref))))
      (local.set $str_len (array.len (local.get $str)))
      (if (i32.eqz (local.get $str_len))
        (then
          (call $engine_stringify_string (i32.const 1) (i32.const 0))
          (return)))
      (local.set $str_ptr (call $engine_alloc (local.get $str_len)))
      (call $copy_from_gc (local.get $str) (local.get $str_ptr))
      (call $engine_stringify_string (local.get $str_ptr) (local.get $str_len))
      (call $engine_dealloc (local.get $str_ptr) (local.get $str_len))
      (return)))

    ;; array
    (if (ref.test (ref $JsonArray) (local.get $ref)) (then
      (local.set $arr (ref.cast (ref $JsonArray) (local.get $ref)))
      (local.set $count (struct.get $JsonArray $count (local.get $arr)))
      (call $engine_stringify_array_start)
      (local.set $i (i32.const 0))
      (block $done (loop $loop
        (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
        (call $gc_stringify_value
          (array.get $ValueArray (struct.get $JsonArray $items (local.get $arr)) (local.get $i)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
      (call $engine_stringify_array_end)
      (return)))

    ;; object
    (if (ref.test (ref $JsonObject) (local.get $ref)) (then
      (local.set $obj (ref.cast (ref $JsonObject) (local.get $ref)))
      (local.set $count (struct.get $JsonObject $count (local.get $obj)))
      (call $engine_stringify_object_start)
      (local.set $i (i32.const 0))
      (block $done (loop $loop
        (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
        ;; Write key: copy key bytes to linear memory
        (local.set $str (struct.get $KeyEntry $bytes (ref.cast (ref $KeyEntry)
          (array.get $KeyArray (struct.get $JsonObject $keys (local.get $obj)) (local.get $i)))))
        (local.set $str_len (array.len (local.get $str)))
        (if (i32.eqz (local.get $str_len))
          (then (call $engine_stringify_key (i32.const 1) (i32.const 0)))
          (else
            (local.set $str_ptr (call $engine_alloc (local.get $str_len)))
            (call $copy_from_gc (local.get $str) (local.get $str_ptr))
            (call $engine_stringify_key (local.get $str_ptr) (local.get $str_len))
            (call $engine_dealloc (local.get $str_ptr) (local.get $str_len))))
        ;; Write value
        (call $gc_stringify_value
          (array.get $ValueArray (struct.get $JsonObject $values (local.get $obj)) (local.get $i)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
      (call $engine_stringify_object_end)
      (return)))

    ;; fallback
    (call $engine_stringify_null))

  ;; Public export: stringify a GC value tree → JSON bytes
  ;; Call stringify_result_ptr/len to get the result. Caller must call stringify_free.
  (func (export "gcStringify") (param $ref externref)
    (call $engine_stringify_init)
    (call $gc_stringify_value
      (ref.cast (ref null $JsonValue) (any.convert_extern (local.get $ref)))))

  ;; ============================================================
  ;; Memory management
  ;; ============================================================

  (func (export "alloc") (param $size i32) (result i32)
    (call $engine_alloc (local.get $size)))
  (func (export "dealloc") (param $ptr i32) (param $size i32)
    (call $engine_dealloc (local.get $ptr) (local.get $size)))
  (func (export "getError") (result i32) (call $engine_get_error_code))
  (func (export "reset") (call $engine_reset_tape))

  ;; ============================================================
  ;; Streaming
  ;; ============================================================

  (func (export "streamCreate") (result i32) (call $engine_stream_create))
  (func (export "streamDestroy") (param $id i32) (call $engine_stream_destroy (local.get $id)))
  (func (export "streamFeed") (param $id i32) (param $ptr i32) (param $len i32) (result i32)
    (call $engine_stream_feed (local.get $id) (local.get $ptr) (local.get $len)))
  (func (export "streamGetStatus") (param $id i32) (result i32)
    (call $engine_stream_get_status (local.get $id)))

  (func (export "streamGetValue") (param $id i32) (result externref)
    (local $buf_ptr i32) (local $val_len i32)
    (local.set $buf_ptr (call $engine_stream_get_buffer_ptr (local.get $id)))
    (local.set $val_len (call $engine_stream_get_value_len (local.get $id)))
    (if (i32.ne (call $engine_parse (local.get $buf_ptr) (local.get $val_len)) (i32.const 0))
      (then (return (ref.null extern))))
    (extern.convert_any (call $build_gc)))

  (func (export "streamRemainingPtr") (param $id i32) (result i32)
    (call $engine_stream_get_remaining_ptr (local.get $id)))
  (func (export "streamRemainingLen") (param $id i32) (result i32)
    (call $engine_stream_get_remaining_len (local.get $id)))

  ;; ============================================================
  ;; Stringify (passthrough)
  ;; ============================================================

  (func (export "stringifyInit") (call $engine_stringify_init))
  (func (export "stringifyNull") (call $engine_stringify_null))
  (func (export "stringifyBool") (param $val i32) (call $engine_stringify_bool (local.get $val)))
  (func (export "stringifyNumber") (param $val f64) (call $engine_stringify_number (local.get $val)))
  (func (export "stringifyString") (param $ptr i32) (param $len i32) (call $engine_stringify_string (local.get $ptr) (local.get $len)))
  (func (export "stringifyKey") (param $ptr i32) (param $len i32) (call $engine_stringify_key (local.get $ptr) (local.get $len)))
  (func (export "stringifyObjectStart") (call $engine_stringify_object_start))
  (func (export "stringifyObjectEnd") (call $engine_stringify_object_end))
  (func (export "stringifyArrayStart") (call $engine_stringify_array_start))
  (func (export "stringifyArrayEnd") (call $engine_stringify_array_end))
  (func (export "stringifyResultPtr") (result i32) (call $engine_stringify_result_ptr))
  (func (export "stringifyResultLen") (result i32) (call $engine_stringify_result_len))
  (func (export "stringifyFree") (call $engine_stringify_free))

  ;; ============================================================
  ;; Compare (passthrough)
  ;; ============================================================

  (func (export "compareParseA") (param $ptr i32) (param $len i32) (result i32)
    (call $engine_compare_parse_a (local.get $ptr) (local.get $len)))
  (func (export "compareSetOrdered") (param $ordered i32)
    (call $engine_compare_set_ordered (local.get $ordered)))
  (func (export "compareParseB") (param $ptr i32) (param $len i32) (result i32)
    (call $engine_compare_parse_b (local.get $ptr) (local.get $len)))
  (func (export "compareDiffCount") (result i32) (call $engine_compare_diff_count))
  (func (export "compareDiffPathPtr") (param $i i32) (result i32) (call $engine_compare_diff_path_ptr (local.get $i)))
  (func (export "compareDiffPathLen") (param $i i32) (result i32) (call $engine_compare_diff_path_len (local.get $i)))
  (func (export "compareDiffType") (param $i i32) (result i32) (call $engine_compare_diff_type (local.get $i)))
  (func (export "compareFree") (call $engine_compare_free))

  ;; ============================================================
  ;; Validate (passthrough)
  ;; ============================================================

  (func (export "validateLoadSchema") (param $ptr i32) (param $len i32) (result i32)
    (call $engine_validate_load_schema (local.get $ptr) (local.get $len)))
  (func (export "validateCheck") (param $ptr i32) (param $len i32) (result i32)
    (call $engine_validate_check (local.get $ptr) (local.get $len)))
  (func (export "validateErrorCount") (result i32) (call $engine_validate_error_count))
  (func (export "validateErrorPathPtr") (param $i i32) (result i32) (call $engine_validate_error_path_ptr (local.get $i)))
  (func (export "validateErrorPathLen") (param $i i32) (result i32) (call $engine_validate_error_path_len (local.get $i)))
  (func (export "validateErrorMsgPtr") (param $i i32) (result i32) (call $engine_validate_error_msg_ptr (local.get $i)))
  (func (export "validateErrorMsgLen") (param $i i32) (result i32) (call $engine_validate_error_msg_len (local.get $i)))
  (func (export "validateFree") (call $engine_validate_free))
)
