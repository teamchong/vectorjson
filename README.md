# VectorJSON

**SIMD-accelerated JSON toolkit for JavaScript** — parsing, streaming, stringify, deep compare, and schema validation, powered by WebAssembly.

VectorJSON uses [zimdjson](https://github.com/niclas-overby/zimdjson) (Zig port of simdjson) for SIMD-accelerated parsing and a WasmGC bridge to build native JS objects directly in WASM — no `.dispose()`, no manual memory management.

## Why?

AI SDKs that receive streaming JSON (structured outputs, tool calls) typically do this:

```js
// The Vercel AI SDK pattern — O(n²)
let buffer = "";
for await (const chunk of stream) {
  buffer += chunk;
  try { result = JSON.parse(buffer); } catch {}
}
```

**Every chunk re-parses the entire accumulated buffer.** For a 1MB response split into 256-byte chunks, that's ~4000 full parses of increasingly large strings. This is O(n²) and causes:
- Quadratic CPU time growth
- Massive heap churn (new string + parsed object on every chunk)
- GC pressure that causes jank or OOM

VectorJSON solves this:

```js
// VectorJSON streaming — O(n)
const parser = vectorjson.createParser();
for await (const chunk of stream) {
  const status = parser.feed(chunk);
  if (status === "complete") break;
}
const result = parser.getValue();
parser.destroy();
```

Each `feed()` processes only the new bytes — O(chunk_size) per call, O(n) total.

## Benchmark Results

### Stress Test: Concat+Reparse vs VectorJSON Stream

Simulating AI SDK streaming responses at increasing payload sizes (256-byte chunks):

| Payload | Concat+Reparse | VectorJSON Stream | Speedup |
|---------|---------------|-------------------|---------|
| 10 KB   | 0.9 ms        | 3.0 ms            | —       |
| 50 KB   | 22 ms         | 2.1 ms            | **10x** |
| 100 KB  | 64 ms         | 2.0 ms            | **31x** |
| 250 KB  | 293 ms        | 3.4 ms            | **87x** |
| 500 KB  | 804 ms        | 3.5 ms            | **229x** |
| 1 MB    | 2,648 ms      | 5.4 ms            | **488x** |
| 2 MB    | 9,386 ms      | 8.6 ms            | **1,092x** |

### Memory Pressure: 50 Sequential 100KB Responses

| Metric       | Concat+Reparse | VectorJSON Stream |
|-------------|---------------|-------------------|
| Total time   | 2,771 ms      | 49 ms             |
| Peak heap    | 189 MB        | 54 MB             |
| Heap growth  | 143 MB        | 37 MB             |

## Install

```bash
npm install vectorjson
```

## Quick Start

```js
import { init } from "vectorjson";

const vj = await init();

// Parse
const data = vj.parse('{"hello": "world"}');

// Stringify
const json = vj.stringify({ hello: "world" });

// Stream
const parser = vj.createParser();
parser.feed('{"hel');
parser.feed('lo": "wor');
parser.feed('ld"}');
const result = parser.getValue();
parser.destroy();

// Deep compare
const diffs = vj.deepCompare(
  { a: 1, b: 2 },
  { a: 1, b: 3 }
);
// [{ path: "$.b", type: "changed" }]

// Validate
const { valid, errors } = vj.validate(data, {
  type: "object",
  properties: { hello: { type: "string" } },
  required: ["hello"],
});
```

## API

### `init(options?): Promise<VectorJSON>`

Initialize VectorJSON. Call once; subsequent calls return the cached instance.

### `vj.parse(input: string | Uint8Array): unknown`

Parse a JSON string or byte array into a JS value. Throws `SyntaxError` on invalid JSON.

### `vj.stringify(value: unknown): string`

Stringify a JS value to a JSON string. Follows the same semantics as `JSON.stringify`:
- `undefined`, functions, symbols are omitted from objects
- `undefined` in arrays becomes `null`
- `NaN`, `Infinity`, `-Infinity` become `null`
- Calls `.toJSON()` when available
- Throws on `BigInt`

### `vj.createParser(): StreamingParser`

Create a streaming parser for incremental JSON parsing.

```ts
interface StreamingParser {
  feed(chunk: Uint8Array | string): FeedStatus;
  getValue(path?: string): unknown;
  getRemaining(): Uint8Array | null;
  getStatus(): FeedStatus;
  destroy(): void;
}

type FeedStatus = "incomplete" | "complete" | "error" | "end_early";
```

- `"incomplete"` — JSON not yet complete, feed more chunks
- `"complete"` — JSON fully parsed, call `getValue()`
- `"error"` — Parse error (invalid JSON)
- `"end_early"` — Complete JSON found with trailing data (useful for NDJSON)

### `vj.deepCompare(a, b, options?): DiffEntry[]`

Deep structural comparison of two values. Returns an array of differences.

```ts
interface DiffEntry {
  path: string;      // e.g. "$.items[0].name"
  type: DiffType;    // "changed" | "added" | "removed" | "type_changed"
}

// Options
{ ordered?: boolean }  // default: false (property order doesn't matter)
```

- **Unordered** (default): Like `fast-deep-equal` — `{a:1, b:2}` equals `{b:2, a:1}`
- **Ordered**: Property order matters — `{a:1, b:2}` ≠ `{b:2, a:1}`

### `vj.validate(data, schema): ValidationResult`

Validate data against a JSON Schema (draft-07/2020-12 subset).

```ts
interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

interface ValidationError {
  path: string;       // e.g. "$.user.age"
  message: string;    // e.g. "value is required"
}
```

**Supported keywords:**
- `type` (including union types like `["string", "null"]`)
- `properties`, `required`, `additionalProperties`
- `items`, `minItems`, `maxItems`
- `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`
- `minLength`, `maxLength`
- `enum`, `const`

### Convenience Exports

For simpler usage, async wrappers that auto-initialize:

```js
import { parse, stringify, deepCompare, validate } from "vectorjson";

const data = await parse('{"a": 1}');
const json = await stringify({ a: 1 });
const diffs = await deepCompare(a, b);
const result = await validate(data, schema);
```

## Architecture

```
JS bytes ──→ [WAT Bridge] ──→ [Zig + zimdjson SIMD] ──→ Tape (linear memory)
                  │                                          │
                  │         get_next_token() ←───────────────┘
                  │
                  ▼
            JS factory functions (createObject, setProperty, ...)
                  │
                  ▼
            Plain JS objects ──→ Your code
```

Two WASM modules:

1. **Zig Engine** (`wasm32-freestanding` + `simd128`) — SIMD-accelerated JSON parser using zimdjson. Parses bytes into an internal tape format.
2. **WAT Bridge** (handwritten WebAssembly Text) — Reads the tape and calls JS factory functions to build native JS objects.

## Building from Source

Requirements: [Zig](https://ziglang.org/) 0.15+, [wasm-tools](https://github.com/bytecodealliance/wasm-tools), Node.js 20+.

```bash
# Build everything
npm run build

# Build individual components
npm run build:zig      # Zig → engine.wasm
npm run build:wat      # WAT → bridge.wasm
npm run build:js       # TypeScript → JS

# Run tests
npm test
node test/phase3.mjs   # Stringify tests
node test/phase4.mjs   # Deep compare tests
node test/phase5.mjs   # Schema validation tests
node test/standards.mjs # Standards compliance tests

# Run benchmarks
npm run bench:parse     # Parse + streaming benchmarks
npm run bench:stringify # Stringify benchmarks
npm run bench:compare   # Deep compare benchmarks
npm run bench:stress    # O(n²) vs O(n) stress test
npm run bench:all       # All benchmarks
```

## License

MIT
