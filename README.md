# VectorJSON

SIMD-accelerated streaming JSON parser for JavaScript. Replaces the O(n²) partial-JSON parsers in Vercel AI SDK, Anthropic SDK, and TanStack AI with an O(n) WASM streaming parser.

## The Problem

Every AI SDK that handles streaming JSON (tool calls, structured outputs) does this:

```js
// What Vercel AI SDK, Anthropic SDK, and TanStack AI actually do
for await (const chunk of stream) {
  buffer += chunk;
  result = parsePartialJson(buffer); // re-parses ENTIRE buffer every chunk
}
```

Each chunk re-parses the full accumulated string. For a 100KB response in 12-char chunks, that's ~8,500 full parses. This is **O(n²)** and causes quadratic CPU time, heap churn, and GC pressure.

```js
// VectorJSON — O(n) total
const parser = vj.createParser();
for await (const chunk of stream) {
  if (parser.feed(chunk) === "complete") break;
}
const result = parser.getValue();
parser.destroy();
```

Each `feed()` processes only new bytes. Total work: O(n).

## Benchmarks

Simulates real AI SDK streaming: ~12 chars/chunk, parser called after every chunk.

Run: `bun --expose-gc bench/ai-parsers/bench.mjs`

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

// One-shot parse (returns lazy Proxy — values materialize on access)
const result = vj.parse('{"users": [{"name": "Alice"}]}');
console.log(result.status);       // "complete" | "complete_early" | "incomplete" | "invalid"
console.log(result.value.users);  // lazy — only materializes when accessed

// Streaming parse
const parser = vj.createParser();
parser.feed('{"hel');
parser.feed('lo": "wor');
parser.feed('ld"}');
console.log(parser.getValue()); // { hello: "world" }
parser.destroy();

// Drop-in replacement for AI SDK partial JSON parsers
const partial = vj.parsePartialJson('{"a": 1, "b": ');
// partial.value = { a: 1, b: null }, partial.state = "repaired-parse"
```

## API

### `init(options?): Promise<VectorJSON>`

Initialize and return the cached singleton. Loads the WASM module once.

Options: `{ engineWasm?: string | URL | BufferSource }` — custom WASM location.

### `vj.parse(input: string | Uint8Array): ParseResult`

Parse JSON into a `ParseResult`:

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

- **`complete`** — valid JSON, fully parsed
- **`complete_early`** — valid JSON with trailing data (NDJSON). Use `remaining` for the rest.
- **`incomplete`** — truncated JSON (e.g. mid-stream). Value is autocompleted and accessible.
- **`invalid`** — structurally broken JSON

For incomplete parses, `isComplete(element)` distinguishes real elements from autocompleted ones — useful for streaming UIs that render partial results.

### `vj.createParser(): StreamingParser`

Incremental streaming parser. Each `feed()` processes only new bytes.

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

Drop-in replacement for Vercel AI SDK's `parsePartialJson`. Returns a plain JS object (not a Proxy).

```ts
interface PartialJsonResult {
  value: unknown;
  state: "successful-parse" | "repaired-parse" | "failed-parse";
}
```

### `vj.materialize(value): unknown`

Eagerly convert a lazy Proxy into a plain JS object tree. No-op on plain values.

### `vj.stringify(value): string`

Delegates to `JSON.stringify`.

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
