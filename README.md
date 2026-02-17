# VectorJSON

[![CI](https://github.com/teamchong/vectorjson/actions/workflows/ci.yml/badge.svg)](https://github.com/teamchong/vectorjson/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/vectorjson)](https://www.npmjs.com/package/vectorjson)
[![gzip size](https://img.shields.io/badge/gzip-37kB-blue)](https://www.npmjs.com/package/vectorjson)
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

A 50KB tool call streamed in ~12-char chunks means ~4,000 full re-parses — O(n²). At 100KB, Vercel AI SDK spends 5.6 seconds just parsing. Anthropic SDK spends 12.7 seconds.

## Quick Start

O(n) streaming JSON parser — feed chunks, get a live object:

```js
import { init } from "vectorjson";
const vj = await init();

const parser = vj.createParser();
for await (const chunk of stream) {
  parser.feed(chunk);
  result = parser.getValue();        // O(1) — returns live object
}
parser.destroy();
```

`getValue()` returns a **live JS object** that grows incrementally on each `feed()`. No re-parsing — each byte is scanned exactly once.

**Or skip intermediate access entirely** — if you only need the final value:

```js
const parser = vj.createParser();
for await (const chunk of stream) {
  const s = parser.feed(chunk);      // O(1) — appends bytes to WASM buffer
  if (s === "complete") break;
}
const result = parser.getValue();    // one SIMD parse at the end
parser.destroy();
```

**Event-driven** — react to fields as they arrive, O(n) total, no re-parsing:

```js
const parser = vj.createEventParser();

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
const parser = vj.createEventParser();

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
const result = vj.parse(new Uint8Array(buf)); // lazy Proxy
result.value.name; // only materializes what you touch
```

Worker-side parsing is 2-3× faster than `JSON.parse` at 50 KB+. The transferable ArrayBuffer avoids structured clone overhead, and the lazy Proxy on the main thread means you only pay for the fields you access.

## Benchmarks

Apple-to-apple: both sides produce a materialized partial object on every chunk. Same payload, same chunks (~12 chars, typical LLM token).

`bun --expose-gc bench/ai-parsers/bench.mjs`

| Payload | Product | Original | + VectorJSON | Speedup |
|---------|---------|----------|-------------|---------|
| 1 KB | Vercel AI SDK | 4.3 ms | 268 µs | **16×** |
| | Anthropic SDK | 2.3 ms | 268 µs | **9×** |
| | TanStack AI | 2.4 ms | 268 µs | **9×** |
| | OpenClaw | 1.9 ms | 268 µs | **7×** |
| 10 KB | Vercel AI SDK | 70 ms | 666 µs | **106×** |
| | Anthropic SDK | 139 ms | 666 µs | **209×** |
| | TanStack AI | 97 ms | 666 µs | **145×** |
| | OpenClaw | 109 ms | 666 µs | **164×** |
| 100 KB | Vercel AI SDK | 5.6 s | 6.1 ms | **907×** |
| | Anthropic SDK | 12.7 s | 6.1 ms | **2065×** |
| | TanStack AI | 6.6 s | 6.1 ms | **1079×** |
| | OpenClaw | 7.6 s | 6.1 ms | **1238×** |

Stock parsers re-parse the full buffer on every chunk — O(n²). VectorJSON maintains a **live JS object** that grows incrementally on each `feed()`, so `getValue()` is O(1). Total work: O(n).

### Why this matters: main thread availability

The real cost isn't just CPU time — it's blocking the agent's main thread. Simulating an Anthropic `tool_use` content block (`str_replace_editor`) streamed in ~12-char chunks:

`bun --expose-gc bench/time-to-first-action.mjs`

| Payload | Stock total | VectorJSON total | Main thread freed |
|---------|-----------|-----------------|-------------------|
| 1 KB | 3.7 ms | 2.0 ms | 1.7 ms sooner |
| 10 KB | 38 ms | 2 ms | 36 ms sooner |
| 50 KB | 657 ms | 3 ms | **654 ms sooner** |
| 100 KB | 2.3 s | 6 ms | **2.3 seconds sooner** |

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
import { init } from "vectorjson";
const vj = await init();

const parser = vj.createParser();
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
import { init } from "vectorjson";
const vj = await init();
const { value, state } = vj.parsePartialJson(buffer);
```

> **Note:** AI SDKs (Vercel, Anthropic, TanStack) parse JSON internally inside `streamObject()`, `MessageStream`, etc. — you don't get access to the raw chunks. To use VectorJSON today, work with the raw LLM stream directly (raw fetch, WebSocket, SSE).

### Event-driven: React to fields as they stream in

When an LLM streams a tool call, you usually care about specific fields at specific times. `createEventParser` lets you subscribe to paths and get notified the moment a value completes or a string grows:

```js
const parser = vj.createEventParser();

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
const parser = vj.createEventParser({
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
const parser = vj.createEventParser();
parser.on('answer', (e) => console.log(e.value));
parser.onText((text) => thinkingPanel.append(text)); // opt-in

// All of these work:
// <think>reasoning</think>{"answer": 42}
// ```json\n{"answer": 42}\n```
// Here's the result:\n{"answer": 42}
parser.feed(llmOutput);
```

### Schema validation

Validate and auto-infer types with Zod, Valibot, ArkType, or any lib with `.safeParse()`. Works on all three APIs:

**Streaming parser with typed partial objects** — like Vercel AI SDK's `output`, but O(n) instead of O(n²):

```ts
import { z } from 'zod';
const User = z.object({ name: z.string(), age: z.number() });

const parser = vj.createParser(User);       // T inferred from schema
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
const { value, state } = vj.parsePartialJson('{"name":"Al', User);
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
const a = vj.parse('{"name":"Alice","age":30}').value;
const b = vj.parse('{"age":30,"name":"Alice"}').value;

vj.deepCompare(a, b);                          // true — key order ignored by default
vj.deepCompare(a, b, { ignoreKeyOrder: false }); // false — keys must be in same order
```

By default, `deepCompare` ignores key order — `{"a":1,"b":2}` equals `{"b":2,"a":1}`, just like `fast-deep-equal`. Set `{ ignoreKeyOrder: false }` for strict key order comparison, which is ~2× faster when you know both values come from the same source.

```
bun --expose-gc bench/deep-compare.mjs

  Equal objects (560 KB):
  JS deepEqual (recursive)       1.0K ops/s    heap Δ  8.9 MB
  VJ ignore key order (default)  2.1K ops/s    heap Δ  0.1 MB    2× faster
  VJ strict key order            4.8K ops/s    heap Δ  0.2 MB    5× faster
```

Works with any combination: two VJ proxies (fast WASM path), plain JS objects, or mixed (falls back to `JSON.stringify` comparison).

### Lazy access — only materialize what you touch

`vj.parse()` returns a lazy Proxy backed by the WASM tape. Fields are only materialized into JS objects when you access them. On a 2 MB payload, reading one field is 2× faster than `JSON.parse` because the other 99% is never allocated:

```js
const result = vj.parse(huge2MBToolCall);
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
const result = vj.parse('{"users": [{"name": "Alice"}]}');
result.status;       // "complete" | "complete_early" | "incomplete" | "invalid"
result.value.users;  // lazy Proxy — materializes on access
```

## API Reference

### `init(options?): Promise<VectorJSON>`

Loads WASM once, returns cached singleton. `{ engineWasm?: string | URL | BufferSource }` for custom WASM location.

### `vj.parse(input: string | Uint8Array): ParseResult`

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

### `vj.createParser(schema?): StreamingParser<T>`

Each `feed()` processes only new bytes — O(n) total. Pass an optional schema to auto-validate and infer the return type.

```ts
interface StreamingParser<T = unknown> {
  feed(chunk: Uint8Array | string): FeedStatus;
  getValue(): T | undefined;  // autocompleted partial while incomplete, final when complete
  getRemaining(): Uint8Array | null;
  getRawBuffer(): ArrayBuffer | null;  // transferable buffer for Worker postMessage
  getStatus(): FeedStatus;
  destroy(): void;
}
type FeedStatus = "incomplete" | "complete" | "error" | "end_early";
```

While incomplete, `getValue()` returns the **live document** — a mutable JS object that grows incrementally on each `feed()`. This is O(1) per call (just returns the reference). With a schema, returns `undefined` when validation fails:

```ts
import { z } from 'zod';
const User = z.object({ name: z.string(), age: z.number() });

const parser = vj.createParser(User);
parser.feed('{"name":"Alice","age":30}');
const val = parser.getValue(); // { name: string; age: number } | undefined ✅
```

Works with Zod, Valibot, ArkType — any library with `{ safeParse(v) → { success, data? } }`.

### `vj.parsePartialJson(input, schema?): PartialJsonResult<DeepPartial<T>>`

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

### `vj.createEventParser(options?): EventParser`

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

### `vj.deepCompare(a, b, options?): boolean`

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

### `vj.materialize(value): unknown`

Convert a lazy Proxy into a plain JS object tree. No-op on plain values.

## Runtime Support

| Runtime | Status | Notes |
|---------|--------|-------|
| Node.js 20+ | ✅ | WASM loaded from disk automatically |
| Bun | ✅ | WASM loaded from disk automatically |
| Browsers | ✅ | Pass `engineWasm` as `ArrayBuffer` or `URL` to `init()` |
| Deno | ✅ | Pass `engineWasm` as `URL` to `init()` |
| Cloudflare Workers | ✅ | Import WASM as module, pass as `ArrayBuffer` to `init()` |

For environments without filesystem access, provide the WASM binary explicitly:

```js
import { init } from "vectorjson";

// Option 1: URL (browsers, Deno)
const vj = await init({ engineWasm: new URL('./engine.wasm', import.meta.url) });

// Option 2: ArrayBuffer (Workers, custom loaders)
const wasmBytes = await fetch('/engine.wasm').then(r => r.arrayBuffer());
const vj = await init({ engineWasm: wasmBytes });
```

Bundle size: ~92 KB WASM + ~20 KB JS (~37 KB gzipped total). No runtime dependencies.

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
bun run test         # 557 tests including 100MB stress payloads
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

## License

Apache-2.0
