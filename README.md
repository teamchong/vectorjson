# VectorJSON

[![CI](https://github.com/teamchong/vectorjson/actions/workflows/ci.yml/badge.svg)](https://github.com/teamchong/vectorjson/actions/workflows/ci.yml)

O(n) streaming JSON parser for LLM tool calls, built on WASM SIMD. Feed chunks as they arrive from the model, read partial values without re-parsing.

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

A 50KB tool call streamed in ~12-char chunks means ~4,000 full re-parses — O(n²). At 100KB, Vercel AI SDK spends 4.1 seconds just parsing. Anthropic SDK spends 9.3 seconds.

## Quick Start

Drop-in replacement for your SDK's partial JSON parser:

```js
import { init } from "vectorjson";
const vj = await init();

// Before (JS parser — what your SDK does today):
for await (const chunk of stream) {
  buffer += chunk;
  result = parsePartialJson(buffer); // re-parses entire buffer every time
}

// After (VectorJSON — O(n) live document builder):
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

## Benchmarks

Apple-to-apple: both sides produce a materialized partial object on every chunk. Same payload, same chunks (~12 chars, typical LLM token).

`bun --expose-gc bench/ai-parsers/bench.mjs`

| Payload | Product | Original | + VectorJSON | Speedup |
|---------|---------|----------|-------------|---------|
| 1 KB | Vercel AI SDK | 4.2 ms | 162 µs | **26×** |
| | Anthropic SDK | 1.6 ms | 162 µs | **10×** |
| | TanStack AI | 1.8 ms | 162 µs | **11×** |
| | OpenClaw | 2.0 ms | 162 µs | **12×** |
| 10 KB | Vercel AI SDK | 49 ms | 470 µs | **104×** |
| | Anthropic SDK | 93 ms | 470 µs | **198×** |
| | TanStack AI | 96 ms | 470 µs | **204×** |
| | OpenClaw | 113 ms | 470 µs | **240×** |
| 100 KB | Vercel AI SDK | 4.1 s | 4.6 ms | **892×** |
| | Anthropic SDK | 9.3 s | 4.6 ms | **2016×** |
| | TanStack AI | 7.5 s | 4.6 ms | **1644×** |
| | OpenClaw | 8.1 s | 4.6 ms | **1757×** |

Stock parsers re-parse the full buffer on every chunk — O(n²). VectorJSON maintains a **live JS object** that grows incrementally on each `feed()`, so `getValue()` is O(1). Total work: O(n).

For even more control, use `createEventParser()` for field-level subscriptions or only call `getValue()` once when `feed()` returns `"complete"`.

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
```

## Usage

### Drop-in: Replace your SDK's partial JSON parser

Every AI SDK has a `parsePartialJson` function that re-parses the full buffer on every chunk. Replace it with VectorJSON's streaming parser:

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

Or use the Vercel AI SDK-compatible signature as a 1-line swap:

```js
// Before
import { parsePartialJson } from "ai";
const { value, state } = parsePartialJson(buffer);

// After
import { init } from "vectorjson";
const vj = await init();
const { value, state } = vj.parsePartialJson(buffer);
```

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

**Streaming parser** — `getValue()` returns `undefined` until the value passes the schema:

```ts
import { z } from 'zod';
const User = z.object({ name: z.string(), age: z.number() });

const parser = vj.createParser(User);       // T inferred from schema
for await (const chunk of stream) {
  const s = parser.feed(chunk);
  if (s === "complete") break;
}
const user = parser.getValue();              // { name: string; age: number } | undefined ✅
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

## Building from Source

Requires: [Zig](https://ziglang.org/) 0.15+, [Bun](https://bun.sh/) or Node.js 20+.

```bash
bun run build        # Zig → WASM → wasm-opt → TypeScript
bun run test         # 557 tests including 100MB stress payloads
```

To reproduce benchmarks:

```bash
bun --expose-gc bench/parse-stream.mjs           # one-shot + streaming parse
cd bench/ai-parsers && bun install && bun --expose-gc bench.mjs  # AI SDK comparison
```

Benchmark numbers in this README were measured on an Apple M-series Mac. Results vary by machine but relative speedups are consistent.

## License

Apache-2.0
