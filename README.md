# VectorJSON

O(n) WASM SIMD streaming JSON parser for LLM tool calls. Stream code to editors character-by-character, react to fields as they arrive, skip what you don't need.

## The Problem

When an LLM writes code via a tool call, it streams JSON like this:

```json
{"tool":"file_edit","path":"app.ts","code":"function hello() {\n  ...5KB of code...\n}","explanation":"I refactored the..."}
```

Your agent UI needs to:
1. **Show the tool name immediately** — so the user sees "Editing app.ts" before the code arrives
2. **Stream code to the editor character-by-character** — not wait for the full response
3. **Skip the explanation** — the user doesn't need it rendered in real-time

**No SDK lets you do this today.** Every AI SDK — Vercel, Anthropic, TanStack, OpenClaw — re-parses the *entire accumulated buffer* on every token:

```js
// What every AI SDK actually does internally
for await (const chunk of stream) {
  buffer += chunk;
  result = parsePartialJson(buffer); // re-parses ENTIRE buffer every chunk
}
```

A 50KB tool call streamed in ~12-char chunks = **~4,000 full re-parses**. That's O(n²) CPU. At 100KB, Vercel AI SDK takes **3.7 seconds**. Anthropic SDK takes **8.8 seconds**. Your UI is frozen the entire time.

## The Fix

**Drop-in replacement** — swap one function call, everything else stays the same:

```js
import { init } from "vectorjson";
const vj = await init();

// Before (O(n²) — what your SDK does today):
for await (const chunk of stream) {
  buffer += chunk;
  result = parsePartialJson(buffer); // 3.7s at 100KB
}

// After (O(n) — only new bytes processed):
const parser = vj.createParser();
for await (const chunk of stream) {
  const s = parser.feed(chunk);      // 2.3ms at 100KB
  if (s === "complete" || s === "end_early") break;
}
const result = parser.getValue();
parser.destroy();
```

**Event-driven** — react to fields as they arrive instead of polling the whole object:

```js
const parser = vj.createEventParser();

parser.on('tool', (e) => showToolUI(e.value));             // fires immediately
parser.onDelta('code', (e) => editor.append(e.value));      // streams char-by-char
parser.skip('explanation');                                  // never materialized

for await (const chunk of llmStream) {
  parser.feed(chunk);  // O(n) — only new bytes scanned
}
parser.destroy();
```

## Benchmarks

Each product benchmarked twice: original parser, then patched with VectorJSON. Same payload, same chunks (~12 chars, typical LLM token).

`bun --expose-gc bench/ai-parsers/bench.mjs`

| Payload | Product | Original | + VectorJSON | Speedup |
|---------|---------|----------|-------------|---------|
| 1 KB | Vercel AI SDK | 2.0 ms | 0.1 ms | 15× |
| | TanStack AI | 1.5 ms | 0.04 ms | 35× |
| | OpenClaw | 1.7 ms | 0.04 ms | 46× |
| | Anthropic SDK | 1.9 ms | 0.09 ms | 20× |
| 10 KB | Vercel AI SDK | 48 ms | 0.2 ms | 238× |
| | TanStack AI | 93 ms | 0.2 ms | 422× |
| | OpenClaw | 104 ms | 0.4 ms | 272× |
| | Anthropic SDK | 92 ms | 0.2 ms | 445× |
| 100 KB | Vercel AI SDK | 3.7 s | 2.3 ms | 1,624× |
| | TanStack AI | 6.5 s | 2.3 ms | 2,775× |
| | OpenClaw | 7.7 s | 2.4 ms | 3,251× |
| | Anthropic SDK | 8.8 s | 2.8 ms | 3,145× |

<details>
<summary>Which products use which parser</summary>

| Product | Original Parser | Patched With |
|---------|----------------|-------------|
| Vercel AI SDK | `fixJson` + `JSON.parse` — O(n²) | `createParser().feed()` — O(n) |
| OpenCode | Vercel AI SDK (`streamText()`) — O(n²) | `createParser().feed()` — O(n) |
| TanStack AI | `partial-json` npm — O(n²) | `createParser().feed()` — O(n) |
| OpenClaw | pi-ai → `partial-json` npm — O(n²) | `createParser().feed()` — O(n) |
| Anthropic SDK | vendored `partial-json-parser` — O(n²) | `createParser().feed()` — O(n) |
| Claude Code | Anthropic SDK (`partialParse`) — O(n²) | `createParser().feed()` — O(n) |

</details>

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

Filter events with Zod, Valibot, ArkType, or any lib with `.safeParse()`:

```js
import { z } from 'zod';

const ToolCall = z.object({ name: z.string(), args: z.record(z.unknown()) });

parser.on('tool_calls[*]', ToolCall, (event) => {
  event.value.name; // typed as string
  // Only fires when value passes schema validation
});
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

### `vj.createParser(): StreamingParser`

Each `feed()` processes only new bytes — O(n) total.

```ts
interface StreamingParser {
  feed(chunk: Uint8Array | string): FeedStatus;
  getValue(): unknown;
  getRemaining(): Uint8Array | null;
  getStatus(): FeedStatus;
  destroy(): void;
}
type FeedStatus = "incomplete" | "complete" | "error" | "end_early";
```

### `vj.parsePartialJson(input: string): PartialJsonResult`

Compatible with Vercel AI SDK's `parsePartialJson` signature. Returns a plain JS object (not a Proxy).

```ts
interface PartialJsonResult {
  value: unknown;
  state: "successful-parse" | "repaired-parse" | "failed-parse";
}
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
  getValue(): unknown;
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

## Building from Source

Requires: [Zig](https://ziglang.org/) 0.15+, [Bun](https://bun.sh/) or Node.js 20+.

```bash
bun run build        # Zig → WASM → wasm-opt → TypeScript
bun test
bun run bench:ai     # AI SDK parser comparison
bun run bench:parse  # Parse + streaming benchmarks
```

## License

MIT
