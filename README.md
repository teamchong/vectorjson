# VectorJSON

[![CI](https://github.com/teamchong/vectorjson/actions/workflows/ci.yml/badge.svg)](https://github.com/teamchong/vectorjson/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/vectorjson)](https://www.npmjs.com/package/vectorjson)
[![gzip size](https://img.shields.io/badge/gzip-~47kB-blue)](https://www.npmjs.com/package/vectorjson)
[![license](https://img.shields.io/npm/l/vectorjson)](https://github.com/teamchong/vectorjson/blob/main/LICENSE)

O(n) streaming JSON parser for LLM tool calls, built on WASM SIMD. Agents act faster with field-level streaming, detect wrong outputs early to abort and save tokens, and offload parsing to Workers with transferable ArrayBuffers.

## The Problem

When an LLM writes code via a tool call, it streams JSON like this:

```json
{"tool":"file_edit","path":"app.ts","code":"function hello() {\n  ...5KB of code...\n}","explanation":"I refactored the..."}
```

Your agent UI needs to:
1. **Show the tool name immediately** — so the user sees "Editing app.ts" before the code arrives
2. **Stream code to the editor character-by-character** — not wait for the full response
3. **Skip the explanation** — the user doesn't need it rendered in real-time

Current AI SDKs — Vercel, Anthropic, TanStack, OpenClaw — re-parse the *entire accumulated buffer* on every token:

```js
// What every AI SDK actually does internally
for await (const chunk of stream) {
  buffer += chunk;
  result = parsePartialJson(buffer); // re-parses ENTIRE buffer every chunk
}
```

A 50KB tool call streamed in ~12-char chunks means ~4,000 full re-parses — O(n²). At 100KB, Vercel AI SDK spends 6.1 seconds just parsing. Anthropic SDK spends 13.4 seconds.

## Quick Start

Zero-config — just import and use. No `init()`, no WASM setup:

```js
import { parse, createParser, createEventParser } from "vectorjson";

// One-shot parse
const result = parse('{"tool":"file_edit","path":"app.ts"}');
result.value.tool;  // "file_edit" — lazy Proxy over WASM tape
```

**Streaming** — O(n) incremental parsing, feed chunks, get a live object:

```js
import { createParser } from "vectorjson";

const parser = createParser();
for await (const chunk of stream) {
  parser.feed(chunk);
  result = parser.getValue();        // O(1) — returns live object
}
parser.destroy();
```

`getValue()` returns a **live JS object** that grows incrementally on each `feed()`. No re-parsing — each byte is scanned exactly once.

**Schema-aware field picking** — an LLM streams a 50KB tool call, but you only need `name` and `age`. With `pick`, the parser skips everything else *during byte scanning* — no JS objects allocated for skipped fields. Combined with `source`, you get a pull-based `for await` loop that yields partial objects as chunks arrive, and validates the final result against your schema:

```js
import { z } from "zod";
import { createParser } from "vectorjson";

const parser = createParser({
  pick: ["name", "age"],                              // skip all other fields at byte level
  schema: z.object({ name: z.string(), age: z.number() }),
  source: response.body,                              // ReadableStream or AsyncIterable
});

for await (const partial of parser) {
  console.log(partial);
  // { name: "Ali" }              ← partial string, render immediately
  // { name: "Alice" }            ← string complete
  // { name: "Alice", age: 30 }   ← schema-validated on complete
}
// auto-destroys when source ends or you break
```

**Or skip intermediate access entirely** — if you only need the final value:

```js
const parser = createParser();
for await (const chunk of stream) {
  const s = parser.feed(chunk);      // O(1) — appends bytes to WASM buffer
  if (s === "complete") break;
}
const result = parser.getValue();    // one SIMD parse at the end
parser.destroy();
```

**Event-driven** — react to fields as they arrive, O(n) total, no re-parsing:

```js
import { createEventParser } from "vectorjson";

const parser = createEventParser();

parser.on('tool', (e) => showToolUI(e.value));             // fires immediately
parser.onDelta('code', (e) => editor.append(e.value));     // streams char-by-char
parser.skip('explanation');                                // never materialized

for await (const chunk of llmStream) {
  parser.feed(chunk);  // O(n) — only new bytes scanned
}
parser.destroy();
```

**Early abort** — detect wrong output at chunk 7, cancel the remaining 8,000+ chunks:

```js
const abort = new AbortController();
const parser = createEventParser();

parser.on('name', (e) => {
  if (e.value !== 'str_replace_editor') {
    parser.destroy();
    abort.abort();  // stop the LLM stream, stop paying for tokens
  }
});

for await (const chunk of llmStream({ signal: abort.signal })) {
  const status = parser.feed(chunk);
  if (status === 'error') break;  // malformed JSON — bail out
}
```

**Worker offload** — parse 2-3× faster in a Worker, transfer results in O(1):

VectorJSON's `getRawBuffer()` returns flat bytes — `postMessage(buf, [buf])` transfers the backing store pointer in O(1) instead of structured-cloning a full object graph. The main thread lazily accesses only the fields it needs:

```js
// In Worker:
parser.feed(chunk);
const buf = parser.getRawBuffer();
postMessage(buf, [buf]); // O(1) transfer — moves pointer, no copy

// On Main thread:
const result = parse(new Uint8Array(buf)); // lazy Proxy
result.value.name; // only materializes what you touch
```

Worker-side parsing is 2-3× faster than `JSON.parse` at 50 KB+. The transferable ArrayBuffer avoids structured clone overhead, and the lazy Proxy on the main thread means you only pay for the fields you access.

## Benchmarks

Apple-to-apple: both sides produce a materialized partial object on every chunk. Same payload, same chunks (~12 chars, typical LLM token).

`bun --expose-gc bench/ai-parsers/bench.mjs`

| Payload | Product | Original | + VectorJSON | Speedup |
|---------|---------|----------|-------------|---------|
| 1 KB | Vercel AI SDK | 3.9 ms | 283 µs | **14×** |
| | Anthropic SDK | 3.3 ms | 283 µs | **12×** |
| | TanStack AI | 3.2 ms | 283 µs | **11×** |
| | OpenClaw | 3.8 ms | 283 µs | **14×** |
| 5 KB | Vercel AI SDK | 23.1 ms | 739 µs | **31×** |
| | Anthropic SDK | 34.7 ms | 739 µs | **47×** |
| | TanStack AI | — | 739 µs | — |
| | OpenClaw | — | 739 µs | — |
| 50 KB | Vercel AI SDK | 1.80 s | 2.7 ms | **664×** |
| | Anthropic SDK | 3.39 s | 2.7 ms | **1255×** |
| | TanStack AI | 2.34 s | 2.7 ms | **864×** |
| | OpenClaw | 2.73 s | 2.7 ms | **1011×** |
| 100 KB | Vercel AI SDK | 6.1 s | 6.6 ms | **920×** |
| | Anthropic SDK | 13.4 s | 6.6 ms | **2028×** |
| | TanStack AI | 7.0 s | 6.6 ms | **1065×** |
| | OpenClaw | 8.0 s | 6.6 ms | **1222×** |

Stock parsers re-parse the full buffer on every chunk — O(n²). VectorJSON maintains a **live JS object** that grows incrementally on each `feed()`, so `getValue()` is O(1). Total work: O(n).

### Why this matters: main thread availability

The real cost isn't just CPU time — it's blocking the agent's main thread. Simulating an Anthropic `tool_use` content block (`str_replace_editor`) streamed in ~12-char chunks:

`bun --expose-gc bench/time-to-first-action.mjs`

| Payload | Stock total | VectorJSON total | Main thread freed |
|---------|-----------|-----------------|-------------------|
| 1 KB | 4.0 ms | 1.7 ms | 2.3 ms sooner |
| 10 KB | 36.7 ms | 1.9 ms | 35 ms sooner |
| 50 KB | 665 ms | 3.8 ms | **661 ms sooner** |
| 100 KB | 2.42 s | 10.2 ms | **2.4 seconds sooner** |

Both approaches detect the tool name (`.name`) at the same chunk — the LLM hasn't streamed more yet. But while VectorJSON finishes processing all chunks in milliseconds, the stock parser blocks the main thread for the entire duration. The agent can't render UI, stream code to the editor, or start running tools until parsing is done.

For even more control, use `createEventParser()` for field-level subscriptions or only call `getValue()` once when `feed()` returns `"complete"`.

### Worker Transfer: parse faster, transfer in O(1)

`bun run bench:worker` (requires Playwright + Chromium)

Measures the full Worker→Main thread pipeline in a real browser. VectorJSON parses 2-3× faster in the Worker at 50 KB+, and `getRawBuffer()` produces a transferable ArrayBuffer — `postMessage(buf, [buf])` moves the backing store pointer in O(1) instead of structured-cloning the parsed object.

<details>
<summary>Which products use which parser</summary>

| Product | Stock Parser | With VectorJSON |
|---------|-------------|----------------|
| Vercel AI SDK | `fixJson` + `JSON.parse` — O(n²) | `createParser().feed()` + `getValue()` |
| OpenCode | Vercel AI SDK (`streamText()`) — O(n²) | `createParser().feed()` + `getValue()` |
| TanStack AI | `partial-json` npm — O(n²) | `createParser().feed()` + `getValue()` |
| OpenClaw | `partial-json` npm — O(n²) | `createParser().feed()` + `getValue()` |
| Anthropic SDK | vendored `partial-json-parser` — O(n²) | `createParser().feed()` + `getValue()` |

</details>

## How It Works

VectorJSON compiles [simdjson](https://simdjson.org/) (a SIMD-accelerated JSON parser written in C++) to WebAssembly via Zig. The WASM module does the byte-level parsing — finding structural characters, validating UTF-8, building a tape of tokens — while a thin JS layer provides the streaming API, lazy Proxy materialization, and event dispatch.

The streaming parser (`createParser`) accumulates chunks in a WASM-side buffer and re-runs the SIMD parse on the full buffer each `feed()`. This sounds similar to re-parsing, but the difference is: the parse itself runs at SIMD speed inside WASM (~1 GB/s), while JS-based parsers run at ~50 MB/s. The JS object returned by `getValue()` is a live Proxy that reads directly from the WASM tape — no intermediate object allocation.

The event parser (`createEventParser`) adds path-matching on top: it diffs the tape between feeds to detect new/changed values and fires callbacks only for subscribed paths.

## Install

```bash
npm install vectorjson
# or
pnpm add vectorjson
# or
bun add vectorjson
# or
yarn add vectorjson
```

## Usage

### Streaming parse

Feed chunks as they arrive from any source — raw fetch, WebSocket, SSE, or your own transport:

```js
import { createParser } from "vectorjson";

const parser = createParser();
for await (const chunk of stream) {
  const s = parser.feed(chunk);
  if (s === "complete" || s === "end_early") break;
}
const result = parser.getValue(); // lazy Proxy — materializes on access
parser.destroy();
```

### Vercel AI SDK-compatible signature

If you have code that calls `parsePartialJson`, VectorJSON provides a compatible function:

```js
// Before
import { parsePartialJson } from "ai";
const { value, state } = parsePartialJson(buffer);

// After
import { parsePartialJson } from "vectorjson";
const { value, state } = parsePartialJson(buffer);
```

> **Note:** AI SDKs (Vercel, Anthropic, TanStack) parse JSON internally inside `streamObject()`, `MessageStream`, etc. — you don't get access to the raw chunks. To use VectorJSON today, work with the raw LLM stream directly (raw fetch, WebSocket, SSE).

### Event-driven: React to fields as they stream in

When an LLM streams a tool call, you usually care about specific fields at specific times. `createEventParser` lets you subscribe to paths and get notified the moment a value completes or a string grows:

```js
import { createEventParser } from "vectorjson";

const parser = createEventParser();

// Get the tool name the moment it's complete
parser.on('tool_calls[*].name', (e) => {
  console.log(e.value);   // "search"
  console.log(e.index);   // 0 (which tool call)
});

// Stream code to the editor as it arrives
parser.onDelta('tool_calls[0].args.code', (e) => {
  editor.append(e.value); // just the new characters, decoded
});

// Don't waste CPU on fields you don't need
parser.skip('tool_calls[*].args.explanation');

for await (const chunk of llmStream) {
  parser.feed(chunk);
}
parser.destroy();
```

### Multi-root / NDJSON

Some LLM APIs stream multiple JSON values separated by newlines. VectorJSON auto-resets between values:

```js
import { createEventParser } from "vectorjson";

const parser = createEventParser({
  multiRoot: true,
  onRoot(event) {
    console.log(`Root #${event.index}:`, event.value);
  }
});

for await (const chunk of ndjsonStream) {
  parser.feed(chunk);
}
parser.destroy();
```

### Mixed LLM output (chain-of-thought, code fences)

Some models emit thinking text before JSON, or wrap JSON in code fences. VectorJSON finds the JSON automatically:

```js
import { createEventParser } from "vectorjson";

const parser = createEventParser();
parser.on('answer', (e) => console.log(e.value));
parser.onText((text) => thinkingPanel.append(text)); // opt-in

// All of these work:
// <think>reasoning</think>{"answer": 42}
// ```json\n{"answer": 42}\n```
// Here's the result:\n{"answer": 42}
parser.feed(llmOutput);
```

### Field picking — only parse what you need

When streaming a large tool call, you often only need 2-3 fields. `pick` tells the parser to skip everything else during byte scanning — skipped fields never allocate JS objects:

```js
import { createParser } from "vectorjson";

const parser = createParser({ pick: ["name", "age"] });
parser.feed('{"name":"Alice","age":30,"bio":"...10KB of text...","metadata":{}}');
parser.getValue(); // { name: "Alice", age: 30 } — bio and metadata never materialized
parser.destroy();
```

Nested paths work with dot notation:

```js
const parser = createParser({ pick: ["user.name", "user.age"] });
parser.feed('{"user":{"name":"Bob","age":25,"role":"admin"},"extra":"data"}');
parser.getValue(); // { user: { name: "Bob", age: 25 } }
parser.destroy();
```

### `for await` — pull-based streaming from any source

Pass a `source` (ReadableStream or AsyncIterable) and iterate with `for await`. Each iteration yields the growing partial value:

```js
import { createParser } from "vectorjson";

const parser = createParser({ source: response.body });

for await (const partial of parser) {
  console.log(partial);
  // { name: "Ali" }
  // { name: "Alice" }
  // { name: "Alice", age: 30 }
}
// Parser auto-destroys when the source ends or you break out of the loop
```

Combine `pick` + `source` for minimal allocation streaming:

```js
const parser = createParser({
  pick: ["name", "age"],
  source: response.body,
});

for await (const partial of parser) {
  updateUI(partial); // only picked fields, growing incrementally
}
```

Works with any async source — fetch body, WebSocket wrapper, SSE adapter, or a plain async generator:

```js
async function* chunks() {
  yield '{"status":"';
  yield 'ok","data":';
  yield '[1,2,3]}';
}

for await (const partial of createParser({ source: chunks() })) {
  console.log(partial);
}
```

### Schema validation

Validate and auto-infer types with Zod, Valibot, ArkType, or any lib with `.safeParse()`. Works on all three APIs:

**Streaming parser with typed partial objects** — like Vercel AI SDK's `output`, but O(n) instead of O(n²):

```ts
import { z } from 'zod';
import { createParser } from "vectorjson";

const User = z.object({ name: z.string(), age: z.number() });

const parser = createParser(User);           // T inferred from schema
for await (const chunk of stream) {
  parser.feed(chunk);
  const partial = parser.getValue();         // { name: "Ali" } mid-stream — always available
  const done = parser.getStatus() === "complete";
  updateUI(partial, done);                   // render as fields arrive
}
// On complete: getValue() runs safeParse → returns validated data or undefined
parser.destroy();
```

**Partial JSON** — returns `DeepPartial<T>` because incomplete JSON has missing fields:

```ts
import { parsePartialJson } from "vectorjson";

const { value, state } = parsePartialJson('{"name":"Al', User);
// value: { name: "Al" }     — partial object, typed as DeepPartial<{ name: string; age: number }>
// state: "repaired-parse"
// TypeScript type: { name?: string; age?: number } | undefined
```

**Event parser** — filter events by schema:

```js
const ToolCall = z.object({ name: z.string(), args: z.record(z.unknown()) });

parser.on('tool_calls[*]', ToolCall, (event) => {
  event.value.name; // typed as string
  // Only fires when value passes schema validation
});
```

Schema-agnostic: any object with `{ safeParse(v) → { success: boolean; data?: T } }` works.

### Deep compare — compare JSON without materializing

Compare two parsed values directly in WASM memory. Returns a boolean — no JS objects allocated, no Proxy traps fired. Useful for diffing LLM outputs, caching, or deduplication:

```js
import { parse, deepCompare } from "vectorjson";

const a = parse('{"name":"Alice","age":30}').value;
const b = parse('{"age":30,"name":"Alice"}').value;

deepCompare(a, b);                          // true — key order ignored by default
deepCompare(a, b, { ignoreKeyOrder: false }); // false — keys must be in same order
```

By default, `deepCompare` ignores key order — `{"a":1,"b":2}` equals `{"b":2,"a":1}`, just like `fast-deep-equal`. Set `{ ignoreKeyOrder: false }` for strict key order comparison, which is ~2× faster when you know both values come from the same source.

```
bun --expose-gc bench/deep-compare.mjs

  Equal objects (560 KB):
  JS deepEqual (recursive)         848 ops/s    heap Δ  2.4 MB
  VJ ignore key order (default)  1.63K ops/s    heap Δ  0.1 MB    2× faster
  VJ strict key order            3.41K ops/s    heap Δ  0.1 MB    4× faster
```

Works with any combination: two VJ proxies (fast WASM path), plain JS objects, or mixed (falls back to `JSON.stringify` comparison).

### Lazy access — only materialize what you touch

`parse()` returns a lazy Proxy backed by the WASM tape. Fields are only materialized into JS objects when you access them. On a 2 MB payload, reading one field is 2× faster than `JSON.parse` because the other 99% is never allocated:

```js
import { parse } from "vectorjson";

const result = parse(huge2MBToolCall);
result.value.tool;   // "file_edit" — reads from WASM tape, 2.3ms
result.value.path;   // "app.ts"
// result.value.code (the 50KB field) is never materialized in JS memory
```

```
bun --expose-gc bench/partial-access.mjs

  2.2 MB payload, 10K items:
  Access 1 field    JSON.parse 4.6ms    VectorJSON 2.3ms    2× faster
  Access 10 items   JSON.parse 4.5ms    VectorJSON 2.6ms    1.7× faster
  Full access       JSON.parse 4.8ms    VectorJSON 4.6ms    ~equal
```

### One-shot parse

For non-streaming use cases:

```js
import { parse } from "vectorjson";

const result = parse('{"users": [{"name": "Alice"}]}');
result.status;       // "complete" | "complete_early" | "incomplete" | "invalid"
result.value.users;  // lazy Proxy — materializes on access
```

## API Reference

### Direct exports (recommended)

All functions are available as direct imports — no `init()` needed:

```js
import { parse, parsePartialJson, deepCompare, createParser, createEventParser, materialize } from "vectorjson";
```

### `init(options?): Promise<VectorJSON>`

Returns cached singleton. Useful for passing custom WASM via `{ engineWasm?: string | URL | BufferSource }`. Called automatically on import.

### `parse(input: string | Uint8Array): ParseResult`

```ts
interface ParseResult {
  status: "complete" | "complete_early" | "incomplete" | "invalid";
  value?: unknown;           // lazy Proxy for objects/arrays, plain value for primitives
  remaining?: Uint8Array;    // unparsed bytes after complete_early (for NDJSON)
  error?: string;
  isComplete(val: unknown): boolean;  // was this value in the original input or autocompleted?
  toJSON(): unknown;                   // full materialization via JSON.parse (cached)
}
```

- **`complete`** — valid JSON
- **`complete_early`** — valid JSON with trailing data (NDJSON); use `remaining` for the rest
- **`incomplete`** — truncated JSON; value is autocompleted, `isComplete()` tells you what's real
- **`invalid`** — broken JSON

### `createParser(schema?): StreamingParser<T>`
### `createParser(options?): StreamingParser<T>`

Each `feed()` processes only new bytes — O(n) total. Three overloads:

```ts
createParser();                    // no validation
createParser(schema);              // schema validation (Zod, Valibot, etc.)
createParser({ pick, schema, source }); // options object
```

**Options object:**

```ts
interface CreateParserOptions<T = unknown> {
  pick?: string[];       // only include these fields (dot-separated paths)
  schema?: ZodLike<T>;   // validate on complete
  source?: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>;
}
```

When `source` is provided, the parser becomes async-iterable — use `for await` to consume partial values:

```ts
for await (const partial of createParser({ source: stream, pick: ["name"] })) {
  console.log(partial); // growing object with only picked fields
}
```

```ts
interface StreamingParser<T = unknown> {
  feed(chunk: Uint8Array | string): FeedStatus;
  getValue(): T | undefined;  // autocompleted partial while incomplete, final when complete
  getRemaining(): Uint8Array | null;
  getRawBuffer(): ArrayBuffer | null;  // transferable buffer for Worker postMessage
  getStatus(): FeedStatus;
  destroy(): void;
  [Symbol.asyncIterator](): AsyncIterableIterator<T | undefined>;  // requires source
}
type FeedStatus = "incomplete" | "complete" | "error" | "end_early";
```

While incomplete, `getValue()` returns the **live document** — a mutable JS object that grows incrementally on each `feed()`. This is O(1) per call (just returns the reference). With a schema, returns `undefined` when validation fails:

```ts
import { z } from 'zod';
import { createParser } from "vectorjson";

const User = z.object({ name: z.string(), age: z.number() });

const parser = createParser(User);
parser.feed('{"name":"Alice","age":30}');
const val = parser.getValue(); // { name: string; age: number } | undefined ✅
```

Works with Zod, Valibot, ArkType — any library with `{ safeParse(v) → { success, data? } }`.

### `parsePartialJson(input, schema?): PartialJsonResult<DeepPartial<T>>`

Compatible with Vercel AI SDK's `parsePartialJson` signature. Returns a plain JS object (not a Proxy). Pass an optional schema for type-safe validation.

With a schema, returns `DeepPartial<T>` — all properties are optional because incomplete JSON will have missing fields. When `safeParse` succeeds, returns validated `data`. When `safeParse` fails on a repaired-parse (partial JSON), the raw parsed value is kept — the object is partial, that's expected.

```ts
interface PartialJsonResult<T = unknown> {
  value: T | undefined;
  state: "successful-parse" | "repaired-parse" | "failed-parse";
}

type DeepPartial<T> = T extends object
  ? T extends Array<infer U> ? Array<DeepPartial<U>>
  : { [K in keyof T]?: DeepPartial<T[K]> }
  : T;
```

### `createEventParser(options?): EventParser`

Event-driven streaming parser. Events fire synchronously during `feed()`.

```ts
interface EventParser {
  on(path: string, callback: (event: PathEvent) => void): EventParser;
  on<T>(path: string, schema: { safeParse: Function }, callback: (event: PathEvent & { value: T }) => void): EventParser;
  onDelta(path: string, callback: (event: DeltaEvent) => void): EventParser;
  onText(callback: (text: string) => void): EventParser;
  skip(...paths: string[]): EventParser;
  off(path: string, callback?: Function): EventParser;
  feed(chunk: string | Uint8Array): FeedStatus;
  getValue(): unknown | undefined;  // undefined while incomplete, throws on parse errors
  getRemaining(): Uint8Array | null;
  getRawBuffer(): ArrayBuffer | null;  // transferable buffer for Worker postMessage
  getStatus(): FeedStatus;
  destroy(): void;
}
```

All methods return `self` for chaining: `parser.on(...).onDelta(...).skip(...)`.

**Path syntax:**
- `foo.bar` — exact key
- `foo[0]` — array index
- `foo[*]` — any array index (wildcard)
- `foo.*.bar` — wildcard single segment (any key or index)

**Event types:**

```ts
interface PathEvent {
  type: 'value';
  path: string;           // resolved path: "items.2.name" (concrete indices)
  value: unknown;         // parsed JS value
  offset: number;         // byte offset in accumulated buffer
  length: number;         // byte length of raw value
  index?: number;         // last wildcard-matched array index
  key?: string;           // last wildcard-matched object key
  matches: (string | number)[];  // all wildcard-matched segments
}

interface DeltaEvent {
  type: 'delta';
  path: string;           // resolved path
  value: string;          // decoded characters (escapes like \n are resolved)
  offset: number;         // byte offset of delta in buffer (raw bytes)
  length: number;         // byte length of delta (raw bytes, not char count)
}

interface RootEvent {
  type: 'root';
  index: number;          // which root value (0, 1, 2...)
  value: unknown;         // parsed via doc_parse
}
```

### `deepCompare(a, b, options?): boolean`

Compare two values for deep equality without materializing JS objects. When both values are VJ proxies, comparison runs entirely in WASM memory — zero allocations, zero Proxy traps.

```ts
deepCompare(
  a: unknown,
  b: unknown,
  options?: { ignoreKeyOrder?: boolean }  // default: true
): boolean
```

- **`ignoreKeyOrder: true`** (default) — `{"a":1,"b":2}` equals `{"b":2,"a":1}`. Same semantics as `fast-deep-equal`.
- **`ignoreKeyOrder: false`** — keys must appear in the same order. ~2× faster for same-source comparisons.
- Falls back to `JSON.stringify` comparison when either value is a plain JS object.

### `materialize(value): unknown`

Convert a lazy Proxy into a plain JS object tree. No-op on plain values.

## Runtime Support

| Runtime | Status | Notes |
|---------|--------|-------|
| Node.js 20+ | ✅ | WASM embedded in bundle — zero config |
| Bun | ✅ | WASM embedded in bundle — zero config |
| Browsers | ✅ | WASM embedded in bundle — zero config |
| Deno | ✅ | WASM embedded in bundle — zero config |
| Cloudflare Workers | ✅ | WASM embedded in bundle — zero config |

WASM is embedded as base64 in the JS bundle and auto-initialized via top-level `await`. No setup required — just `import { parse } from "vectorjson"`.

For advanced use cases, you can still provide a custom WASM binary via `init()`:

```js
import { init } from "vectorjson";
const vj = await init({ engineWasm: customWasmBytes });
```

Bundle size: ~148 KB JS with embedded WASM (~47 KB gzipped). No runtime dependencies.

## Runnable Examples

The `examples/` directory has working demos you can run immediately:

```bash
# Anthropic tool call — streams fields as they arrive, early abort demo
bun examples/anthropic-tool-call.ts --mock
bun examples/anthropic-tool-call.ts --mock --wrong-tool   # early abort

# OpenAI function call — streams function arguments via EventParser
bun examples/openai-function-call.ts --mock

# With a real API key:
ANTHROPIC_API_KEY=sk-ant-... bun examples/anthropic-tool-call.ts
OPENAI_API_KEY=sk-...       bun examples/openai-function-call.ts
```

See also `examples/ai-usage.ts` for additional patterns (MCP stdio, Vercel AI SDK `streamObject`, NDJSON embeddings).

## Building from Source

Requires: [Zig](https://ziglang.org/) 0.15+, [Bun](https://bun.sh/) or Node.js 20+, [Binaryen](https://github.com/WebAssembly/binaryen) (`wasm-opt`).

```bash
# macOS
brew install binaryen

# Ubuntu / Debian
sudo apt-get install -y binaryen
```

```bash
bun run build        # Zig → WASM → wasm-opt → TypeScript
bun run test         # 724+ tests including 100MB stress payloads
bun run test:worker  # Worker transferable tests (Playwright + Chromium)
```

To reproduce benchmarks:

```bash
bun --expose-gc bench/parse-stream.mjs           # one-shot + streaming parse
cd bench/ai-parsers && bun install && bun --expose-gc bench.mjs  # AI SDK comparison
bun run bench:worker                             # Worker transfer vs structured clone benchmark
node --expose-gc bench/deep-compare.mjs          # deep compare: VJ vs JS deepEqual
```

Benchmark numbers in this README were measured on GitHub Actions (Ubuntu, x86_64). Results vary by machine but relative speedups are consistent.

## Acknowledgments

VectorJSON is built on the work of:

- **[zimdjson](https://github.com/EzequielRamis/zimdjson)** by Ezequiel Ramis — a Zig port of simdjson that powers the WASM engine
- **[simdjson](https://simdjson.org/)** by Daniel Lemire & Geoff Langdale — the SIMD-accelerated JSON parsing research that started it all

## License

Apache-2.0
