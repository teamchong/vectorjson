/**
 * VectorJSON — SIMD-accelerated JSON parser with WasmGC bridge
 *
 * Architecture:
 *   JS bytes → [WAT bridge] → [Zig + zimdjson SIMD] → tape → WasmGC tree → JS Proxy
 *
 * The Zig engine (engine.wasm) parses JSON bytes into an internal tape format
 * using SIMD-accelerated algorithms from zimdjson. The WAT bridge (bridge.wasm)
 * reads the tape and builds a GC-managed object tree (struct.new / array.new).
 * JS receives lazy Proxy objects backed by WasmGC — values materialize only
 * when accessed. No .dispose(), no dual paths. One code path: GC only.
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
   * Parse a JSON string or Uint8Array into a lazy zero-copy value backed by WasmGC.
   * Primitives (null, boolean, number, string) are returned directly.
   * Objects and arrays return Proxy objects — values materialize only when accessed.
   * Supports natural JS syntax: result.items[0].name
   */
  parse(input: string | Uint8Array): unknown;
  /**
   * Eagerly materialize a lazy proxy into plain JS objects.
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
    return readString(ptr, len);
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
        const count = engine.doc_get_count(docId, index);
        const arr: unknown[] = [];
        for (let i = 0; i < count; i++) {
          const elemIdx = engine.doc_array_at(docId, index, i);
          if (elemIdx === 0) break;
          arr.push(deepMaterializeDoc(docId, elemIdx));
        }
        return arr;
      }
      case TAG_OBJECT: {
        const count = engine.doc_get_count(docId, index);
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < count; i++) {
          const keyIdx = engine.doc_obj_key_at(docId, index, i);
          if (keyIdx === 0) break;
          const key = docReadString(docId, keyIdx);
          obj[key] = deepMaterializeDoc(docId, keyIdx + 1);
        }
        return obj;
      }
      default:
        return null;
    }
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
    if (tag === TAG_STRING) return docReadString(docId, index);

    // Array — return lazy Proxy with element cache
    if (tag === TAG_ARRAY) {
      const length = engine.doc_get_count(docId, index);
      const elemCache = new Map<number, unknown>();

      const getElem = (idx: number): unknown => {
        let cached = elemCache.get(idx);
        if (cached !== undefined) return cached;
        const elemIdx = engine.doc_array_at(docId, index, idx);
        if (elemIdx === 0) return undefined;
        cached = wrapDoc(docId, elemIdx, keepAlive, generation);
        elemCache.set(idx, cached);
        return cached;
      };

      const proxy = new Proxy([] as unknown[], {
        get(_target, prop, _receiver) {
          void keepAlive; // prevent GC of sentinel
          if (prop === "close" || prop === Symbol.dispose) {
            return () => freeDocIfCurrent(docId, generation);
          }
          if (prop === LAZY_PROXY) return { docId, index };
          if (prop === "length") return length;
          if (prop === Symbol.iterator) {
            return function* () {
              for (let i = 0; i < length; i++) {
                yield getElem(i);
              }
            };
          }
          if (prop === Symbol.toPrimitive) return undefined;
          if (prop === "toJSON") {
            return () => deepMaterializeDoc(docId, index);
          }
          if (typeof prop === "string") {
            const idx = Number(prop);
            if (Number.isInteger(idx) && idx >= 0 && idx < length) {
              return getElem(idx);
            }
          }
          // Support Array.isArray check
          if (prop === Symbol.toStringTag) return "Array";
          // For Array methods (map, filter, etc.), materialize first
          if (typeof prop === "string" && prop in Array.prototype) {
            const materialized = deepMaterializeDoc(docId, index) as unknown[];
            return (materialized as unknown as Record<string, unknown>)[prop];
          }
          return undefined;
        },
        has(_target, prop) {
          void keepAlive;
          if (prop === LAZY_PROXY) return true;
          if (prop === "length") return true;
          if (typeof prop === "string") {
            const idx = Number(prop);
            if (Number.isInteger(idx) && idx >= 0 && idx < length) return true;
          }
          return false;
        },
        ownKeys() {
          void keepAlive;
          const keys: string[] = [];
          for (let i = 0; i < length; i++) keys.push(String(i));
          keys.push("length");
          return keys;
        },
        getOwnPropertyDescriptor(_target, prop) {
          void keepAlive;
          if (prop === "length") {
            return {
              value: length,
              writable: false,
              enumerable: false,
              configurable: false,
            };
          }
          if (typeof prop === "string") {
            const idx = Number(prop);
            if (Number.isInteger(idx) && idx >= 0 && idx < length) {
              return {
                value: getElem(idx),
                writable: false,
                enumerable: true,
                configurable: true,
              };
            }
          }
          return undefined;
        },
      });
      return proxy;
    }

    // Object — return lazy Proxy with property cache
    if (tag === TAG_OBJECT) {
      const count = engine.doc_get_count(docId, index);
      const propCache = new Map<string, unknown>();
      // Sentinel for "key not found" (distinct from undefined values)
      const NOT_FOUND = Symbol();

      // Cache key list (read once)
      let _keys: string[] | null = null;
      const getKeys = (): string[] => {
        if (_keys === null) {
          _keys = [];
          for (let i = 0; i < count; i++) {
            const keyIdx = engine.doc_obj_key_at(docId, index, i);
            if (keyIdx === 0) break;
            _keys.push(docReadString(docId, keyIdx));
          }
        }
        return _keys;
      };

      const getProp = (key: string): unknown => {
        const cached = propCache.get(key);
        if (cached !== undefined) return cached === NOT_FOUND ? undefined : cached;
        const { ptr, len } = writeStringToMemory(key);
        try {
          const valIdx = engine.doc_find_field(docId, index, ptr, len);
          if (valIdx === 0) {
            propCache.set(key, NOT_FOUND);
            return undefined;
          }
          const wrapped = wrapDoc(docId, valIdx, keepAlive, generation);
          propCache.set(key, wrapped);
          return wrapped;
        } finally {
          if (len > 0) bridge.dealloc(ptr, len);
        }
      };

      const proxy = new Proxy({} as Record<string, unknown>, {
        get(_target, prop, _receiver) {
          void keepAlive;
          if (prop === "close" || prop === Symbol.dispose) {
            return () => freeDocIfCurrent(docId, generation);
          }
          if (prop === LAZY_PROXY) return { docId, index };
          if (prop === Symbol.toPrimitive) return undefined;
          if (prop === Symbol.toStringTag) return "Object";
          if (prop === "toJSON") {
            return () => deepMaterializeDoc(docId, index);
          }
          if (typeof prop === "string") {
            return getProp(prop);
          }
          return undefined;
        },
        has(_target, prop) {
          void keepAlive;
          if (prop === LAZY_PROXY) return true;
          if (typeof prop !== "string") return false;
          // getProp caches the result, so even `has` benefits
          const cached = propCache.get(prop);
          if (cached !== undefined) return cached !== NOT_FOUND;
          const { ptr, len } = writeStringToMemory(prop);
          try {
            const valIdx = engine.doc_find_field(docId, index, ptr, len);
            return valIdx !== 0;
          } finally {
            if (len > 0) bridge.dealloc(ptr, len);
          }
        },
        ownKeys() {
          void keepAlive;
          return getKeys();
        },
        getOwnPropertyDescriptor(_target, prop) {
          void keepAlive;
          if (typeof prop !== "string") return undefined;
          const val = getProp(prop);
          // getProp caches NOT_FOUND for missing keys
          if (propCache.get(prop) === NOT_FOUND) return undefined;
          return {
            value: val,
            writable: false,
            enumerable: true,
            configurable: true,
          };
        },
      });
      return proxy;
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
          const key = gcReadObjectKey(ref, i);
          obj[key] = deepMaterialize(bridge.gcGetObjectValue(ref, i));
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
    if (tag === GC_STRING) return gcReadString(ref);
    if (tag === GC_ARRAY) {
      const length = bridge.gcGetArrayLen(ref);
      const proxy = new Proxy([] as unknown[], {
        get(_target, prop, _receiver) {
          if (prop === LAZY_PROXY) return { gcRef: ref };
          if (prop === "length") return length;
          if (prop === Symbol.iterator) {
            return function* () {
              for (let i = 0; i < length; i++) {
                yield wrapGC(bridge.gcGetArrayItem(ref, i));
              }
            };
          }
          if (prop === Symbol.toPrimitive) return undefined;
          if (prop === "toJSON") return () => deepMaterialize(ref);
          if (typeof prop === "string") {
            const idx = Number(prop);
            if (Number.isInteger(idx) && idx >= 0 && idx < length) {
              return wrapGC(bridge.gcGetArrayItem(ref, idx));
            }
          }
          if (prop === Symbol.toStringTag) return "Array";
          if (typeof prop === "string" && prop in Array.prototype) {
            const materialized = deepMaterialize(ref) as unknown[];
            return (materialized as unknown as Record<string, unknown>)[prop];
          }
          return undefined;
        },
        has(_target, prop) {
          if (prop === LAZY_PROXY) return true;
          if (prop === "length") return true;
          if (typeof prop === "string") {
            const idx = Number(prop);
            if (Number.isInteger(idx) && idx >= 0 && idx < length) return true;
          }
          return false;
        },
        ownKeys() {
          const keys: string[] = [];
          for (let i = 0; i < length; i++) keys.push(String(i));
          keys.push("length");
          return keys;
        },
        getOwnPropertyDescriptor(_target, prop) {
          if (prop === "length") {
            return {
              value: length,
              writable: false,
              enumerable: false,
              configurable: false,
            };
          }
          if (typeof prop === "string") {
            const idx = Number(prop);
            if (Number.isInteger(idx) && idx >= 0 && idx < length) {
              return {
                value: wrapGC(bridge.gcGetArrayItem(ref, idx)),
                writable: false,
                enumerable: true,
                configurable: true,
              };
            }
          }
          return undefined;
        },
      });
      return proxy;
    }
    if (tag === GC_OBJECT) {
      const count = bridge.gcGetObjectLen(ref);
      let _keys: string[] | null = null;
      const getKeys = (): string[] => {
        if (_keys === null) {
          _keys = [];
          for (let i = 0; i < count; i++) {
            _keys.push(gcReadObjectKey(ref, i));
          }
        }
        return _keys;
      };
      const proxy = new Proxy({} as Record<string, unknown>, {
        get(_target, prop, _receiver) {
          if (prop === LAZY_PROXY) return { gcRef: ref };
          if (prop === Symbol.toPrimitive) return undefined;
          if (prop === Symbol.toStringTag) return "Object";
          if (prop === "toJSON") return () => deepMaterialize(ref);
          if (typeof prop === "string") {
            const { ptr, len } = writeStringToMemory(prop);
            try {
              const valRef = bridge.gcFindProperty(ref, ptr, len);
              if (valRef === null || valRef === undefined) return undefined;
              return wrapGC(valRef);
            } finally {
              if (len > 0) bridge.dealloc(ptr, len);
            }
          }
          return undefined;
        },
        has(_target, prop) {
          if (prop === LAZY_PROXY) return true;
          if (typeof prop !== "string") return false;
          const { ptr, len } = writeStringToMemory(prop);
          try {
            const valRef = bridge.gcFindProperty(ref, ptr, len);
            return valRef !== null && valRef !== undefined;
          } finally {
            if (len > 0) bridge.dealloc(ptr, len);
          }
        },
        ownKeys() {
          return getKeys();
        },
        getOwnPropertyDescriptor(_target, prop) {
          if (typeof prop !== "string") return undefined;
          const { ptr, len } = writeStringToMemory(prop);
          try {
            const valRef = bridge.gcFindProperty(ref, ptr, len);
            if (valRef === null || valRef === undefined) return undefined;
            return {
              value: wrapGC(valRef),
              writable: false,
              enumerable: true,
              configurable: true,
            };
          } finally {
            if (len > 0) bridge.dealloc(ptr, len);
          }
        },
      });
      return proxy;
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

        // Path B: parse into tape, get document handle
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
        if (docId < 0) {
          const errorCode = engine.get_error_code();
          const msg =
            ERROR_MESSAGES[errorCode] || `Parse error (code ${errorCode})`;
          throw new SyntaxError(`VectorJSON: ${msg}`);
        }

        // Check root value type — primitives don't need the document alive
        const rootTag = engine.doc_get_tag(docId, 1);
        if (rootTag <= TAG_STRING) {
          // Primitive (null, bool, number, string) — extract and free immediately
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
              result = docReadString(docId, 1);
              break;
            default:
              result = null;
          }
          engine.doc_free(docId);
          return result;
        }

        // Assign a generation number for this docId usage
        const generation = (docGenerations.get(docId) ?? 0) + 1;
        docGenerations.set(docId, generation);

        // Container (object/array) — create keepAlive sentinel registered
        // with FinalizationRegistry. As long as any Proxy from this document
        // is alive (capturing keepAlive in its closure), the slot won't be freed.
        const keepAlive = { docId };
        docRegistry.register(keepAlive, { docId, generation });

        // Root value is at tape index 1 (index 0 is the root opening word)
        return wrapDoc(docId, 1, keepAlive, generation);
      } finally {
        engine.dealloc(ptr, len);
      }
    },

    materialize(value: unknown): unknown {
      if (isLazyProxy(value)) {
        const handle = (value as Record<symbol, unknown>)[LAZY_PROXY] as
          | { docId: number; index: number }
          | { gcRef: unknown };
        // Doc-backed proxy (Path B)
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
