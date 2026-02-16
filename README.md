# VectorJSON

O(n) WASM SIMD streaming JSON parser. Parses incomplete JSON, returns lazy proxies, tracks what's real vs autocompleted.

## Why

**1. `buffer += chunk` creates garbage faster than GC collects it.**
Every concat allocates a new string. The old one is garbage. Longer responses = bigger garbage, arriving faster than GC can free it.

**2. You can't act on partial data.**
LLM generates 100 tasks in a JSON array — you want to start on task 1 immediately. Current parsers fail on incomplete JSON or force full materialization. VectorJSON returns lazy proxies on truncated input; `isComplete()` tells you what's real vs autocompleted.

**3. O(n²) re-parsing on every chunk.**
Every AI SDK re-parses the full buffer on every chunk:

```js
// What Vercel AI SDK, Anthropic SDK, and TanStack AI actually do
for await (const chunk of stream) {
  buffer += chunk;
  result = parsePartialJson(buffer); // re-parses ENTIRE buffer every chunk
}
```

For a 100KB response in 12-char chunks, that's ~8,500 full parses — O(n²) CPU time.

**VectorJSON:**

```js
// O(n) streaming — each feed() processes only new bytes
const parser = vj.createParser();
for await (const chunk of stream) {
  const s = parser.feed(chunk);
  if (s === "complete" || s === "end_early") break;
}
const result = parser.getValue(); // lazy Proxy — zero-copy access
parser.destroy();
```

```js
// Act on elements as they arrive — don't wait for the full array
let next = 0;
for await (const chunk of stream) {
  buffer += chunk;
  const result = vj.parse(buffer);
  const tasks = result.value.tasks;
  if (result.status === "complete" || result.status === "complete_early") {
    for (; next < tasks.length; next++) execute(tasks[next]);
    break;
  }
  while (tasks[next] !== undefined && result.isComplete(tasks[next])) {
    execute(tasks[next++]);
  }
}
```

## Benchmarks

~12 chars/chunk, parser called after every chunk (what AI SDKs actually do).

`bun --expose-gc bench/ai-parsers/bench.mjs`

| Payload | Vercel AI SDK | Anthropic SDK | TanStack AI | VectorJSON | Speedup |
|---------|--------------|---------------|-------------|------------|---------|
| 1 KB    | 1.4 ms       | 1.5 ms        | 1.6 ms      | 0.3 ms     | 3–5×    |
| 5 KB    | 13 ms        | 24 ms         | 24 ms       | 0.3 ms     | 38–71×  |
| 10 KB   | 49 ms        | 97 ms         | 96 ms       | 0.6 ms     | 80–160× |
| 50 KB   | 1,162 ms     | 2,653 ms      | 2,491 ms    | 4.0 ms     | 292–686×  |
| 100 KB  | 4,224 ms     | 9,191 ms      | 7,294 ms    | 4.4 ms     | 933–2,195× |

<details>
<summary>Which products use which parser</summary>

| Product | Parser | Complexity |
|---------|--------|------------|
| Vercel AI SDK | `fixJson` + `JSON.parse` | O(n²) |
| OpenCode | Vercel AI SDK (`streamText()`) | O(n²) |
| TanStack AI | `partial-json` npm | O(n²) |
| Anthropic SDK | vendored `partial-json-parser` | O(n²) |
| Claude Code | Anthropic SDK (`partialParse`) | O(n²) |
| VectorJSON | `createParser().feed()` WASM SIMD | O(n) |

</details>

## Install

```bash
npm install vectorjson
```

## Quick Start

```js
import { init } from "vectorjson";
const vj = await init();

// One-shot
const result = vj.parse('{"users": [{"name": "Alice"}]}');
result.status;       // "complete" | "complete_early" | "incomplete" | "invalid"
result.value.users;  // lazy Proxy — materializes on access

// Streaming
const parser = vj.createParser();
parser.feed('{"hel');
parser.feed('lo": "wor');
parser.feed('ld"}');
console.log(parser.getValue()); // { hello: "world" }
parser.destroy();

// AI SDK compatible
const partial = vj.parsePartialJson('{"a": 1, "b": ');
// { value: { a: 1, b: null }, state: "repaired-parse" }
```

## API

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

### `vj.materialize(value): unknown`

Convert a lazy Proxy into a plain JS object tree. No-op on plain values.

## Building from Source

Requires: [Zig](https://ziglang.org/) 0.15+, [Bun](https://bun.sh/) or Node.js 20+.

```bash
bun run build        # Zig → WASM → wasm-opt → TypeScript
bun test             # 358 tests across 9 suites
bun run bench:ai     # AI SDK parser comparison
bun run bench:parse  # Parse + streaming benchmarks
```

## License

MIT
