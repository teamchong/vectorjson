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

import { wasmBase64 } from "./engine-wasm.generated.js";

function decodeBase64(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined")
    return new Uint8Array(Buffer.from(b64, "base64").buffer);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// --- Types ---

export type ParseStatus = "complete" | "complete_early" | "incomplete" | "invalid";
export type FeedStatus = "incomplete" | "complete" | "error" | "end_early";

/** Result shape compatible with Vercel AI SDK's parsePartialJson */
export type PartialJsonState =
  | "successful-parse"
  | "repaired-parse"
  | "failed-parse";

/** Discriminated union — narrows `value` type when you check `state`. */
export type PartialJsonResult<T = unknown> =
  | { value: T; state: "successful-parse" }
  | { value: T | undefined; state: "repaired-parse" }
  | { value: undefined; state: "failed-parse" };

/** Recursively make all properties optional — matches Vercel AI SDK's DeepPartial. */
export type DeepPartial<T> =
  T extends object
    ? T extends Array<infer U>
      ? Array<DeepPartial<U>>
      : { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export interface StreamingParser<T = unknown> {
  /** Feed a chunk of bytes to the parser. Only NEW bytes are scanned (O(chunk_size)). */
  feed(chunk: Uint8Array | string): FeedStatus;
  /** Get the parsed value. Returns autocompleted partial value while incomplete, final value when complete; throws on parse errors. */
  getValue(): T | undefined;
  /** Get remaining bytes after end_early status (for NDJSON). */
  getRemaining(): Uint8Array | null;
  /** Get the current status without feeding data. */
  getStatus(): FeedStatus;
  /** Copy the accumulated stream buffer into a new ArrayBuffer (for Worker postMessage transfer). */
  getRawBuffer(): ArrayBuffer | null;
  /** Destroy the parser and free all resources. */
  destroy(): void;
  /** Async iteration over partial values when a source was provided. */
  [Symbol.asyncIterator](): AsyncIterableIterator<T | undefined>;
}

/** Zod-like schema type for createParser options. */
export type ZodLike<T> = { safeParse: (v: unknown) => { success: boolean; data?: T } };

/** Options for createParser when using an options object. */
export interface CreateParserOptions<T = unknown> {
  /** Only include these top-level or nested fields (dot-separated paths). */
  pick?: string[];
  /** Schema for validation on complete values. */
  schema?: ZodLike<T>;
  /** Stream source — makes the parser async-iterable via for-await. */
  source?: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>;
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

// --- EventParser Types ---

/** Compiled path segment: string = key, number = index, '*' = wildcard */
export type PathSegment = string | number;

export interface PathEvent {
  type: 'value';
  path: string;
  value: unknown;
  offset: number;
  length: number;
  index?: number;
  key?: string;
  matches: (string | number)[];
}

export interface DeltaEvent {
  type: 'delta';
  path: string;
  value: string;
  offset: number;
  length: number;
}

export interface RootEvent {
  type: 'root';
  index: number;
  value: unknown;
}

export interface EventParser {
  on(path: string, callback: (event: PathEvent) => void): EventParser;
  on<T>(path: string, schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, callback: (event: PathEvent & { value: T }) => void): EventParser;
  onDelta(path: string, callback: (event: DeltaEvent) => void): EventParser;
  onText(callback: (text: string) => void): EventParser;
  skip(...paths: string[]): EventParser;
  off(path: string, callback?: Function): EventParser;
  feed(chunk: string | Uint8Array): FeedStatus;
  getValue(): unknown | undefined;
  getRemaining(): Uint8Array | null;
  getStatus(): FeedStatus;
  /** Copy the accumulated stream buffer into a new ArrayBuffer (for Worker postMessage transfer). */
  getRawBuffer(): ArrayBuffer | null;
  destroy(): void;
  /** Async iteration over partial values when a source was provided. */
  [Symbol.asyncIterator](): AsyncIterableIterator<unknown | undefined>;
}

export interface VectorJSON {
  /**
   * Parse a JSON string or Uint8Array into a value.
   * Primitives (null, boolean, number) are returned directly as JS values.
   * Objects and arrays return Proxy objects — values materialize only when accessed.
   * Call .free() on the result to release resources immediately, or let
   * FinalizationRegistry handle it automatically when the Proxy is GC'd.
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
   * Create a streaming parser with schema validation.
   * `getValue()` returns `undefined` when the schema rejects the value (same as incomplete).
   * T is auto-inferred from the schema — no manual `<T>` needed.
   *
   * ```ts
   * const parser = vj.createParser(z.object({ name: z.string() }));
   * parser.feed('{"name":"Alice"}');
   * parser.getValue(); // { name: string } | undefined
   * ```
   */
  createParser<T>(schema: ZodLike<T>): StreamingParser<T>;
  /**
   * Create a streaming parser with options: field picking, schema, and/or stream source.
   *
   * ```ts
   * // Pick specific fields + async iteration:
   * const parser = vj.createParser({
   *   pick: ["name", "age"],
   *   source: response.body,
   * });
   * for await (const partial of parser) {
   *   console.log(partial); // only picked fields
   * }
   * ```
   */
  createParser<T = unknown>(options: CreateParserOptions<T>): StreamingParser<T>;
  /**
   * Deep-compare two values for structural equality.
   * When both values are VJ proxies, comparison happens entirely in WASM
   * (walks tapes in linear memory — zero JS allocations, zero Proxy traps).
   * Falls back to JSON.stringify comparison for plain JS objects.
   *
   * By default, object key order does not matter (`{"a":1,"b":2}` equals `{"b":2,"a":1}`).
   * Pass `{ ordered: true }` for faster key-order-sensitive comparison.
   */
  deepCompare(a: unknown, b: unknown, options?: { ignoreKeyOrder?: boolean }): boolean;
  /**
   * Eagerly materialize a lazy proxy into plain JS objects.
   * If the value is already a plain JS value, returns it as-is.
   */
  materialize(value: unknown): unknown;
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
  /**
   * Parse partial JSON with schema-inferred types.
   * T is auto-inferred from the schema — no manual `<T>` needed.
   *
   * Returns `DeepPartial<T>` because incomplete JSON will have missing fields.
   * When `safeParse` succeeds, returns the validated `data`.
   * When `safeParse` fails on a repaired-parse, returns the raw parsed value
   * (typed as `DeepPartial<T>`) — the object is partial, that's expected.
   *
   * ```ts
   * const User = z.object({ name: z.string(), age: z.number() });
   * const { value, state } = vj.parsePartialJson('{"name":"Al', User);
   * // value: { name?: string; age?: number } | undefined
   * // state: "repaired-parse"
   * ```
   */
  parsePartialJson<T>(input: string, schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }): PartialJsonResult<DeepPartial<T>>;
  /**
   * Create an event-driven streaming parser with path subscriptions,
   * string delta emission, multi-root support, and JSON boundary detection.
   */
  createEventParser(options?: {
    multiRoot?: boolean;
    onRoot?: (event: RootEvent) => void;
  }): EventParser;
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
  doc_get_input_ptr(docId: number): number;
  doc_batch_ptr(): number;
  doc_array_elements(docId: number, arrIndex: number, resumeAt: number): number;
  doc_object_keys(docId: number, objIndex: number, resumeAt: number): number;
  doc_deep_equal(doc_a: number, idx_a: number, doc_b: number, idx_b: number, ordered: number): number;
  stream_create(): number;
  stream_destroy(id: number): void;
  stream_feed(id: number, ptr: number, len: number): number;
  stream_get_status(id: number): number;
  stream_get_buffer_ptr(id: number): number;
  stream_get_value_len(id: number): number;
  stream_get_remaining_ptr(id: number): number;
  stream_get_remaining_len(id: number): number;
  stream_get_buffer_len(id: number): number;
  stream_get_buffer_cap(id: number): number;
  stream_reset_for_next(id: number): number;
  classify_input(ptr: number, len: number): number;
  autocomplete_input(ptr: number, len: number, buf_cap: number): number;
  get_value_end(): number;
}

const utf8Decoder = new TextDecoder('utf-8');

// Pre-computed byte→char table — avoids String.fromCharCode() calls in hot loops
const B2C: string[] = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i));

let _instance: VectorJSON | null = null;

/**
 * Initialize VectorJSON by loading and linking the WASM module.
 * Call this once; subsequent calls return the cached instance.
 */
export async function init(options?: {
  engineWasm?: string | URL | BufferSource;
}): Promise<VectorJSON> {
  if (_instance) return _instance;

  // Load WASM bytes — embedded base64 by default, filesystem/URL/buffer when explicit
  let engineBytes: BufferSource;
  const wasmOpt = options?.engineWasm;
  if (wasmOpt instanceof ArrayBuffer || ArrayBuffer.isView(wasmOpt)) {
    engineBytes = wasmOpt as BufferSource;
  } else if (typeof wasmOpt === "string" || wasmOpt instanceof URL) {
    // Dynamic import for filesystem — only when user explicitly passes a path
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const path = typeof wasmOpt === "string" ? wasmOpt : fileURLToPath(wasmOpt);
    engineBytes = await readFile(path);
  } else {
    engineBytes = decodeBase64(wasmBase64).buffer as ArrayBuffer;
  }

  // --- Instantiate Zig engine ---
  const { instance: engineInstance } = await WebAssembly.instantiate(engineBytes as ArrayBuffer, {});
  const engine = engineInstance.exports as unknown as EngineExports;

  const encoder = new TextEncoder();

  // --- Reusable WASM buffers — grow-only, shared allocator pattern ---
  const inputBuf = { ptr: 0, cap: 0 };
  const keyBuf = { ptr: 0, cap: 0 };
  const feedBuf = { ptr: 0, cap: 0 };

  function ensureBuf(buf: typeof inputBuf, needed: number, minCap: number): number {
    if (needed <= buf.cap) return buf.ptr;
    if (buf.ptr !== 0) engine.dealloc(buf.ptr, buf.cap);
    let cap = buf.cap === 0 ? minCap : buf.cap;
    while (cap < needed) cap *= 2;
    buf.ptr = engine.alloc(cap) >>> 0;
    if (buf.ptr === 0) throw new Error("VectorJSON: allocation failed");
    buf.cap = cap;
    return buf.ptr;
  }

  /** Encode string or copy Uint8Array into a reusable WASM buffer. Returns { ptr, len }. */
  function writeToWasm(
    input: string | Uint8Array, buf: typeof inputBuf, extraCap: number, minCap: number,
  ): { ptr: number; len: number } {
    if (typeof input === "string") {
      // Try optimistic allocation (1x for likely-ASCII), fall back to 3x for multi-byte
      let maxBytes = input.length + extraCap;
      let ptr = ensureBuf(buf, maxBytes, minCap);
      let result = encoder.encodeInto(input, new Uint8Array(engine.memory.buffer, ptr, maxBytes));
      if (result.read! < input.length) {
        // Input has multi-byte chars — reallocate with worst-case 3x
        maxBytes = input.length * 3 + extraCap;
        ptr = ensureBuf(buf, maxBytes, minCap);
        result = encoder.encodeInto(input, new Uint8Array(engine.memory.buffer, ptr, maxBytes));
      }
      return { ptr, len: result.written! };
    }
    const len = input.byteLength;
    const ptr = ensureBuf(buf, len + extraCap, minCap);
    new Uint8Array(engine.memory.buffer, ptr, len).set(input);
    return { ptr, len };
  }

  function writeKeyToMemory(key: string): { ptr: number; len: number } {
    if (key.length === 0) return { ptr: 1, len: 0 };
    return writeToWasm(key, keyBuf, 0, 256);
  }

  // --- Constants ---
  // Batch buffer address is a fixed global in WASM — cache to avoid repeated WASM calls
  const batchAddr = engine.doc_batch_ptr() >>> 0;

  const TAG_NULL = 0;
  const TAG_TRUE = 1;
  const TAG_FALSE = 2;
  const TAG_NUMBER = 3;
  const TAG_STRING = 4;
  const TAG_OBJECT = 5;
  const TAG_ARRAY = 6;

  const FEED_STATUS: readonly FeedStatus[] = ["incomplete", "complete", "error", "end_early"];
  const CLASSIFY_INCOMPLETE = 0;  // FeedStatus.incomplete
  const CLASSIFY_ERR = 2;         // FeedStatus.err
  const CLASSIFY_END_EARLY = 3;   // FeedStatus.end_early

  // --- Sentinels ---
  const LAZY_PROXY = Symbol("vectorjson.lazy");
  const UNCACHED = Symbol();

  // --- Explicit document disposal ---
  // Track generation per docId to prevent stale FinalizationRegistry callbacks
  // from freeing a reused slot. Each parse increments the generation.
  const docGenerations = new Map<number, number>();

  // --- FinalizationRegistry for auto-cleanup of document slots ---
  const docRegistry = new FinalizationRegistry(
    ({ docId, generation }: { docId: number; generation: number }) => {
      if (docGenerations.get(docId) !== generation) return; // stale callback
      docGenerations.delete(docId);
      docInputs.delete(docId);
      engine.doc_free(docId);
    },
  );

  /** Copy `count` u32 indices from the WASM batch buffer into a JS Uint32Array. */
  function copyBatchIndices(count: number): Uint32Array {
    const copy = new Uint32Array(count);
    copy.set(new Uint32Array(engine.memory.buffer, batchAddr, count));
    return copy;
  }

  /** Read all batch indices with pagination for >16384 items. */
  function readBatchPaginated(
    fn: (docId: number, idx: number, resume: number) => number,
    docId: number, idx: number,
  ): Uint32Array {
    const BATCH_CAP = 16384;
    let count = fn(docId, idx, 0);
    if (count < BATCH_CAP) return copyBatchIndices(count);
    const all: number[] = [];
    let page = copyBatchIndices(count);
    for (let i = 0; i < count; i++) all.push(page[i]);
    while (count === BATCH_CAP) {
      const resumeAt = new Uint32Array(engine.memory.buffer, batchAddr + BATCH_CAP * 4, 1)[0];
      count = fn(docId, idx, resumeAt);
      page = copyBatchIndices(count);
      for (let i = 0; i < count; i++) all.push(page[i]);
    }
    return new Uint32Array(all);
  }

  // --- Per-document original input tracking (for ASCII fast-path) ---
  // When input is a JS string and all chars are ASCII (byteLen === str.length),
  // we can slice the original string directly instead of reading WASM memory.
  const docInputs = new Map<number, string>();

  // --- Read a doc string at a tape index into a JS string ---
  // Strings are stored as source offsets into the original input.
  // The escape flag (batch_buffer[2]) tells us if decoding is needed,
  // avoiding a linear scan with includes('\\').
  function docReadString(docId: number, index: number): string {
    const rawLen = engine.doc_read_string_raw(docId, index) >>> 0;
    if (rawLen === 0) return "";

    const batch = new Uint32Array(engine.memory.buffer, batchAddr, 3);
    const srcOffset = batch[0];
    const hasEscapes = batch[2];

    // ASCII fast-path: if original JS string is available and was ASCII,
    // slice directly — no WASM memory read, no TextDecoder overhead.
    const asciiInput = docInputs.get(docId);
    if (asciiInput !== undefined) {
      const raw = asciiInput.slice(srcOffset, srcOffset + rawLen);
      return hasEscapes ? JSON.parse('"' + raw + '"') : raw;
    }

    const inputPtr = engine.doc_get_input_ptr(docId) >>> 0;
    const raw = utf8Decoder.decode(
      new Uint8Array(engine.memory.buffer, inputPtr + srcOffset, rawLen),
    );
    // has_escapes flag from SIMD skipString — no need for includes('\\')
    return hasEscapes ? JSON.parse('"' + raw + '"') : raw;
  }

  // --- Deep materialize from document tape ---
  // For containers (objects/arrays), slices the source span from WASM memory
  // and delegates to native JSON.parse — faster than recursive tape walking.
  // For primitives, reads directly from the tape.
  function deepMaterializeDoc(docId: number, index: number): unknown {
    const tag = engine.doc_get_tag(docId, index);
    if (tag === TAG_NULL) return null;
    if (tag === TAG_TRUE) return true;
    if (tag === TAG_FALSE) return false;
    if (tag === TAG_NUMBER) return engine.doc_get_number(docId, index);
    if (tag === TAG_STRING) return docReadString(docId, index);
    if (tag === TAG_OBJECT || tag === TAG_ARRAY) {
      // Get source span: opening bracket → closing bracket (inclusive)
      // doc_get_close_index returns one-past-end (simdjson convention for skipping).
      // The actual closing bracket is at closeIdx - 1.
      const startPos = (engine.doc_get_src_pos(docId, index) >>> 0);
      const closingTapeIdx = engine.doc_get_close_index(docId, index) - 1;
      const closePos = engine.doc_get_src_pos(docId, closingTapeIdx);
      const inputPtr = engine.doc_get_input_ptr(docId) >>> 0;
      const raw = new Uint8Array(
        engine.memory.buffer, inputPtr + startPos, closePos + 1 - startPos,
      );
      return JSON.parse(utf8Decoder.decode(raw));
    }
    return null;
  }

  /** Batch-read all element tape indices for an array (cached). */
  function batchElemIndices(target: any): Uint32Array {
    return target._e || (target._e = readBatchPaginated(engine.doc_array_elements, target._d, target._i));
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
        return new Proxy({ _d: docId, _i: index, _k: keepAlive, _g: generation, _f: freeFn } as any, docObjHandler);
      }
      return deepMaterializeDoc(docId, index);
    }

    // Arrays → lazy Proxy (materialize elements on access, cached)
    return new Proxy(
      Object.assign([], { _d: docId, _i: index, _k: keepAlive, _g: generation, _f: freeFn,
        _l: engine.doc_get_count(docId, index), _p: proxyObjects }),
      docArrHandler,
    );
  }

  // --- Shared Proxy handler for doc-backed array cursors ---
  const docArrHandler: ProxyHandler<any> = {
    get(target, prop, _receiver) {
      if (prop === 'free' || prop === Symbol.dispose) return target._f;
      if (prop === LAZY_PROXY) return target._m || (target._m = { docId: target._d, index: target._i });
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
      if (prop === LAZY_PROXY || prop === 'free' || prop === Symbol.dispose || prop === 'length') return true;
      if (typeof prop !== 'string') return false;
      const idx = Number(prop);
      return Number.isInteger(idx) && idx >= 0 && idx < target._l;
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
  // doc_find_field compares raw source bytes against the key. For keys with
  // escape sequences (\n, \uXXXX), raw comparison fails — we fall back to
  // ownKeys iteration which properly decodes each key via docReadString.
  const docObjHandler: ProxyHandler<any> = {
    get(target, prop, _receiver) {
      if (prop === 'free' || prop === Symbol.dispose) return target._f;
      if (prop === LAZY_PROXY) return target._m || (target._m = { docId: target._d, index: target._i });
      if (typeof prop !== 'string') return prop === Symbol.toStringTag ? "Object" : undefined;
      if (!target._c) target._c = Object.create(null);
      if (prop in target._c) return target._c[prop];
      const { ptr, len } = writeKeyToMemory(prop);
      const valIdx = engine.doc_find_field(target._d, target._i, ptr, len);
      if (valIdx !== 0) {
        // Fast path: key matched raw source bytes (no escapes)
        const val = resolveValue(target._d, valIdx, target._k, target._g, target._f, true);
        target._c[prop] = val;
        return val;
      }
      // Fallback: escaped keys won't match raw bytes — iterate all keys
      const keys = this.ownKeys!(target) as string[];
      const keyIdx = keys.indexOf(prop);
      if (keyIdx === -1) return undefined;
      // Resolve value via cached key tape indices
      const val = resolveValue(target._d, target._ki[keyIdx] + 1, target._k, target._g, target._f, true);
      target._c[prop] = val;
      return val;
    },
    has(target, prop) {
      if (prop === LAZY_PROXY || prop === 'free' || prop === Symbol.dispose) return true;
      if (typeof prop !== 'string') return false;
      const { ptr, len } = writeKeyToMemory(prop);
      if (engine.doc_find_field(target._d, target._i, ptr, len) !== 0) return true;
      // Fallback for escaped keys
      const keys = this.ownKeys!(target) as string[];
      return keys.includes(prop);
    },
    ownKeys(target) {
      if (!target._keys) {
        const indices = readBatchPaginated(engine.doc_object_keys, target._d, target._i);
        target._ki = indices;
        target._keys = Array.from(indices, (idx) => docReadString(target._d, idx));
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
    if (value === null || typeof value !== "object") return false;
    try { return LAZY_PROXY in (value as Record<symbol, unknown>); }
    catch { return false; }
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
      docInputs.delete(docId);
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
      docInputs.delete(docId);
      engine.doc_free(docId);
      docRegistry.unregister(keepAlive);
    };
    // Root always gets Proxy so .free() is accessible; force objects to Proxy for isComplete()
    return resolveValue(docId, 1, keepAlive, generation, freeFn, rootTag === TAG_OBJECT || proxyObjects);
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

  // --- Helpers ---
  function isReadableStream(s: any): s is ReadableStream {
    return typeof s?.getReader === 'function';
  }

  // --- JSON Seeker Factory ---
  // Extracts a reusable state machine that skips non-JSON text (think tags, code fences, prose)
  // to find the start of JSON content. Used by both createEventParser and createParser.
  function createSeeker(textCallbacks?: ((text: string) => void)[]) {
    const SEEKING = 0, IN_THINK = 1, IN_FENCE = 2, FEEDING = 3;
    let state = SEEKING;
    let buf = '';
    let fenceBacktickCount = 0;

    return {
      feed(text: string): string | null {
        if (state === FEEDING) return text;

        const cbs = textCallbacks ?? [];
        let result = '';
        let i = 0;

        while (i < text.length) {
          if (state === FEEDING) {
            result += text.slice(i);
            break;
          }

          if (state === IN_THINK) {
            const closeIdx = text.indexOf('</think>', i);
            if (closeIdx === -1) {
              const captured = text.slice(i);
              for (const cb of cbs) cb(captured);
              i = text.length;
            } else {
              const captured = text.slice(i, closeIdx);
              if (captured) for (const cb of cbs) cb(captured);
              i = closeIdx + '</think>'.length;
              state = SEEKING;
              buf = '';
            }
            continue;
          }

          if (state === IN_FENCE) {
            const closeFence = '`'.repeat(fenceBacktickCount);
            const closeIdx = text.indexOf(closeFence, i);
            if (closeIdx === -1) {
              result += text.slice(i);
              i = text.length;
            } else {
              result += text.slice(i, closeIdx);
              i = closeIdx + fenceBacktickCount;
              fenceBacktickCount = 0;
              state = SEEKING;
              buf = '';
            }
            continue;
          }

          // SEEKING state
          const ch = text[i];

          if (ch === '{' || ch === '[' || ch === '"') {
            if (buf) {
              for (const cb of cbs) cb(buf);
              buf = '';
            }
            state = FEEDING;
            result += text.slice(i);
            break;
          }

          // Check for <think> tag
          buf += ch;
          if (buf.endsWith('<think>')) {
            const beforeTag = buf.slice(0, -'<think>'.length);
            if (beforeTag) for (const cb of cbs) cb(beforeTag);
            state = IN_THINK;
            buf = '';
            i++;
            continue;
          }

          // Check for code fence (``` with optional label)
          if (ch === '`') {
            let btCount = 0;
            let j = i;
            while (j < text.length && text[j] === '`') { btCount++; j++; }
            if (btCount >= 3) {
              while (j < text.length && text[j] !== '\n') j++;
              if (j < text.length) j++;
              fenceBacktickCount = btCount;
              state = IN_FENCE;
              const beforeFence = buf.slice(0, -1);
              if (beforeFence) for (const cb of cbs) cb(beforeFence);
              buf = '';
              i = j;
              continue;
            }
          }

          i++;

          if (buf.length > 1024) {
            for (const cb of cbs) cb(buf);
            buf = '';
          }
        }

        if (result.length > 0) return result;
        return null;
      },
      reset() { state = SEEKING; buf = ''; fenceBacktickCount = 0; },
      isFeeding() { return state === FEEDING; },
    };
  }

  // --- Path Pattern Compiler ---
  // Segments: string = key, number = index, '*' = wildcard

  function compilePath(pattern: string): PathSegment[] {
    return pattern.replace(/\[(\*|\d+)\]/g, '.$1').split('.').filter(Boolean)
      .map(s => s === '*' ? '*' : /^\d+$/.test(s) ? +s : s);
  }

  /** Extract top-level keys from a Zod-like schema and return as compiled pick paths.
   *  Supports Zod (.shape), Valibot (.entries), ArkType (.props).
   *  Recursively extracts nested object keys for nested pick paths.
   *  Returns null if schema shape can't be detected (no auto-pick). */
  function extractSchemaKeys(schema: any, prefix: string[] = []): PathSegment[][] | null {
    const shape = schema?.shape ?? schema?._def?.shape?.() ?? schema?.entries ?? schema?.props;
    if (!shape || typeof shape !== 'object') return null;
    const paths: PathSegment[][] = [];
    for (const key of Object.keys(shape)) {
      const fullPath = [...prefix, key];
      // Check if this field's schema has nested shape (nested object)
      const fieldSchema = shape[key];
      const nested = extractSchemaKeys(fieldSchema, fullPath);
      if (nested && nested.length > 0) {
        paths.push(...nested);
      } else {
        paths.push(fullPath.map(s => /^\d+$/.test(s) ? +s : s));
      }
    }
    return paths.length > 0 ? paths : null;
  }

  function buildResolvedPath(keyStack: (string | null)[], indexStack: (number | null)[], depth: number): string {
    const parts: string[] = [];
    for (let i = 0; i < depth; i++) {
      if (keyStack[i] !== null) parts.push(keyStack[i]!);
      else if (indexStack[i] !== null) parts.push(String(indexStack[i]));
    }
    return parts.join('.');
  }

  // --- Public API ---
  _instance = {
    parse(input: string | Uint8Array): ParseResult {
      // Write input into reusable WASM buffer with extra headroom for autocomplete
      const { ptr, len } = writeToWasm(input, inputBuf, 64, 4096);
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
        let _toJSONCache: unknown = UNCACHED;
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
                const closeSrcPos = engine.doc_get_src_pos(handle.docId, closeIdx) >>> 0;
                return closeSrcPos < autocompleteBoundary;
              }
              return true;
            } catch {
              return true; // fail-safe: freed doc → treat as complete
            }
          },
          toJSON(): unknown {
            if (_toJSONCache !== UNCACHED) return _toJSONCache;
            return (_toJSONCache = toJSONStr !== undefined ? JSON.parse(toJSONStr) : value);
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

      // Track whether input is an ASCII JS string (byteLen === str.length).
      // If so, docReadString can slice the original string directly.
      const isAsciiStr = typeof input === "string" && len === input.length;

      // ── Happy path: try doc_parse directly (no classify overhead) ──
      let docId = tryDocParse(ptr, len);
      if (docId >= 0) {
        if (isAsciiStr) docInputs.set(docId, input as string);
        // For string input at full length, reuse the original string (avoids decode)
        const toJSONStr = typeof input === "string" ? input
          : utf8Decoder.decode(new Uint8Array(engine.memory.buffer, ptr, len));
        return makeResult("complete", buildDocRoot(docId), Infinity, toJSONStr);
      }

      // ── doc_parse failed — classify to determine why ──
      const classification = engine.classify_input(ptr, len);

      if (classification === CLASSIFY_ERR) {
        return invalidResult("Invalid JSON structure");
      }

      if (classification === CLASSIFY_END_EARLY) {
        const parseLen = engine.get_value_end();
        const remainLen = len - parseLen;
        const remainingCopy = new Uint8Array(remainLen);
        remainingCopy.set(new Uint8Array(engine.memory.buffer, ptr + parseLen, remainLen));
        new Uint8Array(engine.memory.buffer, ptr + parseLen, 64).fill(0x20);

        const toJSONStr = utf8Decoder.decode(new Uint8Array(engine.memory.buffer, ptr, parseLen));
        docId = tryDocParse(ptr, parseLen);
        if (docId >= 0) {
          if (isAsciiStr) docInputs.set(docId, input as string);
          return makeResult("complete_early", buildDocRoot(docId), Infinity, toJSONStr, remainingCopy);
        }
        return invalidResult();
      }

      if (classification === CLASSIFY_INCOMPLETE) {
        const parseLen = engine.autocomplete_input(ptr, len, inputBuf.cap);
        if (parseLen === 0) {
          if (len === 0) return makeResult("incomplete", undefined, len, undefined);
          return invalidResult("Invalid JSON structure");
        }
        const toJSONStr = utf8Decoder.decode(new Uint8Array(engine.memory.buffer, ptr, parseLen));
        docId = tryDocParse(ptr, parseLen);
        if (docId >= 0) {
          // Don't use ASCII fast-path for incomplete: autocomplete appended
          // closing tokens that aren't in the original JS string.
          return makeResult("incomplete", buildDocRoot(docId, true), len, toJSONStr);
        }
        return invalidResult();
      }

      return invalidResult();
    },

    deepCompare(a: unknown, b: unknown, options?: { ignoreKeyOrder?: boolean }): boolean {
      const ordered = (options?.ignoreKeyOrder === false) ? 1 : 0;

      // Fast path: both are VJ proxies → WASM tape comparison.
      // Single [LAZY_PROXY] access per arg (1 Proxy get trap) instead of
      // isLazyProxy + [LAZY_PROXY] (has trap + get trap + object allocation × 2).
      if (a !== null && typeof a === "object" && b !== null && typeof b === "object") {
        try {
          const metaA = (a as any)[LAZY_PROXY] as { docId: number; index: number } | undefined;
          const metaB = (b as any)[LAZY_PROXY] as { docId: number; index: number } | undefined;
          if (metaA && metaB) {
            const result = engine.doc_deep_equal(metaA.docId, metaA.index, metaB.docId, metaB.index, ordered);
            if (result >= 0) return result === 1;
            // fallthrough on error (-1 = invalid doc_id)
          }
        } catch { /* not a proxy, fall through */ }
      }

      // Fallback: materialize and compare with JSON round-trip
      return JSON.stringify(a) === JSON.stringify(b);
    },

    materialize(value: unknown): unknown {
      if (!isLazyProxy(value)) return value;
      const { docId, index } = (value as any)[LAZY_PROXY];
      return deepMaterializeDoc(docId, index);
    },

    parsePartialJson(input: string, schema?: { safeParse: (v: unknown) => { success: boolean; data?: unknown } }): PartialJsonResult {
      if (!input) return { value: undefined, state: "failed-parse" as const };
      const result = _instance!.parse(input);
      switch (result.status) {
        case "complete":
        case "complete_early": {
          const value = result.toJSON();
          if (schema) {
            const validated = schema.safeParse(value);
            if (validated.success) return { value: validated.data, state: "successful-parse" as const };
            return { value: undefined, state: "successful-parse" as const };
          }
          return { value, state: "successful-parse" as const };
        }
        case "incomplete": {
          const value = result.toJSON();
          if (schema) {
            const validated = schema.safeParse(value);
            if (validated.success) return { value: validated.data, state: "repaired-parse" as const };
            // Partial JSON: safeParse fails (missing fields expected) → keep raw value
            return { value, state: "repaired-parse" as const };
          }
          return { value, state: "repaired-parse" as const };
        }
        default:
          return { value: undefined, state: "failed-parse" as const };
      }
    },

    createEventParser(options?: {
      multiRoot?: boolean;
      onRoot?: (event: RootEvent) => void;
      source?: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>;
    }): EventParser {
      const multiRoot = options?.multiRoot ?? false;
      const onRootCb = options?.onRoot;
      const source = options?.source;

      const streamId = engine.stream_create();
      if (streamId < 0) {
        throw new Error("VectorJSON: Failed to create event parser (max 4 concurrent)");
      }

      let destroyed = false;
      let rootIndex = 0;

      // --- Subscription storage ---
      type Sub = { segments: PathSegment[]; callback: Function; schema?: { safeParse: Function } };
      const pathSubs: Sub[] = [];
      const deltaSubs: Sub[] = [];
      const skipPatterns: PathSegment[][] = [];
      const textCallbacks: ((text: string) => void)[] = [];

      // --- JSON Seeker (reusable factory) ---
      const seeker = createSeeker(textCallbacks);

      // --- PathTracker state ---
      let ptDepth = 0;
      let ptInString = false;
      let ptEscapeNext = false;
      let ptContextStack: ('o' | 'a')[] = [];       // object or array at each level
      let ptKeyStack: (string | null)[] = [];        // current key at each depth
      let ptIndexStack: (number | null)[] = [];      // current array index at each depth
      let ptValueStartStack: number[] = [];          // byte offset where value started
      let ptSkipDepth = -1;                          // if >= 0, we're inside a skipped path
      let ptExpectingKey = false;
      let ptAfterColon = false;
      let ptKeyAccum = '';
      let ptAccumulatingKey = false;
      let ptStringValueStart = -1;
      let ptInStringValue = false;
      let ptDeltaAccum = '';
      let ptDeltaByteStart = 0;                      // byte offset where current delta accumulation started
      let ptInScalar = false;                        // tracking a scalar that may span chunks
      let ptScalarStart = -1;                        // byte offset where current scalar started

      // --- Live document builder ---
      // Incrementally builds a JS object/array as bytes are scanned.
      // getValue() returns this growing object. O(n) total materialization.
      let ldRoot: unknown = undefined;               // the growing root value
      let ldStack: (Record<string, unknown> | unknown[])[] = [];  // container stack
      let ldCurrentKey: string | null = null;        // pending key for object assignment
      let ldActiveKey: string | null = null;         // key used for current string being updated
      let ldStringAccum = '';                        // accumulating string value
      let ldInStringValue = false;                   // currently inside a string value
      let ldScalarAccum = '';                        // accumulating scalar chars

      function ldSetValue(value: unknown) {
        if (ldStack.length === 0) {
          ldRoot = value;
          return;
        }
        const parent = ldStack[ldStack.length - 1];
        if (Array.isArray(parent)) {
          parent.push(value);
        } else if (ldCurrentKey !== null) {
          parent[ldCurrentKey] = value;
          ldActiveKey = ldCurrentKey;  // remember key for in-place updates
          ldCurrentKey = null;
        }
      }

      // Update a string/scalar value in-place (for partial strings being built)
      function ldUpdateString(str: string) {
        if (ldStack.length === 0) {
          ldRoot = str;
          return;
        }
        const parent = ldStack[ldStack.length - 1];
        if (Array.isArray(parent)) {
          if (parent.length > 0) parent[parent.length - 1] = str;
          else parent.push(str);
        } else if (ldActiveKey !== null) {
          parent[ldActiveKey] = str;
        }
      }

      function ldReset() {
        ldRoot = undefined;
        ldStack.length = 0;
        ldCurrentKey = null;
        ldActiveKey = null;
        ldStringAccum = '';
        ldInStringValue = false;
        ldScalarAccum = '';
      }

      function ptReset() {
        ptDepth = 0; ptInString = false; ptEscapeNext = false;
        ptContextStack.length = 0; ptKeyStack.length = 0;
        ptIndexStack.length = 0; ptValueStartStack.length = 0;
        ptSkipDepth = -1; ptExpectingKey = false; ptAfterColon = false;
        ptKeyAccum = ''; ptAccumulatingKey = false;
        ptStringValueStart = -1; ptInStringValue = false;
        ptDeltaAccum = ''; ptDeltaByteStart = 0;
        ptInScalar = false; ptScalarStart = -1;
        ldReset();
      }

      /** Unified path matcher: exact = segments.length must equal depth, prefix = <= depth.
       *  Returns wildcard matches on success, null on failure. */
      function matchPath(segments: PathSegment[], exact: boolean): (string | number)[] | null {
        const len = segments.length;
        if (exact ? len !== ptDepth : len > ptDepth) return null;
        const matches: (string | number)[] = [];
        for (let s = 0; s < len; s++) {
          const seg = segments[s];
          const key = ptKeyStack[s], idx = ptIndexStack[s];
          if (seg === '*') matches.push(idx !== null ? idx : (key ?? ''));
          else if (typeof seg === 'number' ? idx !== seg : key !== seg) return null;
        }
        return matches;
      }

      function isPathSkipped(): boolean {
        return skipPatterns.length > 0 && skipPatterns.some(p => matchPath(p, false) !== null);
      }

      function fireValueComplete(valueBytes: Uint8Array, offset: number, length: number) {
        if (pathSubs.length === 0) return;
        const resolvedPath = buildResolvedPath(ptKeyStack, ptIndexStack, ptDepth);
        for (const sub of pathSubs) {
          const matches = matchPath(sub.segments, true);
          if (!matches) continue;
          let value: unknown;
          try { value = JSON.parse(utf8Decoder.decode(valueBytes)); } catch { continue; }
          if (sub.schema) {
            const result = sub.schema.safeParse(value);
            if (!result.success) continue;
            value = result.data;
          }
          const event: PathEvent = { type: 'value', path: resolvedPath, value, offset, length, matches };
          for (let i = matches.length - 1; i >= 0; i--) {
            const m = matches[i];
            if (typeof m === 'number' && event.index === undefined) event.index = m;
            if (typeof m === 'string' && event.key === undefined) event.key = m;
          }
          sub.callback(event as any);
        }
      }

      function fireDelta(value: string, offset: number, length: number) {
        if (deltaSubs.length === 0) return;
        const resolvedPath = buildResolvedPath(ptKeyStack, ptIndexStack, ptDepth);
        for (const sub of deltaSubs) {
          if (!matchPath(sub.segments, true)) continue;
          sub.callback({ type: 'delta', path: resolvedPath, value, offset, length });
        }
      }

      function ptScan(buf: Uint8Array, from: number, to: number) {
        for (let i = from; i < to; i++) {
          const c = buf[i];

          // Check if we're continuing a scalar from a previous chunk
          if (ptInScalar) {
            if (c === 0x2C || c === 0x7D || c === 0x5D || c === 0x20 || c === 0x0A || c === 0x0D || c === 0x09) {
              // Scalar ended — fire value complete for the whole span
              const scalarLen = i - ptScalarStart;
              fireValueComplete(buf.slice(ptScalarStart, i), ptScalarStart, scalarLen);
              // Live doc: finalize scalar
              try { ldSetValue(JSON.parse(ldScalarAccum)); } catch { ldSetValue(null); }
              ldScalarAccum = '';
              ptInScalar = false;
              ptScalarStart = -1;
              // Re-process this delimiter char (it may be comma/close bracket)
              i--;
              continue;
            }
            // Still inside the scalar, keep scanning
            ldScalarAccum += B2C[c];
            continue;
          }

          if (ptEscapeNext) {
            ptEscapeNext = false;
            if (ptInStringValue && ptSkipDepth < 0) {
              // Decode escape for delta
              let decoded: string;
              switch (c) {
                case 0x6E: decoded = '\n'; break;   // n
                case 0x72: decoded = '\r'; break;   // r
                case 0x74: decoded = '\t'; break;   // t
                case 0x22: decoded = '"'; break;     // "
                case 0x5C: decoded = '\\'; break;    // \
                case 0x2F: decoded = '/'; break;     // /
                case 0x62: decoded = '\b'; break;    // b
                case 0x66: decoded = '\f'; break;    // f
                default: decoded = B2C[c]; break;
              }
              ptDeltaAccum += decoded;
              // Live doc: accumulate decoded escape char (batched — flushed at string close or chunk end)
              if (ldInStringValue) {
                ldStringAccum += decoded;
              }
              if (ptAccumulatingKey) ptKeyAccum += decoded;
            } else if (ptAccumulatingKey) {
              ptKeyAccum += B2C[c];
            }
            continue;
          }

          if (ptInString) {
            if (c === 0x5C) { // backslash
              ptEscapeNext = true;
              continue;
            }
            if (c === 0x22) { // closing quote
              ptInString = false;
              if (ptAccumulatingKey) {
                ptAccumulatingKey = false;
                // Store key at parent depth (ptDepth-1) since we're inside the container
                if (ptDepth > 0) ptKeyStack[ptDepth - 1] = ptKeyAccum;
                // Live doc: store key for next value assignment
                ldCurrentKey = ptKeyAccum;
                ptKeyAccum = '';
                continue;
              }
              // End of string value
              if (ptInStringValue && ptSkipDepth < 0) {
                // Flush final delta — use tracked byte offsets, not decoded char count
                if (ptDeltaAccum && deltaSubs.length > 0) {
                  const deltaByteLen = i - ptDeltaByteStart; // raw bytes from start to closing quote
                  fireDelta(ptDeltaAccum, ptDeltaByteStart, deltaByteLen);
                }
                ptDeltaAccum = '';
                // Fire value complete for the string
                const start = ptStringValueStart;
                const len = i + 1 - start;
                fireValueComplete(buf.slice(start, i + 1), start, len);
                // Live doc: final update (value already in parent from ldSetValue('') at open)
                ldUpdateString(ldStringAccum);
                ldStringAccum = '';
                ldInStringValue = false;
              }
              ptInStringValue = false;
              ptStringValueStart = -1;
              continue;
            }
            // Regular string character
            if (ptInStringValue && ptSkipDepth < 0) {
              const ch = B2C[c];
              ptDeltaAccum += ch;
              // Live doc: accumulate string char (batched — flushed at string close or chunk end)
              if (ldInStringValue) ldStringAccum += ch;
              if (ptAccumulatingKey) ptKeyAccum += ch;
            } else if (ptAccumulatingKey) {
              ptKeyAccum += B2C[c];
            }
            continue;
          }

          // Not in string
          switch (c) {
            case 0x7B: { // {
              ptContextStack[ptDepth] = 'o';
              ptKeyStack[ptDepth] = null;
              ptIndexStack[ptDepth] = null;
              ptValueStartStack[ptDepth] = i;
              ptDepth++;
              ptExpectingKey = true;
              ptAfterColon = false;
              // Check if we should skip this depth
              if (ptSkipDepth < 0 && isPathSkipped()) {
                ptSkipDepth = ptDepth - 1;
              }
              // Live doc: create object and push to stack
              const obj: Record<string, unknown> = {};
              ldSetValue(obj);
              ldStack.push(obj);
              break;
            }
            case 0x5B: { // [
              ptContextStack[ptDepth] = 'a';
              ptKeyStack[ptDepth] = null;
              ptIndexStack[ptDepth] = 0;
              ptValueStartStack[ptDepth] = i;
              ptDepth++;
              ptExpectingKey = false;
              ptAfterColon = false;
              if (ptSkipDepth < 0 && isPathSkipped()) {
                ptSkipDepth = ptDepth - 1;
              }
              // Live doc: create array and push to stack
              const arr: unknown[] = [];
              ldSetValue(arr);
              ldStack.push(arr);
              break;
            }
            case 0x7D: // }
            case 0x5D: { // ]
              ptDepth--;
              const wasSkipped = ptSkipDepth >= 0;
              if (wasSkipped && ptDepth <= ptSkipDepth) {
                ptSkipDepth = -1;
              }
              // Fire value complete for the container (only if not exiting a skipped path)
              if (ptDepth >= 0 && ptSkipDepth < 0 && !wasSkipped) {
                const start = ptValueStartStack[ptDepth];
                const len = i + 1 - start;
                fireValueComplete(buf.slice(start, i + 1), start, len);
              }
              // Restore parent context
              if (ptDepth > 0) {
                const parentCtx = ptContextStack[ptDepth - 1];
                ptExpectingKey = parentCtx === 'o';
                ptAfterColon = false;
              }
              // Live doc: pop container from stack
              ldStack.pop();
              break;
            }
            case 0x22: { // opening quote
              ptInString = true;
              if (ptExpectingKey && ptSkipDepth < 0) {
                // Start accumulating key
                ptAccumulatingKey = true;
                ptKeyAccum = '';
              } else if (ptAfterColon || ptDepth === 0 || (ptDepth > 0 && ptContextStack[ptDepth - 1] === 'a')) {
                // String value — only track if not in a skipped path
                if (ptSkipDepth < 0 && !isPathSkipped()) {
                  ptInStringValue = true;
                  ptStringValueStart = i;
                  ptDeltaAccum = '';
                  ptDeltaByteStart = i + 1; // byte after opening quote
                  // Live doc: start string value accumulation
                  ldStringAccum = '';
                  ldInStringValue = true;
                  // Push an empty string as placeholder so updates work
                  ldSetValue('');
                }
                ptAfterColon = false;
              }
              break;
            }
            case 0x3A: { // colon
              ptExpectingKey = false;
              ptAfterColon = true;
              // Live doc: set null placeholder for pending key
              if (ldCurrentKey !== null && ldStack.length > 0) {
                const parent = ldStack[ldStack.length - 1];
                if (!Array.isArray(parent)) {
                  (parent as Record<string, unknown>)[ldCurrentKey] = null;
                  ldActiveKey = ldCurrentKey;
                }
              }
              break;
            }
            case 0x2C: { // comma
              // In array: increment index
              if (ptDepth > 0 && ptContextStack[ptDepth - 1] === 'a') {
                const idx = ptIndexStack[ptDepth - 1];
                ptIndexStack[ptDepth - 1] = (idx ?? -1) + 1;
                // Check skip for new array index
                if (ptSkipDepth < 0 && isPathSkipped()) {
                  ptSkipDepth = ptDepth - 1;
                }
              }
              // In object: expect next key
              if (ptDepth > 0 && ptContextStack[ptDepth - 1] === 'o') {
                ptExpectingKey = true;
                ptKeyStack[ptDepth - 1] = null;
              }
              ptAfterColon = false;
              break;
            }
            default: {
              // Scalar values (numbers, true, false, null)
              if (ptAfterColon || ptDepth === 0 || (ptDepth > 0 && ptContextStack[ptDepth - 1] === 'a')) {
                if (c >= 0x30 && c <= 0x39 || c === 0x2D || c === 0x74 || c === 0x66 || c === 0x6E) {
                  // Find end of scalar
                  if (ptSkipDepth < 0 && !isPathSkipped()) {
                    let j = i + 1;
                    while (j < to) {
                      const sc = buf[j];
                      if (sc === 0x2C || sc === 0x7D || sc === 0x5D || sc === 0x20 || sc === 0x0A || sc === 0x0D || sc === 0x09) break;
                      j++;
                    }
                    if (j < to) {
                      // Complete scalar within this chunk
                      fireValueComplete(buf.slice(i, j), i, j - i);
                      // Live doc: parse and set scalar value
                      const scalarStr = utf8Decoder.decode(buf.slice(i, j));
                      try { ldSetValue(JSON.parse(scalarStr)); } catch { ldSetValue(null); }
                      i = j - 1; // -1 because loop will increment
                    } else {
                      // Scalar extends past this chunk — track it
                      ptInScalar = true;
                      ptScalarStart = i;
                      ldScalarAccum = utf8Decoder.decode(buf.slice(i, to));
                      i = to; // skip to end, will resume on next feed
                    }
                  }
                  ptAfterColon = false;
                }
              }
              break;
            }
          }
        }

        // Flush accumulated string to live doc parent (batched update)
        if (ldInStringValue && ldStringAccum) {
          ldUpdateString(ldStringAccum);
        }

        // Flush accumulated deltas at end of each feed for in-progress strings
        // This ensures onDelta fires incrementally per feed(), not just at string close
        if (ptInStringValue && ptDeltaAccum.length > 0 && ptSkipDepth < 0 && deltaSubs.length > 0) {
          fireDelta(ptDeltaAccum, ptDeltaByteStart, to - ptDeltaByteStart);
          ptDeltaAccum = '';
          ptDeltaByteStart = to;
        }
      }

      // --- EventParser object ---
      const self: EventParser = {
        on(path: string, ...args: any[]): EventParser {
          let schema: { safeParse: Function } | undefined;
          let callback: (event: PathEvent) => void;
          if (args.length === 2 && typeof args[0] === 'object' && args[0] !== null && 'safeParse' in args[0]) {
            schema = args[0];
            callback = args[1];
          } else {
            callback = args[0];
          }
          pathSubs.push({ segments: compilePath(path), callback, schema });
          return self;
        },

        onDelta(path: string, callback: (event: DeltaEvent) => void): EventParser {
          deltaSubs.push({ segments: compilePath(path), callback });
          return self;
        },

        onText(callback: (text: string) => void): EventParser {
          textCallbacks.push(callback);
          return self;
        },

        skip(...paths: string[]): EventParser {
          for (const p of paths) skipPatterns.push(compilePath(p));
          return self;
        },

        off(path: string, callback?: Function): EventParser {
          const compiled = compilePath(path);
          const eq = (a: PathSegment[], b: PathSegment[]) =>
            a.length === b.length && a.every((s, i) => s === b[i]);
          const remove = (subs: Sub[]) => {
            for (let i = subs.length - 1; i >= 0; i--) {
              if (eq(subs[i].segments, compiled) && (!callback || subs[i].callback === callback))
                subs.splice(i, 1);
            }
          };
          remove(pathSubs);
          remove(deltaSubs);
          return self;
        },

        feed(chunk: string | Uint8Array): FeedStatus {
          if (destroyed) throw new Error("EventParser already destroyed");

          // Run through JSON seeker first
          let jsonContent: string | Uint8Array | null;
          if (typeof chunk === 'string') {
            jsonContent = seeker.feed(chunk);
            if (jsonContent === null) return FEED_STATUS[engine.stream_get_status(streamId)]!;
          } else if (seeker.isFeeding()) {
            // Fast path: skip string conversion when seeker is already feeding JSON
            jsonContent = chunk;
          } else {
            const str = utf8Decoder.decode(chunk);
            const result = seeker.feed(str);
            if (result === null) return FEED_STATUS[engine.stream_get_status(streamId)]!;
            jsonContent = encoder.encode(result);
          }

          // Feed to WASM stream
          const { ptr, len } = writeToWasm(jsonContent, feedBuf, 0, 4096);
          const prevLen = engine.stream_get_buffer_len(streamId);
          const status = engine.stream_feed(streamId, ptr, len);
          const newLen = engine.stream_get_buffer_len(streamId);

          // Scan new bytes with PathTracker (always runs — needed for live document builder)
          if (newLen > prevLen) {
            const bufPtr = (engine.stream_get_buffer_ptr(streamId) >>> 0);
            // For end_early/complete: only scan up to the value boundary
            const scanEnd = (status === 1 || status === 3)
              ? Math.min(newLen, engine.stream_get_value_len(streamId))
              : newLen;
            if (scanEnd > prevLen) {
              const wasmBuf = new Uint8Array(engine.memory.buffer, bufPtr, scanEnd);
              ptScan(wasmBuf, prevLen, scanEnd);
            }
            // Finalize pending scalar on complete/end_early
            if ((status === 1 || status === 3) && ptInScalar && ldScalarAccum) {
              try { ldSetValue(JSON.parse(ldScalarAccum)); } catch { ldSetValue(null); }
              ldScalarAccum = '';
              ptInScalar = false;
              ptScalarStart = -1;
            }
          }

          const feedStatus = FEED_STATUS[status] || "error";

          // Multi-root handling: drain all complete values
          if (multiRoot && (feedStatus === 'complete' || feedStatus === 'end_early')) {
            let loopGuard = 0;
            while (loopGuard++ < 10000) {
              const curStatus = engine.stream_get_status(streamId);
              if (curStatus !== 1 && curStatus !== 3) break; // not complete/end_early

              // Copy value bytes before reset (SIMD padding would overwrite remaining)
              const bp = (engine.stream_get_buffer_ptr(streamId) >>> 0);
              const vl = engine.stream_get_value_len(streamId);
              const valueCopy = new Uint8Array(vl + 64);
              valueCopy.set(new Uint8Array(engine.memory.buffer, bp, vl));
              // Pad copy for SIMD safety
              valueCopy.fill(0x20, vl);

              // Reset stream for next value BEFORE parsing (preserves remaining bytes)
              const remaining = engine.stream_reset_for_next(streamId);
              ptReset();

              // Now parse the copied value bytes
              const parsePtr = engine.alloc(valueCopy.length) >>> 0;
              if (parsePtr) {
                new Uint8Array(engine.memory.buffer, parsePtr, valueCopy.length).set(valueCopy);
                const did = engine.doc_parse(parsePtr, vl);
                engine.dealloc(parsePtr, valueCopy.length);
                if (did >= 0 && onRootCb) {
                  onRootCb({ type: 'root', index: rootIndex++, value: buildDocRoot(did) });
                }
              }

              // Scan remaining bytes with PathTracker
              if (remaining > 0 && (pathSubs.length > 0 || deltaSubs.length > 0)) {
                const nbp = (engine.stream_get_buffer_ptr(streamId) >>> 0);
                const nbl = engine.stream_get_buffer_len(streamId);
                if (nbl > 0) {
                  const wb = new Uint8Array(engine.memory.buffer, nbp, nbl);
                  ptScan(wb, 0, nbl);
                }
              }

              if (remaining === 0) break;
            }
            return FEED_STATUS[engine.stream_get_status(streamId)] || "incomplete";
          }

          return feedStatus;
        },

        getValue(): unknown | undefined {
          if (destroyed) throw new Error("EventParser already destroyed");
          const status = engine.stream_get_status(streamId);
          if (status === 2) throw new SyntaxError("VectorJSON: Parse error in stream");

          if (status === 0) {
            // incomplete — return the incrementally-built live document
            let value: unknown = ldRoot;

            // Handle pending values not yet committed to ldRoot
            if (ptInScalar && ldScalarAccum) {
              const partial = ldScalarAccum;
              const completed = partial.startsWith('t') ? 'true'
                : partial.startsWith('f') ? 'false'
                : partial.startsWith('n') ? 'null'
                : partial;
              try {
                const parsed = JSON.parse(completed);
                if (ldStack.length === 0) value = parsed;
              } catch { /* leave as-is */ }
            } else if (ldInStringValue && ldStack.length === 0) {
              value = ldStringAccum;
            }

            if (value === undefined) return undefined;
            return value;
          }

          // complete or end_early — do a final WASM parse for correctness
          const bufPtr = (engine.stream_get_buffer_ptr(streamId) >>> 0);
          const valueLen = engine.stream_get_value_len(streamId);
          new Uint8Array(engine.memory.buffer, bufPtr + valueLen, 64).fill(0x20);
          const docId = engine.doc_parse(bufPtr, valueLen);
          if (docId < 0) {
            const errorCode = engine.get_error_code();
            const msg = ERROR_MESSAGES[errorCode] || `Parse error (code ${errorCode})`;
            throw new SyntaxError(`VectorJSON: ${msg}`);
          }
          return buildDocRoot(docId);
        },

        getRemaining(): Uint8Array | null {
          if (destroyed) return null;
          const rPtr = (engine.stream_get_remaining_ptr(streamId) >>> 0);
          const rLen = engine.stream_get_remaining_len(streamId);
          if (rLen > 0) {
            const copy = new Uint8Array(rLen);
            copy.set(new Uint8Array(engine.memory.buffer, rPtr, rLen));
            return copy;
          }
          return null;
        },

        getStatus(): FeedStatus {
          if (destroyed) return "error";
          return FEED_STATUS[engine.stream_get_status(streamId)] || "error";
        },

        getRawBuffer(): ArrayBuffer | null {
          if (destroyed) return null;
          const bufPtr = engine.stream_get_buffer_ptr(streamId) >>> 0;
          const bufLen = engine.stream_get_buffer_len(streamId);
          if (bufLen === 0) return null;
          const copy = new ArrayBuffer(bufLen);
          new Uint8Array(copy).set(new Uint8Array(engine.memory.buffer, bufPtr, bufLen));
          return copy;
        },

        destroy(): void {
          if (!destroyed) {
            engine.stream_destroy(streamId);
            destroyed = true;
          }
        },

        [Symbol.asyncIterator](): AsyncIterableIterator<unknown | undefined> {
          if (!source) throw new Error("No source provided — use feed() for push-based parsing");
          const ep = this;
          const reader = isReadableStream(source) ? source.getReader() : null;
          const iter = reader ? null : (source as AsyncIterable<any>)[Symbol.asyncIterator]();
          let finished = false;

          return {
            async next() {
              if (finished) {
                ep.destroy();
                return { done: true as const, value: undefined };
              }

              const result = reader
                ? await reader.read()
                : await iter!.next();

              if (result.done || !result.value) {
                finished = true;
                ep.destroy();
                return { done: true as const, value: undefined };
              }

              const status = ep.feed(result.value);
              const partial = ep.getValue();

              if (status === "complete" || status === "end_early") {
                finished = true;
                return { done: false, value: partial };
              }
              if (status === "error") {
                finished = true;
                ep.destroy();
                throw new SyntaxError("VectorJSON: Parse error in stream");
              }

              return { done: false, value: partial };
            },
            async return() {
              finished = true;
              ep.destroy();
              if (reader) reader.cancel();
              return { done: true as const, value: undefined };
            },
            [Symbol.asyncIterator]() { return this; },
          };
        },
      };

      return self;
    },

    createParser(arg?: any): StreamingParser {
      // --- Argument parsing: detect legacy schema vs options object ---
      let schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } } | undefined;
      let pickPaths: PathSegment[][] | null = null;
      let source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string> | undefined;

      if (arg && typeof arg === 'object' && 'safeParse' in arg && !('pick' in arg) && !('source' in arg) && !('schema' in arg)) {
        // Legacy: createParser(zodSchema)
        schema = arg;
        // Auto-derive pick paths from schema shape (Zod, Valibot, ArkType)
        pickPaths = extractSchemaKeys(arg);
      } else if (arg && typeof arg === 'object' && ('pick' in arg || 'source' in arg || 'schema' in arg)) {
        // New: createParser({ pick, schema, source })
        schema = arg.schema;
        source = arg.source;
        if (arg.pick) {
          pickPaths = arg.pick.map(compilePath);
        } else if (arg.schema) {
          // Auto-derive pick paths from schema when no explicit pick
          pickPaths = extractSchemaKeys(arg.schema);
        }
      }
      // Seeker: skip junk text when schema is provided (dirty input handling)
      const cpSeeker = schema ? createSeeker() : null;

      const streamId = engine.stream_create();
      if (streamId < 0) {
        throw new Error("VectorJSON: Failed to create streaming parser (max 4 concurrent)");
      }

      let destroyed = false;
      let cachedValue: unknown = UNCACHED;
      let cachedRemaining: Uint8Array | null | undefined; // undefined = not yet cached

      // --- Live document builder state (same approach as EventParser) ---
      let ldRoot: unknown = undefined;
      let ldStack: (Record<string, unknown> | unknown[])[] = [];
      let ldCurrentKey: string | null = null;
      let ldActiveKey: string | null = null;
      let ldStringAccum = '';
      let ldInStringValue = false;
      let ldScalarAccum = '';

      // Byte scanner state
      let scanInString = false;
      let scanEscapeNext = false;
      let scanDepth = 0;
      let scanContext: ('o' | 'a')[] = [];
      let scanExpectingKey = false;
      let scanAfterColon = false;
      let scanKeyAccum = '';
      let scanAccumulatingKey = false;
      let scanInScalar = false;

      // --- Pick state ---
      // spKeyStack tracks the current key at each depth for pick matching.
      // spSkipDepth >= 0 means we're inside a non-picked field and should skip building.
      let spKeyStack: (string | null)[] = [];
      let spSkipDepth = -1;

      /** Check if the current path (from spKeyStack + scanDepth) matches any pick path.
       *  Returns true if current path is an ancestor, descendant, or exact match.
       *  Array levels (null entries in spKeyStack) are transparent — skipped during comparison. */
      function isFieldPicked(): boolean {
        if (!pickPaths) return true;
        // Build effective key path (skip null = array levels)
        const effective: string[] = [];
        for (let i = 0; i < scanDepth; i++) {
          if (spKeyStack[i] !== null) effective.push(spKeyStack[i]!);
        }
        for (const pick of pickPaths) {
          const pickLen = pick.length;
          const effLen = effective.length;
          const compareLen = Math.min(effLen, pickLen);
          let matched = true;
          for (let i = 0; i < compareLen; i++) {
            const seg = pick[i];
            if (seg === '*') continue; // wildcard matches anything
            if (typeof seg === 'number') continue; // index matching — arrays are transparent
            if (effective[i] !== seg) { matched = false; break; }
          }
          if (matched) return true; // ancestor, descendant, or exact match
        }
        return false;
      }

      function spSetValue(value: unknown) {
        if (ldStack.length === 0) { ldRoot = value; return; }
        const parent = ldStack[ldStack.length - 1];
        if (Array.isArray(parent)) { parent.push(value); }
        else if (ldCurrentKey !== null) { parent[ldCurrentKey] = value; ldActiveKey = ldCurrentKey; ldCurrentKey = null; }
      }

      function spUpdateString(str: string) {
        if (ldStack.length === 0) { ldRoot = str; return; }
        const parent = ldStack[ldStack.length - 1];
        if (Array.isArray(parent)) {
          if (parent.length > 0) parent[parent.length - 1] = str;
          else parent.push(str);
        } else if (ldActiveKey !== null) { parent[ldActiveKey] = str; }
      }

      /** Scan new bytes to incrementally build the live JS document.
       *  When pickPaths is set, fields not matching any pick path are skipped. */
      function spScan(buf: Uint8Array, from: number, to: number) {
        const picking = pickPaths !== null;
        for (let i = from; i < to; i++) {
          const c = buf[i];

          if (scanInScalar) {
            if (c === 0x2C || c === 0x7D || c === 0x5D || c === 0x20 || c === 0x0A || c === 0x0D || c === 0x09) {
              if (spSkipDepth < 0) {
                try { spSetValue(JSON.parse(ldScalarAccum)); } catch { spSetValue(null); }
              }
              ldScalarAccum = '';
              scanInScalar = false;
              i--; continue;
            }
            if (spSkipDepth < 0) ldScalarAccum += B2C[c];
            continue;
          }

          if (scanEscapeNext) {
            scanEscapeNext = false;
            if (ldInStringValue && spSkipDepth < 0) {
              let decoded: string;
              switch (c) {
                case 0x6E: decoded = '\n'; break;
                case 0x72: decoded = '\r'; break;
                case 0x74: decoded = '\t'; break;
                case 0x22: decoded = '"'; break;
                case 0x5C: decoded = '\\'; break;
                case 0x2F: decoded = '/'; break;
                case 0x62: decoded = '\b'; break;
                case 0x66: decoded = '\f'; break;
                default: decoded = B2C[c]; break;
              }
              ldStringAccum += decoded;
            }
            if (scanAccumulatingKey) scanKeyAccum += B2C[c];
            continue;
          }

          if (scanInString) {
            if (c === 0x5C) { scanEscapeNext = true; continue; }
            if (c === 0x22) {
              scanInString = false;
              if (scanAccumulatingKey) {
                scanAccumulatingKey = false;
                ldCurrentKey = scanKeyAccum;
                // Store key in spKeyStack for pick path matching
                if (picking && scanDepth > 0) {
                  spKeyStack[scanDepth - 1] = scanKeyAccum;
                }
                scanKeyAccum = '';
                continue;
              }
              if (ldInStringValue && spSkipDepth < 0) {
                spUpdateString(ldStringAccum);
                ldStringAccum = '';
                ldInStringValue = false;
              }
              continue;
            }
            if (ldInStringValue && spSkipDepth < 0) ldStringAccum += B2C[c];
            if (scanAccumulatingKey) scanKeyAccum += B2C[c];
            continue;
          }

          switch (c) {
            case 0x7B: {
              scanContext[scanDepth] = 'o';
              if (picking) spKeyStack[scanDepth] = null;
              scanDepth++;
              scanExpectingKey = true;
              scanAfterColon = false;
              if (spSkipDepth < 0) {
                const obj: Record<string, unknown> = {};
                spSetValue(obj);
                ldStack.push(obj);
              }
              break;
            }
            case 0x5B: {
              scanContext[scanDepth] = 'a';
              if (picking) spKeyStack[scanDepth] = null;
              scanDepth++;
              scanExpectingKey = false;
              scanAfterColon = false;
              if (spSkipDepth < 0) {
                const arr: unknown[] = [];
                spSetValue(arr);
                ldStack.push(arr);
              }
              break;
            }
            case 0x7D: case 0x5D: {
              scanDepth--;
              if (spSkipDepth >= 0) {
                if (scanDepth <= spSkipDepth) {
                  spSkipDepth = -1;
                  // Container was opened before skip started — pop it
                  ldStack.pop();
                }
                // else: still inside skipped region, container wasn't pushed
              } else {
                ldStack.pop();
              }
              if (scanDepth > 0) {
                scanExpectingKey = scanContext[scanDepth - 1] === 'o';
                scanAfterColon = false;
              }
              break;
            }
            case 0x22: {
              scanInString = true;
              const isValue = scanAfterColon || scanDepth === 0 || (scanDepth > 0 && scanContext[scanDepth - 1] === 'a');
              if (scanExpectingKey) {
                scanAccumulatingKey = true;
                scanKeyAccum = '';
              } else if (isValue && spSkipDepth < 0) {
                ldStringAccum = '';
                ldInStringValue = true;
                spSetValue('');
                scanAfterColon = false;
              }
              break;
            }
            case 0x3A: {
              scanExpectingKey = false;
              scanAfterColon = true;
              // Check pick filter after key is stored
              if (picking && spSkipDepth < 0 && !isFieldPicked()) {
                spSkipDepth = scanDepth - 1;
                ldCurrentKey = null; // discard key since field is skipped
                break;
              }
              // Pre-set null for the pending key — overwritten when the real
              // value arrives. Ensures getValue() shows {"key": null} while
              // the value is still being streamed.
              if (spSkipDepth < 0 && ldCurrentKey !== null && ldStack.length > 0) {
                const parent = ldStack[ldStack.length - 1];
                if (!Array.isArray(parent)) {
                  (parent as Record<string, unknown>)[ldCurrentKey] = null;
                  ldActiveKey = ldCurrentKey;
                }
              }
              break;
            }
            case 0x2C: {
              if (picking && spSkipDepth >= 0 && scanDepth - 1 <= spSkipDepth) {
                spSkipDepth = -1;
              }
              if (scanDepth > 0 && scanContext[scanDepth - 1] === 'o') {
                scanExpectingKey = true;
                if (picking) spKeyStack[scanDepth - 1] = null;
              }
              scanAfterColon = false;
              break;
            }
            default: {
              if (spSkipDepth >= 0) break; // skip scalars inside non-picked fields
              const isValuePos = scanAfterColon || scanDepth === 0 || (scanDepth > 0 && scanContext[scanDepth - 1] === 'a');
              if (isValuePos) {
                if (c >= 0x30 && c <= 0x39 || c === 0x2D || c === 0x74 || c === 0x66 || c === 0x6E) {
                  let j = i + 1;
                  while (j < to) {
                    const sc = buf[j];
                    if (sc === 0x2C || sc === 0x7D || sc === 0x5D || sc === 0x20 || sc === 0x0A || sc === 0x0D || sc === 0x09) break;
                    j++;
                  }
                  if (j < to) {
                    const scalarStr = utf8Decoder.decode(buf.slice(i, j));
                    try { spSetValue(JSON.parse(scalarStr)); } catch { spSetValue(null); }
                    i = j - 1;
                  } else {
                    scanInScalar = true;
                    ldScalarAccum = utf8Decoder.decode(buf.slice(i, to));
                    i = to;
                  }
                  scanAfterColon = false;
                }
              }
              break;
            }
          }
        }

        // End-of-chunk: flush accumulated string to parent (batched update)
        if (ldInStringValue && ldStringAccum && spSkipDepth < 0) {
          spUpdateString(ldStringAccum);
        }

        // End-of-chunk: if we're still accumulating a scalar and stream says complete,
        // finalize it now (root-level scalars like "42" end at end-of-buffer)
        if (scanInScalar) {
          const status = engine.stream_get_status(streamId);
          if (status === 1 || status === 3) { // complete or end_early
            // Autocomplete partial keywords (e.g., "tr" → "true")
            const s = ldScalarAccum;
            const completed = s.startsWith('t') ? 'true'
              : s.startsWith('f') ? 'false'
              : s.startsWith('n') ? 'null' : s;
            try { spSetValue(JSON.parse(completed)); } catch { spSetValue(null); }
            ldScalarAccum = '';
            scanInScalar = false;
          }
        }
      }

      const ensureRemaining = () => {
        if (cachedRemaining !== undefined) return;
        const rPtr = (engine.stream_get_remaining_ptr(streamId) >>> 0);
        const rLen = engine.stream_get_remaining_len(streamId);
        if (rLen > 0) {
          cachedRemaining = new Uint8Array(rLen);
          cachedRemaining.set(new Uint8Array(engine.memory.buffer, rPtr, rLen));
        } else {
          cachedRemaining = null;
        }
      };

      let prevLen = 0;

      return {
        feed(chunk: Uint8Array | string): FeedStatus {
          if (destroyed) throw new Error("Parser already destroyed");
          // Run through seeker to skip non-JSON junk (when schema is set)
          if (cpSeeker) {
            const text = typeof chunk === 'string' ? chunk : utf8Decoder.decode(chunk);
            const jsonContent = cpSeeker.feed(text);
            if (jsonContent === null) return FEED_STATUS[engine.stream_get_status(streamId)]!;
            chunk = jsonContent;
          }
          const chunkLen = typeof chunk === "string" ? chunk.length : chunk.byteLength;
          if (chunkLen === 0) return FEED_STATUS[engine.stream_get_status(streamId)]!;
          const { ptr, len } = writeToWasm(chunk, feedBuf, 0, 4096);
          const rawStatus = engine.stream_feed(streamId, ptr, len);
          // Scan new bytes for live document building
          const newLen = engine.stream_get_buffer_len(streamId);
          if (newLen > prevLen) {
            const bufPtr = (engine.stream_get_buffer_ptr(streamId) >>> 0);
            // For end_early/complete: only scan up to the value boundary, not trailing data
            const scanEnd = (rawStatus === 1 || rawStatus === 3)
              ? Math.min(newLen, engine.stream_get_value_len(streamId))
              : newLen;
            if (scanEnd > prevLen) {
              const wasmBuf = new Uint8Array(engine.memory.buffer, bufPtr, scanEnd);
              spScan(wasmBuf, prevLen, scanEnd);
            }
            prevLen = newLen;
          }
          return FEED_STATUS[rawStatus] || "error";
        },

        getValue(): unknown | undefined {
          if (destroyed) throw new Error("Parser already destroyed");
          if (cachedValue !== UNCACHED) return cachedValue;

          const status = engine.stream_get_status(streamId);
          if (status === 2) {
            throw new SyntaxError("VectorJSON: Parse error in stream");
          }

          if (status === 0) {
            // incomplete — return the incrementally-built live document
            // The returned object IS the live object — it grows as more data arrives.
            // Callers get a reference that automatically reflects future feed() calls.
            let value: unknown = ldRoot;

            // Handle pending partial values that haven't been committed to ldRoot yet:
            if (scanInScalar && ldScalarAccum) {
              // Pending scalar: try to autocomplete (e.g., "tr" → true)
              const partial = ldScalarAccum;
              const completed = partial.startsWith('t') ? 'true'
                : partial.startsWith('f') ? 'false'
                : partial.startsWith('n') ? 'null'
                : partial;
              try {
                const parsed = JSON.parse(completed);
                if (ldStack.length === 0) value = parsed;
              } catch { /* partial number like "1." — leave as-is */ }
            } else if (ldInStringValue && ldStack.length === 0) {
              // Root-level string still being accumulated
              value = ldStringAccum;
            }

            if (value === undefined) return undefined;
            // Incomplete: return partial value without schema gating.
            // User checks getStatus() to know it's not final.
            return value;
          }

          // complete or end_early — finalize any pending scalar
          if (scanInScalar && ldScalarAccum) {
            try { spSetValue(JSON.parse(ldScalarAccum)); } catch { spSetValue(null); }
            ldScalarAccum = '';
            scanInScalar = false;
          }
          ensureRemaining();

          let value: unknown = ldRoot;
          if (schema) {
            const result = schema.safeParse(value);
            if (!result.success) return (cachedValue = undefined) as undefined;
            value = result.data;
          }
          return (cachedValue = value);
        },

        getRemaining(): Uint8Array | null {
          if (destroyed) return null;
          ensureRemaining();
          return cachedRemaining!;
        },

        getStatus(): FeedStatus {
          if (destroyed) return "error";
          const status = engine.stream_get_status(streamId);
          return FEED_STATUS[status] || "error";
        },

        getRawBuffer(): ArrayBuffer | null {
          if (destroyed) return null;
          const bufPtr = engine.stream_get_buffer_ptr(streamId) >>> 0;
          const bufLen = engine.stream_get_buffer_len(streamId);
          if (bufLen === 0) return null;
          const copy = new ArrayBuffer(bufLen);
          new Uint8Array(copy).set(new Uint8Array(engine.memory.buffer, bufPtr, bufLen));
          return copy;
        },

        destroy(): void {
          if (!destroyed) {
            engine.stream_destroy(streamId);
            destroyed = true;
            cachedValue = UNCACHED;
          }
        },

        [Symbol.asyncIterator](): AsyncIterableIterator<unknown | undefined> {
          if (!source) throw new Error("No source provided — use feed() for push-based parsing");
          const self = this;
          const reader = isReadableStream(source) ? source.getReader() : null;
          const iter = reader ? null : (source as AsyncIterable<any>)[Symbol.asyncIterator]();
          let finished = false;

          return {
            async next() {
              if (finished) {
                self.destroy();
                return { done: true as const, value: undefined };
              }

              const result = reader
                ? await reader.read()
                : await iter!.next();

              if (result.done || !result.value) {
                finished = true;
                self.destroy();
                return { done: true as const, value: undefined };
              }

              const status = self.feed(result.value);
              const partial = self.getValue();

              if (status === "complete" || status === "end_early") {
                finished = true;
                return { done: false, value: partial };
              }
              if (status === "error") {
                finished = true;
                self.destroy();
                throw new SyntaxError("VectorJSON: Parse error in stream");
              }

              return { done: false, value: partial };
            },
            async return() {
              finished = true;
              self.destroy();
              if (reader) reader.cancel();
              return { done: true as const, value: undefined };
            },
            [Symbol.asyncIterator]() { return this; },
          };
        },
      };
    },
  };

  return _instance;
}

// --- Top-level await: auto-initialize with embedded WASM ---
const _vj = await init();

/** Parse a JSON string or Uint8Array. Synchronous — no init needed. */
export const parse = _vj.parse;

/** Parse partial/incomplete JSON. Compatible with Vercel AI SDK's parsePartialJson. */
export const parsePartialJson = _vj.parsePartialJson;

/** Deep-compare two values for structural equality. WASM-accelerated for VJ proxies. */
export const deepCompare = _vj.deepCompare;

/** Create a streaming parser for incremental JSON parsing. */
export const createParser = _vj.createParser;

/** Create an event-driven streaming parser with path subscriptions. */
export const createEventParser = _vj.createEventParser;

/** Eagerly materialize a lazy proxy into plain JS objects. */
export const materialize = _vj.materialize;
