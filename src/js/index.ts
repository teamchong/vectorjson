/**
 * VectorJSON — SIMD-accelerated JSON parser
 *
 * Architecture:
 *   JS bytes → [Zig + zimdjson SIMD] → tape → lazy Proxy over doc slots
 *
 * The Zig engine (engine.wasm) parses JSON bytes into an internal tape format
 * using SIMD-accelerated algorithms from zimdjson.
 *
 * Primary parse path: doc-slot (tape-direct navigation via Zig exports).
 *   FinalizationRegistry auto-frees doc slots when the Proxy is GC'd.
 *   Users CAN call .free() to release immediately if desired.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// --- Types ---

export type ParseStatus = "complete" | "complete_early" | "incomplete" | "invalid";
export type FeedStatus = "incomplete" | "complete" | "error" | "end_early";

/** Result shape compatible with Vercel AI SDK's parsePartialJson */
export type PartialJsonState =
  | "successful-parse"
  | "repaired-parse"
  | "failed-parse";

export interface PartialJsonResult {
  value: unknown;
  state: PartialJsonState;
}

export interface StreamingParser {
  /** Feed a chunk of bytes to the parser. Only NEW bytes are scanned (O(chunk_size)). */
  feed(chunk: Uint8Array | string): FeedStatus;
  /** Get the parsed value after complete or end_early status. */
  getValue(): unknown;
  /** Get remaining bytes after end_early status (for NDJSON). */
  getRemaining(): Uint8Array | null;
  /** Get the current status without feeding data. */
  getStatus(): FeedStatus;
  /** Destroy the parser and free all resources. */
  destroy(): void;
}

export interface ParseResult {
  status: ParseStatus;
  value?: unknown;
  remaining?: Uint8Array;
  error?: string;
  /** Check if a value (object/array) from an incomplete parse is fully present in the original input. */
  isComplete(value: unknown): boolean;
  /** Full materialization via JSON.parse — fastest way to get a plain JS object tree. */
  toJSON(): unknown;
}

export interface VectorJSON {
  /**
   * Parse a JSON string or Uint8Array into a value.
   * Primitives (null, boolean, number) are returned directly as JS values.
   * Objects and arrays return Proxy objects — values materialize only when accessed.
   * Call .free() on the result to release resources immediately, or let
   * FinalizationRegistry handle it automatically when the Proxy is GC'd.
   *
   * **Cursor pattern**: When iterating arrays of objects, VectorJSON returns a
   * shared cursor object that repositions on each access. This enables columnar
   * reads (one WASM call per field instead of per row) but means array elements
   * should **not be stored by reference** — use destructuring to capture values:
   *
   * ```js
   * // ✅ Destructure — captures plain values, safe to store (recommended)
   * for (const item of data) {
   *   const { id, name, score } = item;
   * }
   *
   * // ✅ Sequential property access — cursor is at correct position
   * for (const item of data) { use(item.id, item.name); }
   *
   * // ✅ JSON.stringify — processes elements sequentially
   * JSON.stringify(result);
   *
   * // ✅ Materialize — converts entire tree to plain JS objects
   * const plain = vj.materialize(result);
   *
   * // ❌ Storing cursor references — all point to the same object
   * const a = data[0]; const b = data[1]; // a === b (same cursor)
   * ```
   */
  parse(input: string | Uint8Array): ParseResult;
  /**
   * Create a streaming parser for incremental JSON parsing.
   * Feed chunks as they arrive; only new bytes are processed per call.
   * Total work is O(N) regardless of how many chunks — no re-parsing.
   *
   * ```ts
   * const parser = vj.createParser();
   * for await (const chunk of stream) {
   *   const status = parser.feed(chunk);
   *   if (status === "complete" || status === "end_early") {
   *     const value = parser.getValue();
   *     // use value...
   *     parser.destroy();
   *     break;
   *   }
   * }
   * ```
   */
  createParser(): StreamingParser;
  /**
   * Eagerly materialize a lazy proxy into plain JS objects.
   * If the value is already a plain JS value, returns it as-is.
   */
  materialize(value: unknown): unknown;
  /** Stringify a JS value to a JSON string (delegates to native JSON.stringify). */
  stringify(value: unknown): string;
  /**
   * Drop-in replacement for AI SDK partial JSON parsers.
   * Parses a potentially incomplete JSON string and returns a plain JS object.
   *
   * Compatible with Vercel AI SDK's `parsePartialJson` — returns `{ value, state }`
   * where state is "successful-parse", "repaired-parse", or "failed-parse".
   *
   * ```ts
   * // Drop-in for Vercel AI SDK:
   * const { value, state } = vj.parsePartialJson('{"a": 1, "b": ');
   * // value = { a: 1, b: null }, state = "repaired-parse"
   * ```
   */
  parsePartialJson(input: string): PartialJsonResult;
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

// --- Module types ---

interface EngineExports {
  memory: WebAssembly.Memory;
  alloc(size: number): number;
  dealloc(ptr: number, size: number): void;
  get_error_code(): number;
  doc_parse(ptr: number, len: number): number;
  doc_free(docId: number): void;
  doc_get_tag(docId: number, index: number): number;
  doc_get_number(docId: number, index: number): number;
  doc_read_string_raw(docId: number, index: number): number;
  doc_get_count(docId: number, index: number): number;
  doc_get_src_pos(docId: number, index: number): number;
  doc_get_close_index(docId: number, index: number): number;
  doc_find_field(docId: number, objIndex: number, keyPtr: number, keyLen: number): number;
  doc_batch_ptr(): number;
  doc_array_elements(docId: number, arrIndex: number): number;
  doc_object_keys(docId: number, objIndex: number): number;
  stream_create(): number;
  stream_destroy(id: number): void;
  stream_feed(id: number, ptr: number, len: number): number;
  stream_get_status(id: number): number;
  stream_get_buffer_ptr(id: number): number;
  stream_get_value_len(id: number): number;
  stream_get_remaining_ptr(id: number): number;
  stream_get_remaining_len(id: number): number;
  classify_input(ptr: number, len: number): number;
  autocomplete_input(ptr: number, len: number, buf_cap: number): number;
  get_value_end(): number;
}

const utf8Decoder = new TextDecoder('utf-8');

let _instance: VectorJSON | null = null;

/**
 * Initialize VectorJSON by loading and linking the WASM module.
 * Call this once; subsequent calls return the cached instance.
 */
export async function init(options?: {
  engineWasm?: string | URL | BufferSource;
}): Promise<VectorJSON> {
  if (_instance) return _instance;

  // Resolve WASM file paths
  const distDir =
    typeof __dirname !== "undefined"
      ? __dirname
      : dirname(fileURLToPath(import.meta.url));

  const enginePath = join(distDir, "engine.wasm");

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

  // --- Instantiate Zig engine ---
  const engineModule = await WebAssembly.compile(engineBytes);
  const engineInstance = await WebAssembly.instantiate(engineModule, {});
  const engine = engineInstance.exports as unknown as EngineExports;

  const encoder = new TextEncoder();

  // --- Persistent input buffer — grows to accommodate largest input, never shrinks ---
  let inputBufPtr = 0;
  let inputBufLen = 0;

  function ensureInputBuffer(needed: number): number {
    if (needed <= inputBufLen) return inputBufPtr;
    // Free old buffer
    if (inputBufPtr !== 0) engine.dealloc(inputBufPtr, inputBufLen);
    // Allocate with doubling strategy (minimum 4KB)
    let cap = inputBufLen === 0 ? 4096 : inputBufLen;
    while (cap < needed) cap *= 2;
    const ptr = engine.alloc(cap);
    if (ptr === 0) throw new Error("VectorJSON: Failed to allocate input buffer");
    inputBufPtr = ptr;
    inputBufLen = cap;
    return ptr;
  }

  // --- Reusable key buffer — avoids alloc/dealloc per property access ---
  let keyBufPtr = 0;
  let keyBufCap = 0;

  function writeKeyToMemory(str: string): { ptr: number; len: number } {
    if (str.length === 0) return { ptr: 1, len: 0 };
    const maxBytes = str.length * 3;
    if (maxBytes > keyBufCap) {
      if (keyBufPtr !== 0) engine.dealloc(keyBufPtr, keyBufCap);
      let cap = keyBufCap === 0 ? 256 : keyBufCap;
      while (cap < maxBytes) cap *= 2;
      keyBufPtr = engine.alloc(cap);
      if (keyBufPtr === 0) throw new Error("VectorJSON: Failed to allocate key buffer");
      keyBufCap = cap;
    }
    const target = new Uint8Array(engine.memory.buffer, keyBufPtr, maxBytes);
    const result = encoder.encodeInto(str, target);
    return { ptr: keyBufPtr, len: result.written! };
  }

  // --- Constants ---
  const TAG_NULL = 0;
  const TAG_TRUE = 1;
  const TAG_FALSE = 2;
  const TAG_NUMBER = 3;
  const TAG_STRING = 4;
  const TAG_OBJECT = 5;
  const TAG_ARRAY = 6;

  const FEED_STATUS: readonly FeedStatus[] = ["incomplete", "complete", "error", "end_early"];
  const CLASSIFY_INCOMPLETE = 0;
  const CLASSIFY_COMPLETE_EARLY = 2;
  const CLASSIFY_INVALID = 3;

  // --- Sentinel to mark lazy proxy objects ---
  const LAZY_PROXY = Symbol("vectorjson.lazy");

  // --- Explicit document disposal ---
  // Track generation per docId to prevent stale FinalizationRegistry callbacks
  // from freeing a reused slot. Each parse increments the generation.
  const docGenerations = new Map<number, number>();

  // --- FinalizationRegistry for auto-cleanup of document slots ---
  const docRegistry = new FinalizationRegistry(
    ({ docId, generation }: { docId: number; generation: number }) => {
      if (docGenerations.get(docId) !== generation) return; // stale callback
      docGenerations.delete(docId);
      engine.doc_free(docId);
    },
  );

  // --- Read a doc string at a tape index into a JS string ---
  function docReadString(docId: number, index: number): string {
    const len = engine.doc_read_string_raw(docId, index);
    // WASM returns u32 but JS sees i32 — guard against corrupted lengths
    // (can happen when SIMD parsing reads past truncated unicode escapes)
    if (len <= 0 || len > 0x7FFFFFFF) return "";
    const batchPtr = engine.doc_batch_ptr();
    const ptr = new Uint32Array(engine.memory.buffer, batchPtr, 2)[0];
    return utf8Decoder.decode(new Uint8Array(engine.memory.buffer, ptr, len));
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

  /** Batch-read all element tape indices for an array. ONE WASM call → O(1) per access. */
  function batchElemIndices(target: any): Uint32Array {
    if (target._e) return target._e;
    const count = engine.doc_array_elements(target._d, target._i);
    const batchPtr = engine.doc_batch_ptr();
    const indices = new Uint32Array(count);
    indices.set(new Uint32Array(engine.memory.buffer, batchPtr, count));
    target._e = indices;
    return indices;
  }

  /** Resolve a tape value: primitives return directly.
   *  Objects: deep-materialize (complete parses) or Proxy (incomplete, for isComplete).
   *  Arrays: always lazy Proxy. */
  function resolveValue(
    docId: number, index: number,
    keepAlive: object, generation: number,
    freeFn: (() => void) | undefined,
    proxyObjects = false,
  ): unknown {
    const tag = engine.doc_get_tag(docId, index);
    if (tag === TAG_NULL) return null;
    if (tag === TAG_TRUE) return true;
    if (tag === TAG_FALSE) return false;
    if (tag === TAG_NUMBER) return engine.doc_get_number(docId, index);
    if (tag === TAG_STRING) return docReadString(docId, index);

    // Objects: Proxy for incomplete parses (so isComplete can get tape index),
    // deep-materialize for complete parses (fast native property access).
    if (tag === TAG_OBJECT) {
      if (proxyObjects) {
        const t: any = {};
        t._d = docId; t._i = index; t._k = keepAlive;
        t._g = generation; t._f = freeFn;
        return new Proxy(t, docObjHandler);
      }
      return deepMaterializeDoc(docId, index);
    }

    // Arrays → lazy Proxy (materialize elements on access, cached)
    const t: any = [];
    t._d = docId;
    t._i = index;
    t._k = keepAlive;
    t._g = generation;
    t._f = freeFn;
    t._l = engine.doc_get_count(docId, index);
    t._p = proxyObjects; // propagate to child resolution
    return new Proxy(t, docArrHandler);
  }

  // --- Shared Proxy handler for doc-backed array cursors ---
  const docArrHandler: ProxyHandler<any> = {
    get(target, prop, _receiver) {
      if (prop === 'free' || prop === Symbol.dispose) return target._f;
      if (prop === LAZY_PROXY) return { docId: target._d, index: target._i };
      if (prop === 'length') return target._l;
      if (prop === Symbol.iterator) {
        const t = target; // single capture instead of 7 locals
        return function () {
          let i = 0;
          return {
            next() {
              if (i >= t._l) return { done: true as const, value: undefined };
              // Use indexed get to populate cache (avoids double-resolving)
              return { done: false as const, value: docArrHandler.get!(t, String(i++), t) };
            },
          };
        };
      }
      if (prop === Symbol.toPrimitive) return undefined;
      if (prop === Symbol.toStringTag) return "Array";
      if (typeof prop === 'string') {
        const idx = Number(prop);
        if (Number.isInteger(idx) && idx >= 0 && idx < target._l) {
          if (!target._c) target._c = new Array(target._l);
          if (target._c[idx] !== undefined) return target._c[idx];
          const indices = batchElemIndices(target);
          const val = resolveValue(target._d, indices[idx], target._k, target._g, target._f, target._p);
          target._c[idx] = val;
          return val;
        }
        if (prop in Array.prototype) {
          const materialized = deepMaterializeDoc(target._d, target._i) as unknown[];
          return (materialized as unknown as Record<string, unknown>)[prop];
        }
      }
      return undefined;
    },
    has(target, prop) {
      if (prop === LAZY_PROXY) return true;
      if (prop === 'free' || prop === Symbol.dispose) return true;
      if (prop === 'length') return true;
      if (typeof prop === 'string') {
        const idx = Number(prop);
        if (Number.isInteger(idx) && idx >= 0 && idx < target._l) return true;
      }
      return false;
    },
    ownKeys(target) {
      const keys: string[] = [];
      for (let i = 0; i < target._l; i++) keys.push(String(i));
      keys.push('length');
      return keys;
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop === 'length') {
        return { value: target._l, writable: false, enumerable: false, configurable: false };
      }
      if (typeof prop === 'string') {
        const idx = Number(prop);
        if (Number.isInteger(idx) && idx >= 0 && idx < target._l) {
          return { value: this.get!(target, prop, target), writable: false, enumerable: true, configurable: true };
        }
      }
      return undefined;
    },
  };

  // --- Shared Proxy handler for doc-backed object proxies (incomplete parses) ---
  const docObjHandler: ProxyHandler<any> = {
    get(target, prop, _receiver) {
      if (prop === 'free' || prop === Symbol.dispose) return target._f;
      if (prop === LAZY_PROXY) return { docId: target._d, index: target._i };
      if (prop === Symbol.toPrimitive) return undefined;
      if (prop === Symbol.toStringTag) return "Object";
      if (typeof prop !== 'string') return undefined;
      if (!target._c) target._c = Object.create(null);
      if (prop in target._c) return target._c[prop];
      const { ptr, len } = writeKeyToMemory(prop);
      const valIdx = engine.doc_find_field(target._d, target._i, ptr, len);
      if (valIdx === 0) return undefined;
      const val = resolveValue(target._d, valIdx, target._k, target._g, target._f, true);
      target._c[prop] = val;
      return val;
    },
    has(target, prop) {
      if (prop === LAZY_PROXY || prop === 'free' || prop === Symbol.dispose) return true;
      if (typeof prop !== 'string') return false;
      const { ptr, len } = writeKeyToMemory(prop);
      return engine.doc_find_field(target._d, target._i, ptr, len) !== 0;
    },
    ownKeys(target) {
      if (!target._keys) {
        target._keys = [];
        const count = engine.doc_object_keys(target._d, target._i);
        const batchPtr = engine.doc_batch_ptr();
        const idxCopy = new Uint32Array(count);
        idxCopy.set(new Uint32Array(engine.memory.buffer, batchPtr, count));
        for (let i = 0; i < count; i++) {
          target._keys.push(docReadString(target._d, idxCopy[i]));
        }
      }
      return target._keys;
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop !== 'string') return undefined;
      // JSON cannot produce undefined — get() returning undefined means field not found
      const val = this.get!(target, prop, target);
      if (val === undefined) return undefined;
      return { value: val, writable: false, enumerable: true, configurable: true };
    },
  };

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

  // --- Build a value from a doc slot root (shared by parse + createParser) ---
  function buildDocRoot(docId: number, proxyObjects = false): unknown {
    const rootTag = engine.doc_get_tag(docId, 1);
    // Primitives: extract value and free doc immediately (no Proxy needed)
    if (rootTag <= TAG_STRING) {
      const value = rootTag === TAG_NULL ? null
        : rootTag === TAG_TRUE ? true
        : rootTag === TAG_FALSE ? false
        : rootTag === TAG_NUMBER ? engine.doc_get_number(docId, 1)
        : docReadString(docId, 1);
      engine.doc_free(docId);
      return value;
    }
    // Containers: register for GC and wrap in Proxy with manual .free()
    const generation = (docGenerations.get(docId) ?? 0) + 1;
    docGenerations.set(docId, generation);
    const keepAlive = { docId };
    docRegistry.register(keepAlive, { docId, generation }, keepAlive);
    const freeFn = () => {
      void keepAlive; // prevent GC of sentinel
      if (docGenerations.get(docId) !== generation) return;
      docGenerations.delete(docId);
      engine.doc_free(docId);
      docRegistry.unregister(keepAlive);
    };
    // Root always gets Proxy so .free() is accessible; force objects to Proxy for isComplete()
    return resolveValue(docId, 1, keepAlive, generation, freeFn, rootTag === TAG_OBJECT ? true : proxyObjects);
  }

  // --- Helper: retry doc_parse with GC on slot exhaustion ---
  function tryDocParse(p: number, l: number): number {
    let docId = engine.doc_parse(p, l);
    if (docId < 0) {
      const errCode = engine.get_error_code();
      if (errCode === 2 || errCode === 13) {
        if (typeof globalThis.gc === "function") globalThis.gc();
        docId = engine.doc_parse(p, l);
      }
    }
    return docId;
  }

  // --- Public API ---
  _instance = {
    parse(input: string | Uint8Array): ParseResult {
      // Write input into reusable WASM buffer with extra headroom for autocomplete
      let ptr: number;
      let len: number;
      if (typeof input === "string") {
        const maxBytes = input.length * 3 + 64;
        ptr = ensureInputBuffer(maxBytes);
        const target = new Uint8Array(engine.memory.buffer, ptr, maxBytes);
        const result = encoder.encodeInto(input, target);
        len = result.written!;
      } else {
        len = input.byteLength;
        ptr = ensureInputBuffer(len + 64);
        new Uint8Array(engine.memory.buffer, ptr, len).set(input);
      }
      // Pad after input for SIMD safety
      new Uint8Array(engine.memory.buffer, ptr + len, 64).fill(0x20);

      // Helper: build ParseResult with isComplete() and toJSON()
      const makeResult = (
        status: ParseStatus,
        value: unknown,
        autocompleteBoundary: number,
        toJSONStr: string | undefined,
        remaining?: Uint8Array,
        error?: string,
      ): ParseResult => {
        let _toJSONCached = false;
        let _toJSONCache: unknown;
        return {
          status,
          value,
          remaining,
          error,
          isComplete(val: unknown): boolean {
            if (autocompleteBoundary === Infinity) return true;
            if (val === null || val === undefined || typeof val !== "object") return true;
            try {
              const handle = (val as any)[LAZY_PROXY] as { docId?: number; index?: number } | undefined;
              if (!handle || typeof handle.docId !== "number") return true;
              const tag = engine.doc_get_tag(handle.docId, handle.index!);
              if (tag === TAG_OBJECT || tag === TAG_ARRAY) {
                const closeIdx = engine.doc_get_close_index(handle.docId, handle.index!);
                const closeSrcPos = engine.doc_get_src_pos(handle.docId, closeIdx);
                return closeSrcPos < autocompleteBoundary;
              }
              return true;
            } catch {
              return true; // fail-safe: freed doc → treat as complete
            }
          },
          toJSON(): unknown {
            if (_toJSONCached) return _toJSONCache;
            if (toJSONStr !== undefined) {
              _toJSONCache = JSON.parse(toJSONStr);
            } else {
              _toJSONCache = value;
            }
            _toJSONCached = true;
            return _toJSONCache;
          },
        };
      };

      // Helper: build an invalid ParseResult from the last engine error code
      const invalidResult = (msg?: string): ParseResult => {
        if (!msg) {
          const code = engine.get_error_code();
          msg = `VectorJSON: ${ERROR_MESSAGES[code] || `Parse error (code ${code})`}`;
        }
        return makeResult("invalid", undefined, Infinity, undefined, undefined, msg);
      };

      // ── Happy path: try doc_parse directly (no classify overhead) ──
      let docId = tryDocParse(ptr, len);
      if (docId >= 0) {
        // For string input at full length, reuse the original string (avoids decode)
        const toJSONStr = typeof input === "string" ? input
          : utf8Decoder.decode(new Uint8Array(engine.memory.buffer, ptr, len));
        return makeResult("complete", buildDocRoot(docId), Infinity, toJSONStr);
      }

      // ── doc_parse failed — classify to determine why ──
      const classification = engine.classify_input(ptr, len);

      if (classification === CLASSIFY_INVALID) {
        return invalidResult("Invalid JSON structure");
      }

      if (classification === CLASSIFY_COMPLETE_EARLY) {
        const parseLen = engine.get_value_end();
        const remainLen = len - parseLen;
        const remainingCopy = new Uint8Array(remainLen);
        remainingCopy.set(new Uint8Array(engine.memory.buffer, ptr + parseLen, remainLen));
        new Uint8Array(engine.memory.buffer, ptr + parseLen, 64).fill(0x20);

        const toJSONStr = utf8Decoder.decode(new Uint8Array(engine.memory.buffer, ptr, parseLen));
        docId = tryDocParse(ptr, parseLen);
        if (docId >= 0) {
          return makeResult("complete_early", buildDocRoot(docId), Infinity, toJSONStr, remainingCopy);
        }
        return invalidResult();
      }

      if (classification === CLASSIFY_INCOMPLETE) {
        const parseLen = engine.autocomplete_input(ptr, len, inputBufLen);
        if (parseLen === 0) {
          if (len === 0) return makeResult("incomplete", undefined, len, undefined);
          return invalidResult("Invalid JSON structure");
        }
        const toJSONStr = utf8Decoder.decode(new Uint8Array(engine.memory.buffer, ptr, parseLen));
        docId = tryDocParse(ptr, parseLen);
        if (docId >= 0) {
          return makeResult("incomplete", buildDocRoot(docId, true), len, toJSONStr);
        }
        return invalidResult();
      }

      return invalidResult();
    },

    materialize(value: unknown): unknown {
      if (!isLazyProxy(value)) return value;
      const { docId, index } = (value as any)[LAZY_PROXY];
      return deepMaterializeDoc(docId, index);
    },

    stringify(value: unknown): string {
      return JSON.stringify(value);
    },

    parsePartialJson(input: string): PartialJsonResult {
      if (!input) return { value: undefined, state: "failed-parse" };
      const result = _instance!.parse(input);
      switch (result.status) {
        case "complete":
        case "complete_early":
          return { value: result.toJSON(), state: "successful-parse" };
        case "incomplete":
          return { value: result.toJSON(), state: "repaired-parse" };
        default:
          return { value: undefined, state: "failed-parse" };
      }
    },

    createParser(): StreamingParser {
      const streamId = engine.stream_create();
      if (streamId < 0) {
        throw new Error("VectorJSON: Failed to create streaming parser (max 4 concurrent)");
      }

      let destroyed = false;
      let cachedValue: unknown = undefined;
      let valueResolved = false;
      let cachedRemaining: Uint8Array | null | undefined; // undefined = not yet cached

      return {
        feed(chunk: Uint8Array | string): FeedStatus {
          if (destroyed) throw new Error("Parser already destroyed");
          const bytes =
            typeof chunk === "string" ? encoder.encode(chunk) : chunk;
          const len = bytes.byteLength;
          if (len === 0) return FEED_STATUS[engine.stream_get_status(streamId)]!;

          // Allocate in engine memory and copy the chunk
          const ptr = engine.alloc(len);
          if (ptr === 0) throw new Error("VectorJSON: allocation failed");

          try {
            new Uint8Array(engine.memory.buffer, ptr, len).set(bytes);
            const status = engine.stream_feed(streamId, ptr, len);
            return FEED_STATUS[status] || "error";
          } finally {
            engine.dealloc(ptr, len);
          }
        },

        getValue(): unknown {
          if (destroyed) throw new Error("Parser already destroyed");
          if (valueResolved) return cachedValue;

          const status = engine.stream_get_status(streamId);
          if (status === 0) {
            throw new Error("VectorJSON: JSON is incomplete, feed more data");
          }
          if (status === 2) {
            throw new SyntaxError("VectorJSON: Parse error in stream");
          }

          // complete or end_early — parse the accumulated buffer via doc_parse
          const bufPtr = engine.stream_get_buffer_ptr(streamId);
          const valueLen = engine.stream_get_value_len(streamId);

          // Save remaining bytes BEFORE SIMD padding (padding starts at bufPtr + valueLen,
          // which is exactly where remaining bytes live in the end_early case)
          if (cachedRemaining === undefined) {
            const rPtr = engine.stream_get_remaining_ptr(streamId);
            const rLen = engine.stream_get_remaining_len(streamId);
            if (rLen > 0) {
              cachedRemaining = new Uint8Array(rLen);
              cachedRemaining.set(new Uint8Array(engine.memory.buffer, rPtr, rLen));
            } else {
              cachedRemaining = null;
            }
          }

          // Pad for SIMD safety (zimdjson needs 64 bytes of padding)
          new Uint8Array(engine.memory.buffer, bufPtr + valueLen, 64).fill(0x20);

          const docId = engine.doc_parse(bufPtr, valueLen);
          if (docId < 0) {
            const errorCode = engine.get_error_code();
            const msg = ERROR_MESSAGES[errorCode] || `Parse error (code ${errorCode})`;
            throw new SyntaxError(`VectorJSON: ${msg}`);
          }
          cachedValue = buildDocRoot(docId);

          valueResolved = true;
          return cachedValue;
        },

        getRemaining(): Uint8Array | null {
          if (destroyed) return null;
          // Return cached copy if getValue() already saved it (padding may have overwritten original)
          if (cachedRemaining !== undefined) return cachedRemaining;
          const rPtr = engine.stream_get_remaining_ptr(streamId);
          const rLen = engine.stream_get_remaining_len(streamId);
          if (rLen === 0) { cachedRemaining = null; return null; }
          cachedRemaining = new Uint8Array(rLen);
          cachedRemaining.set(new Uint8Array(engine.memory.buffer, rPtr, rLen));
          return cachedRemaining;
        },

        getStatus(): FeedStatus {
          if (destroyed) return "error";
          const status = engine.stream_get_status(streamId);
          return FEED_STATUS[status] || "error";
        },

        destroy(): void {
          if (!destroyed) {
            engine.stream_destroy(streamId);
            destroyed = true;
            cachedValue = undefined;
            valueResolved = false;
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
export async function parse(input: string | Uint8Array): Promise<ParseResult> {
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
 * Convenience: parse partial JSON using a pre-initialized instance.
 * Drop-in replacement for AI SDK partial JSON parsers.
 * Initializes on first call.
 *
 * ```ts
 * import { parsePartialJson } from 'vectorjson';
 * const { value, state } = await parsePartialJson('{"a": 1, "b": ');
 * ```
 */
export async function parsePartialJson(input: string): Promise<PartialJsonResult> {
  const vj = await init();
  return vj.parsePartialJson(input);
}
