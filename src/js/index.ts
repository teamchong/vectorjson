/**
 * VectorJSON — SIMD-accelerated JSON parser with WasmGC bridge
 *
 * Architecture:
 *   JS bytes → [Zig + zimdjson SIMD] → tape → lazy Proxy over doc slots
 *   Streaming: JS chunks → [WAT bridge] → GC tree → lazy Proxy over externref
 *
 * The Zig engine (engine.wasm) parses JSON bytes into an internal tape format
 * using SIMD-accelerated algorithms from zimdjson.
 *
 * Primary parse path: doc-slot (tape-direct navigation via Zig exports).
 *   FinalizationRegistry auto-frees doc slots when the Proxy is GC'd.
 *   Users CAN call .free() to release immediately if desired.
 *
 * Streaming path: WAT bridge builds a GC-managed object tree from tape.
 *
 * String values are returned as WasmString objects — bytes stay in WasmGC
 * memory (array i8), never creating intermediate JS strings unless
 * explicitly requested via .toString().
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// --- Types ---

export type FeedStatus = "incomplete" | "complete" | "error" | "end_early";

export type DiffType = "changed" | "added" | "removed" | "type_changed";

export interface ValidationError {
  /** JSON path where the error occurs */
  path: string;
  /** Error message */
  message: string;
}

export interface ValidationResult {
  /** Whether the data is valid */
  valid: boolean;
  /** List of validation errors (empty if valid) */
  errors: ValidationError[];
}

export interface DiffEntry {
  /** JSON path where the difference occurs (e.g. "$.items[0].name") */
  path: string;
  /** Type of difference */
  type: DiffType;
}

export interface StreamingParser {
  /** Feed a chunk of bytes. Returns the current status. */
  feed(chunk: Uint8Array | string): FeedStatus;
  /** Get the parsed value (materializes the full object tree). */
  getValue(path?: string): unknown;
  /** Get any remaining bytes after a complete value (for NDJSON). */
  getRemaining(): Uint8Array | null;
  /** Get the current status. */
  getStatus(): FeedStatus;
  /** Destroy the parser and free resources. */
  destroy(): void;
}

export interface VectorJSON {
  /**
   * Parse a JSON string or Uint8Array into a value.
   * Primitives (null, boolean, number) are returned directly as JS values.
   * Strings are returned as WasmString objects (bytes stay in WasmGC memory).
   * Objects and arrays return Proxy objects — values materialize only when accessed.
   * Call .free() on the result to release resources immediately, or let
   * FinalizationRegistry handle it automatically when the Proxy is GC'd.
   */
  parse(input: string | Uint8Array): unknown;
  /**
   * Eagerly materialize a lazy proxy into plain JS objects.
   * WasmString values are converted to JS strings.
   * If the value is already a plain JS value, returns it as-is.
   */
  materialize(value: unknown): unknown;
  /** Stringify a JS value to a JSON string. */
  stringify(value: unknown): string;
  /** Validate data against a JSON Schema. */
  validate(data: unknown, schema: Record<string, unknown>): ValidationResult;
  /** Deep compare two values and return a list of structural diffs. */
  deepCompare(
    a: unknown,
    b: unknown,
    options?: { ordered?: boolean },
  ): DiffEntry[];
  /** Create a streaming parser for incremental parsing. */
  createParser(): StreamingParser;
  /** Check if a value is a WasmString */
  isWasmString(value: unknown): value is WasmString;
}

// --- Error codes from Zig engine ---
const ERROR_MESSAGES: Record<number, string> = {
  1: "Exceeded maximum nesting depth",
  2: "Document exceeds maximum capacity",
  3: "Invalid escape sequence",
  4: "Invalid Unicode code point",
  5: "Invalid number literal",
  6: "Expected colon after key",
  7: "Expected string key in object",
  8: "Expected comma or closing bracket in array",
  9: "Expected comma or closing brace in object",
  10: "Incomplete array",
  11: "Incomplete object",
  12: "Unexpected trailing content",
  13: "Out of memory",
  99: "Unknown parse error",
};

const STATUS_MAP: Record<number, FeedStatus> = {
  0: "incomplete",
  1: "complete",
  2: "error",
  3: "end_early",
};

// --- Module types ---

interface EngineExports {
  memory: WebAssembly.Memory;
  alloc(size: number): number;
  dealloc(ptr: number, size: number): void;
  parse(ptr: number, len: number): number;
  get_next_token(): number;
  get_token_number(): number;
  get_token_string_ptr(): number;
  get_token_string_len(): number;
  get_token_bool(): number;
  reset_tape(): void;
  get_error_code(): number;
  get_container_count(): number;
  // Streaming
  stream_create(): number;
  stream_destroy(id: number): void;
  stream_feed(id: number, ptr: number, len: number): number;
  stream_get_status(id: number): number;
  stream_get_buffer_ptr(id: number): number;
  stream_get_buffer_len(id: number): number;
  stream_get_value_len(id: number): number;
  stream_get_remaining_ptr(id: number): number;
  stream_get_remaining_len(id: number): number;
  // Stringify
  stringify_init(): void;
  stringify_null(): void;
  stringify_bool(val: number): void;
  stringify_number(val: number): void;
  stringify_string(ptr: number, len: number): void;
  stringify_key(ptr: number, len: number): void;
  stringify_object_start(): void;
  stringify_object_end(): void;
  stringify_array_start(): void;
  stringify_array_end(): void;
  stringify_result_ptr(): number;
  stringify_result_len(): number;
  stringify_free(): void;
  // Compare
  // Validate
  validate_load_schema(ptr: number, len: number): number;
  validate_check(ptr: number, len: number): number;
  validate_error_count(): number;
  validate_error_path_ptr(i: number): number;
  validate_error_path_len(i: number): number;
  validate_error_msg_ptr(i: number): number;
  validate_error_msg_len(i: number): number;
  validate_free(): void;
  // Compare
  compare_parse_a(ptr: number, len: number): number;
  compare_set_ordered(ordered: number): void;
  compare_parse_b(ptr: number, len: number): number;
  compare_diff_count(): number;
  compare_diff_path_ptr(index: number): number;
  compare_diff_path_len(index: number): number;
  compare_diff_type(index: number): number;
  compare_free(): void;
  // Document slots (Path B: tape-direct navigation)
  doc_parse(ptr: number, len: number): number;
  doc_free(docId: number): void;
  doc_get_tag(docId: number, index: number): number;
  doc_get_number(docId: number, index: number): number;
  doc_get_string_ptr(docId: number, index: number): number;
  doc_get_string_len(docId: number, index: number): number;
  doc_get_count(docId: number, index: number): number;
  doc_find_field(
    docId: number,
    objIndex: number,
    keyPtr: number,
    keyLen: number,
  ): number;
  doc_array_at(docId: number, arrIndex: number, n: number): number;
  doc_obj_key_at(docId: number, objIndex: number, n: number): number;
  doc_obj_val_at(docId: number, objIndex: number, n: number): number;
  // Batch iteration
  doc_batch_ptr(): number;
  doc_array_elements(docId: number, arrIndex: number): number;
  doc_object_keys(docId: number, objIndex: number): number;
}

interface BridgeExports {
  parseJSON(ptr: number, len: number): unknown;
  alloc(size: number): number;
  dealloc(ptr: number, size: number): void;
  getError(): number;
  reset(): void;
  // GC Accessors (zero-copy)
  gcGetTag(ref: unknown): number;
  gcGetBool(ref: unknown): number;
  gcGetNumber(ref: unknown): number;
  gcGetStringLen(ref: unknown): number;
  gcCopyString(ref: unknown, dst: number): void;
  gcGetArrayLen(ref: unknown): number;
  gcGetArrayItem(ref: unknown, idx: number): unknown;
  gcGetObjectLen(ref: unknown): number;
  gcGetObjectKeyLen(ref: unknown, idx: number): number;
  gcCopyObjectKey(ref: unknown, idx: number, dst: number): void;
  gcGetObjectValue(ref: unknown, idx: number): unknown;
  gcFindProperty(ref: unknown, keyPtr: number, keyLen: number): unknown;
  // GC String creation (from linear memory bytes → GC $JsonString)
  createGCString(ptr: number, len: number): unknown;
  // GC String equality (no JS strings created)
  gcStringEquals(ref1: unknown, ref2: unknown): number;
  // GC Stringify (walk GC tree → JSON bytes in one WASM call)
  gcStringify(ref: unknown): void;
  // Streaming
  streamCreate(): number;
  streamDestroy(id: number): void;
  streamFeed(id: number, ptr: number, len: number): number;
  streamGetStatus(id: number): number;
  streamGetValue(id: number): unknown;
  streamRemainingPtr(id: number): number;
  streamRemainingLen(id: number): number;
  // Stringify
  stringifyInit(): void;
  stringifyNull(): void;
  stringifyBool(val: number): void;
  stringifyNumber(val: number): void;
  stringifyString(ptr: number, len: number): void;
  stringifyKey(ptr: number, len: number): void;
  stringifyObjectStart(): void;
  stringifyObjectEnd(): void;
  stringifyArrayStart(): void;
  stringifyArrayEnd(): void;
  stringifyResultPtr(): number;
  stringifyResultLen(): number;
  stringifyFree(): void;
  // Validate
  validateLoadSchema(ptr: number, len: number): number;
  validateCheck(ptr: number, len: number): number;
  validateErrorCount(): number;
  validateErrorPathPtr(i: number): number;
  validateErrorPathLen(i: number): number;
  validateErrorMsgPtr(i: number): number;
  validateErrorMsgLen(i: number): number;
  validateFree(): void;
  // Compare
  compareParseA(ptr: number, len: number): number;
  compareSetOrdered(ordered: number): void;
  compareParseB(ptr: number, len: number): number;
  compareDiffCount(): number;
  compareDiffPathPtr(index: number): number;
  compareDiffPathLen(index: number): number;
  compareDiffType(index: number): number;
  compareFree(): void;
}

// --- WasmString: string data stays in WasmGC memory ---

const WASM_STRING_BRAND = Symbol("vectorjson.WasmString");

/**
 * A string backed by WasmGC memory (array i8).
 * No JS string is created at parse time — bytes stay in WASM.
 * Call .toString() to materialize a JS string when needed.
 * Supports automatic coercion via Symbol.toPrimitive for
 * template literals, loose comparison, and console.log.
 */
export class WasmString {
  /** @internal WasmGC externref to a $JsonString struct */
  readonly _ref: unknown;
  /** @internal Cached byte length */
  readonly _len: number;
  /** @internal Cached JS string (created lazily on first toString()) */
  _cached: string | null = null;
  /** @internal Brand for instanceof-free type checking */
  readonly [WASM_STRING_BRAND] = true;

  /** @internal */
  constructor(
    ref: unknown,
    len: number,
    private _bridge: BridgeExports,
    private _engine: EngineExports,
    private _decoder: TextDecoder,
  ) {
    this._ref = ref;
    this._len = len;
  }

  /** Byte length of the UTF-8 string data */
  get byteLength(): number {
    return this._len;
  }

  /** Raw UTF-8 bytes (copies from WasmGC to a new Uint8Array) */
  get bytes(): Uint8Array {
    if (this._len === 0) return new Uint8Array(0);
    const ptr = this._bridge.alloc(this._len);
    if (ptr === 0) throw new Error("VectorJSON: Failed to allocate for bytes");
    try {
      this._bridge.gcCopyString(this._ref, ptr);
      const result = new Uint8Array(this._len);
      result.set(new Uint8Array(this._engine.memory.buffer, ptr, this._len));
      return result;
    } finally {
      this._bridge.dealloc(ptr, this._len);
    }
  }

  /** Materialize a JS string. Cached after first call. */
  toString(): string {
    if (this._cached !== null) return this._cached;
    if (this._len === 0) {
      this._cached = "";
      return "";
    }
    const ptr = this._bridge.alloc(this._len);
    if (ptr === 0) throw new Error("VectorJSON: Failed to allocate for string");
    try {
      this._bridge.gcCopyString(this._ref, ptr);
      this._cached = this._decoder.decode(
        new Uint8Array(this._engine.memory.buffer, ptr, this._len),
      );
      return this._cached;
    } finally {
      this._bridge.dealloc(ptr, this._len);
    }
  }

  /** Compare two WasmStrings in WASM without creating JS strings */
  equals(other: WasmString): boolean {
    if (!(WASM_STRING_BRAND in other)) return false;
    if (this._len !== other._len) return false;
    if (this._len === 0) return true;
    return this._bridge.gcStringEquals(this._ref, other._ref) !== 0;
  }

  /** Auto-coerce to JS string for template literals, loose comparison, etc. */
  [Symbol.toPrimitive](_hint: string): string {
    return this.toString();
  }

  /** For JSON.stringify compatibility */
  toJSON(): string {
    return this.toString();
  }

  valueOf(): string {
    return this.toString();
  }
}

let _instance: VectorJSON | null = null;

/**
 * Initialize VectorJSON by loading and linking the WASM modules.
 * Call this once; subsequent calls return the cached instance.
 */
export async function init(options?: {
  engineWasm?: string | URL | BufferSource;
  bridgeWasm?: string | URL | BufferSource;
}): Promise<VectorJSON> {
  if (_instance) return _instance;

  // Resolve WASM file paths
  const distDir =
    typeof __dirname !== "undefined"
      ? __dirname
      : dirname(fileURLToPath(import.meta.url));

  const enginePath = join(distDir, "engine.wasm");
  const bridgePath = join(distDir, "bridge.wasm");

  // Load WASM bytes
  const engineBytes =
    options?.engineWasm instanceof ArrayBuffer ||
    ArrayBuffer.isView(options?.engineWasm)
      ? (options!.engineWasm as BufferSource)
      : await readFile(
          typeof options?.engineWasm === "string"
            ? options.engineWasm
            : options?.engineWasm instanceof URL
              ? fileURLToPath(options.engineWasm)
              : enginePath,
        );

  const bridgeBytes =
    options?.bridgeWasm instanceof ArrayBuffer ||
    ArrayBuffer.isView(options?.bridgeWasm)
      ? (options!.bridgeWasm as BufferSource)
      : await readFile(
          typeof options?.bridgeWasm === "string"
            ? options.bridgeWasm
            : options?.bridgeWasm instanceof URL
              ? fileURLToPath(options.bridgeWasm)
              : bridgePath,
        );

  // --- Instantiate Zig engine first ---
  const engineModule = await WebAssembly.compile(engineBytes);
  const engineInstance = await WebAssembly.instantiate(engineModule, {});
  const engine = engineInstance.exports as unknown as EngineExports;

  // --- Text decoder for reading strings from engine memory ---
  const decoder = new TextDecoder("utf-8");

  function readString(ptr: number, len: number): string {
    return decoder.decode(new Uint8Array(engine.memory.buffer, ptr, len));
  }

  // --- Instantiate WAT bridge, linking to engine ---
  const bridgeModule = await WebAssembly.compile(bridgeBytes);
  const bridgeInstance = await WebAssembly.instantiate(bridgeModule, {
    engine: {
      memory: engine.memory,
      alloc: engine.alloc,
      dealloc: engine.dealloc,
      parse: engine.parse,
      get_next_token: engine.get_next_token,
      get_token_number: engine.get_token_number,
      get_token_string_ptr: engine.get_token_string_ptr,
      get_token_string_len: engine.get_token_string_len,
      get_token_bool: engine.get_token_bool,
      reset_tape: engine.reset_tape,
      get_error_code: engine.get_error_code,
      get_container_count: engine.get_container_count,
      // Streaming
      stream_create: engine.stream_create,
      stream_destroy: engine.stream_destroy,
      stream_feed: engine.stream_feed,
      stream_get_status: engine.stream_get_status,
      stream_get_buffer_ptr: engine.stream_get_buffer_ptr,
      stream_get_buffer_len: engine.stream_get_buffer_len,
      stream_get_value_len: engine.stream_get_value_len,
      stream_get_remaining_ptr: engine.stream_get_remaining_ptr,
      stream_get_remaining_len: engine.stream_get_remaining_len,
      // Stringify
      // Validate
      validate_load_schema: engine.validate_load_schema,
      validate_check: engine.validate_check,
      validate_error_count: engine.validate_error_count,
      validate_error_path_ptr: engine.validate_error_path_ptr,
      validate_error_path_len: engine.validate_error_path_len,
      validate_error_msg_ptr: engine.validate_error_msg_ptr,
      validate_error_msg_len: engine.validate_error_msg_len,
      validate_free: engine.validate_free,
      // Compare
      compare_parse_a: engine.compare_parse_a,
      compare_set_ordered: engine.compare_set_ordered,
      compare_parse_b: engine.compare_parse_b,
      compare_diff_count: engine.compare_diff_count,
      compare_diff_path_ptr: engine.compare_diff_path_ptr,
      compare_diff_path_len: engine.compare_diff_path_len,
      compare_diff_type: engine.compare_diff_type,
      compare_free: engine.compare_free,
      // Stringify
      stringify_init: engine.stringify_init,
      stringify_null: engine.stringify_null,
      stringify_bool: engine.stringify_bool,
      stringify_number: engine.stringify_number,
      stringify_string: engine.stringify_string,
      stringify_key: engine.stringify_key,
      stringify_object_start: engine.stringify_object_start,
      stringify_object_end: engine.stringify_object_end,
      stringify_array_start: engine.stringify_array_start,
      stringify_array_end: engine.stringify_array_end,
      stringify_result_ptr: engine.stringify_result_ptr,
      stringify_result_len: engine.stringify_result_len,
      stringify_free: engine.stringify_free,
    },
  });

  const bridge = bridgeInstance.exports as unknown as BridgeExports;
  const encoder = new TextEncoder();

  // --- Stringify helper: copy a JS string into engine memory ---
  function writeStringToMemory(str: string): { ptr: number; len: number } {
    const bytes = encoder.encode(str);
    const len = bytes.byteLength;
    if (len === 0) {
      // Zero-length alloc returns null — use a dummy pointer since
      // the callee won't read any bytes anyway.
      return { ptr: 1, len: 0 };
    }
    const ptr = bridge.alloc(len);
    if (ptr === 0) {
      throw new Error("VectorJSON: Failed to allocate memory for string");
    }
    new Uint8Array(engine.memory.buffer, ptr, len).set(bytes);
    return { ptr, len };
  }

  // --- Stringify helper: recursively write a JS value ---
  function writeValue(value: unknown): void {
    if (value === null) {
      bridge.stringifyNull();
      return;
    }

    if (value === undefined) {
      // undefined at root → undefined (caller handles)
      // undefined in arrays → null (matches JSON.stringify)
      bridge.stringifyNull();
      return;
    }

    // Handle WasmString — write its bytes directly without creating JS string
    if (value instanceof WasmString) {
      const ws = value;
      if (ws._len === 0) {
        bridge.stringifyString(1, 0);
        return;
      }
      const ptr = bridge.alloc(ws._len);
      if (ptr === 0) throw new Error("VectorJSON: allocation failed");
      try {
        bridge.gcCopyString(ws._ref, ptr);
        bridge.stringifyString(ptr, ws._len);
      } finally {
        bridge.dealloc(ptr, ws._len);
      }
      return;
    }

    switch (typeof value) {
      case "boolean":
        bridge.stringifyBool(value ? 1 : 0);
        break;

      case "number":
        bridge.stringifyNumber(value);
        break;

      case "string": {
        const { ptr, len } = writeStringToMemory(value);
        try {
          bridge.stringifyString(ptr, len);
        } finally {
          if (len > 0) bridge.dealloc(ptr, len);
        }
        break;
      }

      case "bigint":
        throw new TypeError(
          "VectorJSON: BigInt value can't be serialized in JSON",
        );

      case "object": {
        if (Array.isArray(value)) {
          bridge.stringifyArrayStart();
          for (let i = 0; i < value.length; i++) {
            const elem = value[i];
            // undefined/function/symbol in arrays → null
            if (
              elem === undefined ||
              typeof elem === "function" ||
              typeof elem === "symbol"
            ) {
              bridge.stringifyNull();
            } else {
              writeValue(elem);
            }
          }
          bridge.stringifyArrayEnd();
        } else {
          // Check for toJSON method
          const obj = value as Record<string, unknown>;
          if (typeof obj.toJSON === "function") {
            writeValue(obj.toJSON());
            return;
          }

          bridge.stringifyObjectStart();
          const keys = Object.keys(obj);
          for (const key of keys) {
            const val = obj[key];
            // Skip undefined, functions, and symbols (matches JSON.stringify)
            if (
              val === undefined ||
              typeof val === "function" ||
              typeof val === "symbol"
            ) {
              continue;
            }
            const { ptr, len } = writeStringToMemory(key);
            try {
              bridge.stringifyKey(ptr, len);
            } finally {
              if (len > 0) bridge.dealloc(ptr, len);
            }
            writeValue(val);
          }
          bridge.stringifyObjectEnd();
        }
        break;
      }

      default:
        // function, symbol → skip (return undefined)
        // but if we got here, we need to write something
        bridge.stringifyNull();
        break;
    }
  }

  // --- Tag constants ---
  const TAG_NULL = 0;
  const TAG_TRUE = 1;
  const TAG_FALSE = 2;
  const TAG_NUMBER = 3;
  const TAG_STRING = 4;
  const TAG_OBJECT = 5;
  const TAG_ARRAY = 6;

  // GC tag constants (still used by streaming path)
  const GC_NULL = 0;
  const GC_BOOL = 1;
  const GC_NUMBER = 2;
  const GC_STRING = 3;
  const GC_ARRAY = 4;
  const GC_OBJECT = 5;

  // --- Sentinel to mark lazy proxy objects ---
  const LAZY_PROXY = Symbol("vectorjson.lazy");

  // --- Explicit document disposal ---
  // Track generation per docId to prevent stale FinalizationRegistry callbacks
  // from freeing a reused slot. Each parse increments the generation.
  const docGenerations = new Map<number, number>();

  function freeDocIfCurrent(docId: number, generation: number): void {
    if (docGenerations.get(docId) !== generation) return; // stale callback
    engine.doc_free(docId);
  }

  // --- FinalizationRegistry for auto-cleanup of document slots ---
  const docRegistry = new FinalizationRegistry(
    ({ docId, generation }: { docId: number; generation: number }) => {
      freeDocIfCurrent(docId, generation);
    },
  );

  // --- Read a doc string at a tape index into a JS string ---
  function docReadString(docId: number, index: number): string {
    const len = engine.doc_get_string_len(docId, index);
    if (len === 0) return "";
    const ptr = engine.doc_get_string_ptr(docId, index);
    // Guard: if the doc was freed between the len/ptr calls (race with
    // FinalizationRegistry), the pointer may be stale/out-of-bounds.
    if (ptr < 0 || ptr + len > engine.memory.buffer.byteLength) return "";
    return readString(ptr, len);
  }

  // --- Read a doc string → WasmGC $JsonString externref → WasmString ---
  // Copies bytes from doc slot into GC memory so the WasmString survives doc_free.
  function docStringToGC(docId: number, index: number): WasmString {
    const len = engine.doc_get_string_len(docId, index);
    if (len === 0) {
      const ref = bridge.createGCString(1, 0);
      return new WasmString(ref, 0, bridge, engine, decoder);
    }
    const ptr = engine.doc_get_string_ptr(docId, index);
    // Guard: stale pointer after doc was freed between len/ptr calls
    if (ptr < 0 || ptr + len > engine.memory.buffer.byteLength) {
      const ref = bridge.createGCString(1, 0);
      return new WasmString(ref, 0, bridge, engine, decoder);
    }
    const ref = bridge.createGCString(ptr, len);
    return new WasmString(ref, len, bridge, engine, decoder);
  }

  // --- Config interfaces for shared proxy factories ---

  interface ArrayProxyConfig {
    length: number;
    getItem(idx: number): unknown;
    materialize(): unknown;
    lazyHandle: unknown;
    free?: () => void;
  }

  interface ObjectProxyConfig {
    getKeys(): string[];
    getProp(key: string): unknown;
    hasProp(key: string): boolean;
    materialize(): unknown;
    lazyHandle: unknown;
    free?: () => void;
  }

  // --- Deep materialize from document tape ---
  function deepMaterializeDoc(docId: number, index: number): unknown {
    const tag = engine.doc_get_tag(docId, index);
    switch (tag) {
      case TAG_NULL:
        return null;
      case TAG_TRUE:
        return true;
      case TAG_FALSE:
        return false;
      case TAG_NUMBER:
        return engine.doc_get_number(docId, index);
      case TAG_STRING:
        return docReadString(docId, index);
      case TAG_ARRAY: {
        const count = engine.doc_array_elements(docId, index);
        const batchPtr = engine.doc_batch_ptr();
        const idxCopy = new Uint32Array(count);
        idxCopy.set(new Uint32Array(engine.memory.buffer, batchPtr, count));
        const arr: unknown[] = [];
        for (let i = 0; i < count; i++) {
          arr.push(deepMaterializeDoc(docId, idxCopy[i]));
        }
        return arr;
      }
      case TAG_OBJECT: {
        const count = engine.doc_object_keys(docId, index);
        const batchPtr = engine.doc_batch_ptr();
        const idxCopy = new Uint32Array(count);
        idxCopy.set(new Uint32Array(engine.memory.buffer, batchPtr, count));
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < count; i++) {
          obj[docReadString(docId, idxCopy[i])] = deepMaterializeDoc(docId, idxCopy[i] + 1);
        }
        return obj;
      }
      default:
        return null;
    }
  }

  // --- Shared Proxy factories ---

  function createArrayProxy(config: ArrayProxyConfig): unknown[] {
    return new Proxy([] as unknown[], {
      get(_target, prop, _receiver) {
        if (prop === "free" || prop === Symbol.dispose) {
          return config.free;
        }
        if (prop === LAZY_PROXY) return config.lazyHandle;
        if (prop === "length") return config.length;
        if (prop === Symbol.iterator) {
          return function* () {
            for (let i = 0; i < config.length; i++) {
              yield config.getItem(i);
            }
          };
        }
        if (prop === Symbol.toPrimitive) return undefined;
        if (prop === "toJSON") return () => config.materialize();
        if (typeof prop === "string") {
          const idx = Number(prop);
          if (Number.isInteger(idx) && idx >= 0 && idx < config.length) {
            return config.getItem(idx);
          }
        }
        if (prop === Symbol.toStringTag) return "Array";
        if (typeof prop === "string" && prop in Array.prototype) {
          const materialized = config.materialize() as unknown[];
          return (materialized as unknown as Record<string, unknown>)[prop];
        }
        return undefined;
      },
      has(_target, prop) {
        if (prop === LAZY_PROXY) return true;
        if (prop === "length") return true;
        if (typeof prop === "string") {
          const idx = Number(prop);
          if (Number.isInteger(idx) && idx >= 0 && idx < config.length) return true;
        }
        return false;
      },
      ownKeys() {
        const keys: string[] = [];
        for (let i = 0; i < config.length; i++) keys.push(String(i));
        keys.push("length");
        return keys;
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (prop === "length") {
          return { value: config.length, writable: false, enumerable: false, configurable: false };
        }
        if (typeof prop === "string") {
          const idx = Number(prop);
          if (Number.isInteger(idx) && idx >= 0 && idx < config.length) {
            return { value: config.getItem(idx), writable: false, enumerable: true, configurable: true };
          }
        }
        return undefined;
      },
    });
  }

  function createObjectProxy(config: ObjectProxyConfig): Record<string, unknown> {
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop, _receiver) {
        if (prop === "free" || prop === Symbol.dispose) {
          return config.free;
        }
        if (prop === LAZY_PROXY) return config.lazyHandle;
        if (prop === Symbol.toPrimitive) return undefined;
        if (prop === Symbol.toStringTag) return "Object";
        if (prop === "toJSON") return () => config.materialize();
        if (typeof prop === "string") {
          return config.getProp(prop);
        }
        return undefined;
      },
      has(_target, prop) {
        if (prop === LAZY_PROXY) return true;
        if (typeof prop !== "string") return false;
        return config.hasProp(prop);
      },
      ownKeys() {
        return config.getKeys();
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (typeof prop !== "string") return undefined;
        if (!config.hasProp(prop)) return undefined;
        return { value: config.getProp(prop), writable: false, enumerable: true, configurable: true };
      },
    });
  }

  // --- Wrap a document tape value in a lazy Proxy ---
  // keepAlive: sentinel object registered with FinalizationRegistry.
  // As long as any Proxy created from this document is alive, keepAlive
  // remains reachable (via closure capture), preventing doc_free.
  function wrapDoc(
    docId: number,
    index: number,
    keepAlive: object,
    generation: number,
  ): unknown {
    const tag = engine.doc_get_tag(docId, index);

    // Primitives — return directly, no Proxy needed
    if (tag === TAG_NULL) return null;
    if (tag === TAG_TRUE) return true;
    if (tag === TAG_FALSE) return false;
    if (tag === TAG_NUMBER) return engine.doc_get_number(docId, index);
    if (tag === TAG_STRING) return docStringToGC(docId, index);

    const freeFn = () => {
      void keepAlive; // prevent GC of sentinel
      if (docGenerations.get(docId) !== generation) return;
      docGenerations.delete(docId);
      engine.doc_free(docId);
      docRegistry.unregister(keepAlive);
    };

    if (tag === TAG_ARRAY) {
      const length = engine.doc_get_count(docId, index);

      // Batch-read element tape indices lazily in ONE WASM call
      let elemIndices: Uint32Array | null = null;
      const getElemIndices = (): Uint32Array => {
        if (elemIndices === null) {
          const count = engine.doc_array_elements(docId, index);
          const batchPtr = engine.doc_batch_ptr();
          elemIndices = new Uint32Array(count);
          elemIndices.set(new Uint32Array(engine.memory.buffer, batchPtr, count));
        }
        return elemIndices;
      };

      const elemCache = new Map<number, unknown>();

      return createArrayProxy({
        length,
        getItem(idx: number): unknown {
          void keepAlive;
          let cached = elemCache.get(idx);
          if (cached !== undefined) return cached;
          const indices = getElemIndices();
          if (idx < indices.length) {
            cached = wrapDoc(docId, indices[idx], keepAlive, generation);
          } else {
            const elemIdx = engine.doc_array_at(docId, index, idx);
            if (elemIdx === 0) return undefined;
            cached = wrapDoc(docId, elemIdx, keepAlive, generation);
          }
          elemCache.set(idx, cached);
          return cached;
        },
        materialize: () => deepMaterializeDoc(docId, index),
        lazyHandle: { docId, index },
        free: freeFn,
      });
    }

    if (tag === TAG_OBJECT) {
      const propCache = new Map<string, unknown>();
      const NOT_FOUND = Symbol();

      let _keys: string[] | null = null;
      let _keyToValIdx: Map<string, number> | null = null;

      const buildKeyMap = () => {
        if (_keyToValIdx !== null) return;
        const kCount = engine.doc_object_keys(docId, index);
        const batchPtr = engine.doc_batch_ptr();
        const keyIndices = new Uint32Array(kCount);
        keyIndices.set(new Uint32Array(engine.memory.buffer, batchPtr, kCount));
        _keys = [];
        _keyToValIdx = new Map();
        for (let i = 0; i < kCount; i++) {
          const k = docReadString(docId, keyIndices[i]);
          _keys.push(k);
          _keyToValIdx.set(k, keyIndices[i] + 1);
        }
      };

      return createObjectProxy({
        getKeys(): string[] {
          buildKeyMap();
          return _keys!;
        },
        getProp(key: string): unknown {
          void keepAlive;
          const cached = propCache.get(key);
          if (cached !== undefined) return cached === NOT_FOUND ? undefined : cached;
          buildKeyMap();
          const valIdx = _keyToValIdx!.get(key);
          if (valIdx === undefined) {
            propCache.set(key, NOT_FOUND);
            return undefined;
          }
          const wrapped = wrapDoc(docId, valIdx, keepAlive, generation);
          propCache.set(key, wrapped);
          return wrapped;
        },
        hasProp(key: string): boolean {
          buildKeyMap();
          return _keyToValIdx!.has(key);
        },
        materialize: () => deepMaterializeDoc(docId, index),
        lazyHandle: { docId, index },
        free: freeFn,
      });
    }

    return null;
  }

  // --- GC-based wrappers (still used by streaming path) ---

  function gcReadString(ref: unknown): string {
    const len = bridge.gcGetStringLen(ref);
    if (len === 0) return "";
    const ptr = bridge.alloc(len);
    if (ptr === 0)
      throw new Error("VectorJSON: Failed to allocate for string read");
    try {
      bridge.gcCopyString(ref, ptr);
      return readString(ptr, len);
    } finally {
      bridge.dealloc(ptr, len);
    }
  }

  function gcReadObjectKey(ref: unknown, idx: number): string {
    const len = bridge.gcGetObjectKeyLen(ref, idx);
    if (len === 0) return "";
    const ptr = bridge.alloc(len);
    if (ptr === 0)
      throw new Error("VectorJSON: Failed to allocate for key read");
    try {
      bridge.gcCopyObjectKey(ref, idx, ptr);
      return readString(ptr, len);
    } finally {
      bridge.dealloc(ptr, len);
    }
  }

  // --- Deep materialize from GC tree ---
  function deepMaterialize(ref: unknown): unknown {
    if (ref === null || ref === undefined) return null;
    const tag = bridge.gcGetTag(ref);
    switch (tag) {
      case GC_NULL:
        return null;
      case GC_BOOL:
        return bridge.gcGetBool(ref) !== 0;
      case GC_NUMBER:
        return bridge.gcGetNumber(ref);
      case GC_STRING:
        return gcReadString(ref);
      case GC_ARRAY: {
        const len = bridge.gcGetArrayLen(ref);
        const arr: unknown[] = [];
        for (let i = 0; i < len; i++) {
          arr.push(deepMaterialize(bridge.gcGetArrayItem(ref, i)));
        }
        return arr;
      }
      case GC_OBJECT: {
        const count = bridge.gcGetObjectLen(ref);
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < count; i++) {
          obj[gcReadObjectKey(ref, i)] = deepMaterialize(bridge.gcGetObjectValue(ref, i));
        }
        return obj;
      }
      default:
        return null;
    }
  }

  function wrapGC(ref: unknown): unknown {
    if (ref === null || ref === undefined) return null;
    const tag = bridge.gcGetTag(ref);
    if (tag === GC_NULL) return null;
    if (tag === GC_BOOL) return bridge.gcGetBool(ref) !== 0;
    if (tag === GC_NUMBER) return bridge.gcGetNumber(ref);
    if (tag === GC_STRING) {
      return new WasmString(ref, bridge.gcGetStringLen(ref), bridge, engine, decoder);
    }

    if (tag === GC_ARRAY) {
      return createArrayProxy({
        length: bridge.gcGetArrayLen(ref),
        getItem: (idx) => wrapGC(bridge.gcGetArrayItem(ref, idx)),
        materialize: () => deepMaterialize(ref),
        lazyHandle: { gcRef: ref },
      });
    }

    if (tag === GC_OBJECT) {
      const count = bridge.gcGetObjectLen(ref);
      let _keys: string[] | null = null;

      return createObjectProxy({
        getKeys(): string[] {
          if (_keys === null) {
            _keys = [];
            for (let i = 0; i < count; i++) _keys.push(gcReadObjectKey(ref, i));
          }
          return _keys;
        },
        getProp(key: string): unknown {
          const { ptr, len } = writeStringToMemory(key);
          try {
            const valRef = bridge.gcFindProperty(ref, ptr, len);
            if (valRef === null || valRef === undefined) return undefined;
            return wrapGC(valRef);
          } finally {
            if (len > 0) bridge.dealloc(ptr, len);
          }
        },
        hasProp(key: string): boolean {
          const { ptr, len } = writeStringToMemory(key);
          try {
            const valRef = bridge.gcFindProperty(ref, ptr, len);
            return valRef !== null && valRef !== undefined;
          } finally {
            if (len > 0) bridge.dealloc(ptr, len);
          }
        },
        materialize: () => deepMaterialize(ref),
        lazyHandle: { gcRef: ref },
      });
    }

    return null;
  }

  // --- Check if a value is a lazy proxy ---
  function isLazyProxy(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value !== "object") return false;
    try {
      return LAZY_PROXY in (value as Record<symbol, unknown>);
    } catch {
      return false;
    }
  }

  // --- Public API ---
  _instance = {
    parse(input: string | Uint8Array): unknown {
      const bytes = typeof input === "string" ? encoder.encode(input) : input;
      const len = bytes.byteLength;

      // Allocate in engine memory and copy input bytes
      const ptr = engine.alloc(len);
      if (ptr === 0) {
        throw new Error("VectorJSON: Failed to allocate memory for input");
      }

      try {
        new Uint8Array(engine.memory.buffer, ptr, len).set(bytes);

        // Primary path: parse into tape via doc slots (fast, lazy)
        let docId = engine.doc_parse(ptr, len);
        if (docId < 0) {
          const errCode = engine.get_error_code();
          // Slot exhaustion (2) or OOM (13) — try to reclaim via GC and retry
          if (errCode === 2 || errCode === 13) {
            if (typeof globalThis.gc === "function") {
              globalThis.gc();
            }
            docId = engine.doc_parse(ptr, len);
          }
        }

        if (docId >= 0) {
          // Doc-slot path succeeded
          const rootTag = engine.doc_get_tag(docId, 1);
          if (rootTag <= TAG_STRING) {
            // Primitive — extract and free immediately
            let result: unknown;
            switch (rootTag) {
              case TAG_NULL:
                result = null;
                break;
              case TAG_TRUE:
                result = true;
                break;
              case TAG_FALSE:
                result = false;
                break;
              case TAG_NUMBER:
                result = engine.doc_get_number(docId, 1);
                break;
              case TAG_STRING:
                result = docStringToGC(docId, 1);
                break;
              default:
                result = null;
            }
            engine.doc_free(docId);
            return result;
          }

          // Container — register with FinalizationRegistry
          const generation = (docGenerations.get(docId) ?? 0) + 1;
          docGenerations.set(docId, generation);

          const keepAlive = { docId };
          docRegistry.register(keepAlive, { docId, generation }, keepAlive);

          return wrapDoc(docId, 1, keepAlive, generation);
        }

        // Fallback path: doc slots exhausted (Bun's JSC defers FinalizationRegistry
        // callbacks, so gc() retry may not free slots). Use the GC tree path instead.
        // This builds the full tree eagerly but has no slot limit.
        const gcRef = bridge.parseJSON(ptr, len);
        if (gcRef === null || gcRef === undefined) {
          const errorCode = bridge.getError();
          const msg =
            ERROR_MESSAGES[errorCode] || `Parse error (code ${errorCode})`;
          throw new SyntaxError(`VectorJSON: ${msg}`);
        }
        return wrapGC(gcRef);
      } finally {
        engine.dealloc(ptr, len);
      }
    },

    materialize(value: unknown): unknown {
      // WasmString → JS string
      if (value instanceof WasmString) {
        return value.toString();
      }
      if (isLazyProxy(value)) {
        const handle = (value as Record<symbol, unknown>)[LAZY_PROXY] as
          | { docId: number; index: number }
          | { gcRef: unknown };
        // Doc-backed proxy
        if ("docId" in handle) {
          return deepMaterializeDoc(handle.docId, handle.index);
        }
        // GC-backed proxy (streaming path)
        if ("gcRef" in handle) {
          return deepMaterialize(handle.gcRef);
        }
      }
      // Already a plain JS value — return as-is
      return value;
    },

    stringify(value: unknown): string {
      // Fast path: GC-backed proxy → gcStringify (one WASM call, zero JS)
      if (isLazyProxy(value)) {
        const handle = (value as Record<symbol, unknown>)[LAZY_PROXY] as {
          gcRef?: unknown;
        };
        if ("gcRef" in handle) {
          bridge.gcStringify(handle.gcRef);
          try {
            const rPtr = bridge.stringifyResultPtr();
            const rLen = bridge.stringifyResultLen();
            return readString(rPtr, rLen);
          } finally {
            bridge.stringifyFree();
          }
        }
      }

      // WasmString → materialize and stringify
      if (value instanceof WasmString) {
        return JSON.stringify(value.toString());
      }

      // Plain JS values → built-in JSON.stringify (native C++, unbeatable)
      if (!isLazyProxy(value)) {
        return JSON.stringify(value);
      }

      // Doc-backed proxy or mixed → WASM token-by-token stringify
      bridge.stringifyInit();
      try {
        writeValue(value);
        const rPtr = bridge.stringifyResultPtr();
        const rLen = bridge.stringifyResultLen();
        return readString(rPtr, rLen);
      } finally {
        bridge.stringifyFree();
      }
    },

    validate(
      data: unknown,
      schema: Record<string, unknown>,
    ): ValidationResult {
      // Stringify schema and load it
      const schemaJson = encoder.encode(JSON.stringify(schema));
      const sPtr = bridge.alloc(schemaJson.byteLength);
      if (sPtr === 0) {
        throw new Error("VectorJSON: Failed to allocate memory for schema");
      }
      new Uint8Array(engine.memory.buffer, sPtr, schemaJson.byteLength).set(
        schemaJson,
      );
      const sRes = bridge.validateLoadSchema(sPtr, schemaJson.byteLength);
      bridge.dealloc(sPtr, schemaJson.byteLength);
      if (sRes !== 0) {
        throw new SyntaxError(
          `VectorJSON: Failed to compile schema (code ${sRes})`,
        );
      }

      // Stringify data and validate
      const dataJson = encoder.encode(JSON.stringify(data));
      const dPtr = bridge.alloc(dataJson.byteLength);
      if (dPtr === 0) {
        throw new Error("VectorJSON: Failed to allocate memory for data");
      }
      new Uint8Array(engine.memory.buffer, dPtr, dataJson.byteLength).set(
        dataJson,
      );
      const dRes = bridge.validateCheck(dPtr, dataJson.byteLength);
      bridge.dealloc(dPtr, dataJson.byteLength);

      if (dRes === 2) {
        throw new Error("VectorJSON: No schema loaded");
      }

      // Read errors
      const count = bridge.validateErrorCount();
      const errors: ValidationError[] = [];
      for (let i = 0; i < count; i++) {
        errors.push({
          path: readString(
            bridge.validateErrorPathPtr(i),
            bridge.validateErrorPathLen(i),
          ),
          message: readString(
            bridge.validateErrorMsgPtr(i),
            bridge.validateErrorMsgLen(i),
          ),
        });
      }

      bridge.validateFree();

      return {
        valid: errors.length === 0,
        errors,
      };
    },

    deepCompare(
      a: unknown,
      b: unknown,
      options?: { ordered?: boolean },
    ): DiffEntry[] {
      const DIFF_TYPES: Record<number, DiffType> = {
        0: "changed",
        1: "added",
        2: "removed",
        3: "type_changed",
      };

      // Convert inputs to JSON bytes.
      // Uint8Array → use as-is (raw JSON).
      // Anything else → JSON.stringify to get valid JSON bytes.
      const toJsonBytes = (val: unknown): Uint8Array => {
        if (val instanceof Uint8Array) return val;
        return encoder.encode(JSON.stringify(val));
      };
      const jsonA = toJsonBytes(a);
      const jsonB = toJsonBytes(b);

      // Allocate and copy A
      const ptrA = bridge.alloc(jsonA.byteLength);
      if (ptrA === 0) {
        throw new Error("VectorJSON: Failed to allocate memory for compare A");
      }
      new Uint8Array(engine.memory.buffer, ptrA, jsonA.byteLength).set(jsonA);
      const resA = bridge.compareParseA(ptrA, jsonA.byteLength);
      bridge.dealloc(ptrA, jsonA.byteLength);
      if (resA !== 0) {
        throw new SyntaxError("VectorJSON: Failed to parse first argument");
      }

      // Set ordered mode
      bridge.compareSetOrdered(options?.ordered ? 1 : 0);

      // Allocate and copy B
      const ptrB = bridge.alloc(jsonB.byteLength);
      if (ptrB === 0) {
        throw new Error("VectorJSON: Failed to allocate memory for compare B");
      }
      new Uint8Array(engine.memory.buffer, ptrB, jsonB.byteLength).set(jsonB);
      const resB = bridge.compareParseB(ptrB, jsonB.byteLength);
      bridge.dealloc(ptrB, jsonB.byteLength);
      if (resB !== 0) {
        throw new SyntaxError("VectorJSON: Failed to parse second argument");
      }

      // Read diffs
      const count = bridge.compareDiffCount();
      const diffs: DiffEntry[] = [];
      for (let i = 0; i < count; i++) {
        const pathPtr = bridge.compareDiffPathPtr(i);
        const pathLen = bridge.compareDiffPathLen(i);
        const diffType = bridge.compareDiffType(i);
        diffs.push({
          path: readString(pathPtr, pathLen),
          type: DIFF_TYPES[diffType] || "changed",
        });
      }

      bridge.compareFree();
      return diffs;
    },

    createParser(): StreamingParser {
      const streamId = bridge.streamCreate();
      if (streamId < 0) {
        throw new Error("VectorJSON: Failed to create streaming parser");
      }

      let destroyed = false;
      let cachedValue: unknown = undefined;
      let valueResolved = false;

      return {
        feed(chunk: Uint8Array | string): FeedStatus {
          if (destroyed) throw new Error("Parser already destroyed");
          const bytes =
            typeof chunk === "string" ? encoder.encode(chunk) : chunk;
          const len = bytes.byteLength;

          // Allocate in engine memory and copy the chunk
          const ptr = bridge.alloc(len);
          if (ptr === 0) throw new Error("VectorJSON: allocation failed");

          try {
            new Uint8Array(engine.memory.buffer, ptr, len).set(bytes);
            const status = bridge.streamFeed(streamId, ptr, len);
            return STATUS_MAP[status] || "error";
          } finally {
            bridge.dealloc(ptr, len);
          }
        },

        getValue(_path?: string): unknown {
          if (destroyed) throw new Error("Parser already destroyed");
          if (valueResolved) return cachedValue;

          const status = bridge.streamGetStatus(streamId);
          if (status === 0) {
            // incomplete
            throw new Error("VectorJSON: JSON is incomplete, feed more data");
          }
          if (status === 2) {
            // error
            throw new SyntaxError("VectorJSON: Parse error in stream");
          }

          // complete or end_early — parse the accumulated buffer
          const gcRef = bridge.streamGetValue(streamId);
          const errorCode = bridge.getError();
          if (errorCode !== 0) {
            const msg =
              ERROR_MESSAGES[errorCode] || `Parse error (code ${errorCode})`;
            throw new SyntaxError(`VectorJSON: ${msg}`);
          }

          cachedValue = wrapGC(gcRef);
          valueResolved = true;
          return cachedValue;
        },

        getRemaining(): Uint8Array | null {
          if (destroyed) return null;
          const rPtr = bridge.streamRemainingPtr(streamId);
          const rLen = bridge.streamRemainingLen(streamId);
          if (rLen === 0) return null;
          // Copy remaining bytes out of engine memory
          const out = new Uint8Array(rLen);
          out.set(new Uint8Array(engine.memory.buffer, rPtr, rLen));
          return out;
        },

        getStatus(): FeedStatus {
          if (destroyed) return "error";
          const status = bridge.streamGetStatus(streamId);
          return STATUS_MAP[status] || "error";
        },

        destroy(): void {
          if (!destroyed) {
            bridge.streamDestroy(streamId);
            destroyed = true;
          }
        },
      };
    },

    isWasmString(value: unknown): value is WasmString {
      return value instanceof WasmString;
    },
  };

  return _instance;
}

/**
 * Convenience: parse JSON using a pre-initialized instance.
 * Initializes on first call.
 */
export async function parse(input: string | Uint8Array): Promise<unknown> {
  const vj = await init();
  return vj.parse(input);
}

/**
 * Convenience: stringify a JS value using a pre-initialized instance.
 * Initializes on first call.
 */
export async function stringify(value: unknown): Promise<string> {
  const vj = await init();
  return vj.stringify(value);
}

/**
 * Convenience: validate data against a JSON Schema using a pre-initialized instance.
 * Initializes on first call.
 */
export async function validate(
  data: unknown,
  schema: Record<string, unknown>,
): Promise<ValidationResult> {
  const vj = await init();
  return vj.validate(data, schema);
}

/**
 * Convenience: deep compare two values using a pre-initialized instance.
 * Initializes on first call.
 */
export async function deepCompare(
  a: unknown,
  b: unknown,
  options?: { ordered?: boolean },
): Promise<DiffEntry[]> {
  const vj = await init();
  return vj.deepCompare(a, b, options);
}
