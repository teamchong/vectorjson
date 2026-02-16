/**
 * AI SDK Partial JSON Parser Benchmark
 *
 * Compares the actual partial-JSON parsers used by major AI products:
 *
 *   Product → Parser
 *   ─────────────────────────────────────────────────────────────
 *   Vercel AI SDK    → fixJson + JSON.parse (ai@6)
 *   OpenCode         → Vercel AI SDK (uses streamText() internally)
 *   TanStack AI      → partial-json npm package
 *   Anthropic SDK    → vendored partial-json-parser (tokenizer)
 *   Claude Code      → Anthropic SDK (uses vendored parser internally)
 *   VectorJSON       → createParser().feed() WASM SIMD stream
 *
 * Scenario: Simulates a streaming LLM tool call that generates a JSON object
 * token-by-token. Each "chunk" appends ~12 chars. The parser is called after
 * EVERY chunk (this is what AI SDKs actually do for tool_use streaming).
 *
 * The O(n²) problem: naive parsers re-parse the entire accumulated string
 * on every chunk. For N chunks of average size C:
 *   - Naive: O(N × N×C) = O(N²C) total work
 *   - Streaming: O(NC) total work
 *
 * Usage: bun --expose-gc bench/ai-parsers/bench.mjs
 */

import { parsePartialJson as vercelParse } from "ai";
// TanStack AI uses partial-json internally — import directly from file path
const { parsePartialJSON: tanstackParse } = await import(
  "./node_modules/@tanstack/ai/dist/esm/activities/chat/stream/json-parser.js"
);
import { parse as partialJsonParse } from "partial-json";
import { partialParse as anthropicParse } from "@anthropic-ai/sdk/_vendor/partial-json-parser/parser.mjs";
import { init as vjInit } from "../../dist/index.js";

// ── Helpers ──────────────────────────────────────────────

function forceGC() {
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
    globalThis.gc();
  }
}

function heapMB() {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

function formatTime(ms) {
  if (ms < 0.001) return (ms * 1e6).toFixed(0) + " ns";
  if (ms < 1) return (ms * 1e3).toFixed(1) + " µs";
  return ms.toFixed(2) + " ms";
}

// ── Generate realistic AI streaming payload ──────────────
// Simulates an LLM generating a structured JSON response token by token

function generatePayload(targetKB) {
  const items = [];
  const targetBytes = targetKB * 1024;
  let currentSize = 20; // opening overhead
  let id = 1;

  while (currentSize < targetBytes) {
    const item = {
      id: id++,
      type: "analysis",
      title: `Section ${id}: Analysis of topic ${id % 50}`,
      content: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(
        Math.max(1, Math.floor((targetKB / 100) * 3))
      ),
      confidence: +(Math.random().toFixed(4)),
      tags: ["ai", "ml", `section-${id}`],
      metadata: {
        model: "gpt-4-turbo",
        tokens: Math.floor(Math.random() * 1000) + 100,
        latency_ms: +(Math.random() * 500).toFixed(2),
      },
    };
    const itemJson = JSON.stringify(item);
    currentSize += itemJson.length + 1;
    items.push(item);
  }

  return JSON.stringify({ results: items });
}

/**
 * Simulate streaming: split a complete JSON string into chunks of ~chunkSize chars.
 * Returns array of accumulated prefixes (what the parser sees after each chunk).
 */
function simulateStream(fullJson, chunkSize = 12) {
  const prefixes = [];
  for (let i = chunkSize; i < fullJson.length; i += chunkSize) {
    prefixes.push(fullJson.slice(0, i));
  }
  prefixes.push(fullJson); // final complete chunk
  return prefixes;
}

// ── Benchmark runner (O(n²) parsers) ─────────────────────

async function benchStream(name, parseFn, prefixes, { warmup = 3, runs = 5 } = {}) {
  // Warmup
  for (let w = 0; w < warmup; w++) {
    for (const prefix of prefixes) {
      await parseFn(prefix);
    }
  }

  forceGC();
  const heapBefore = heapMB();

  const times = [];
  for (let r = 0; r < runs; r++) {
    const start = performance.now();
    for (const prefix of prefixes) {
      await parseFn(prefix);
    }
    times.push(performance.now() - start);
  }

  forceGC();
  const heapAfter = heapMB();

  const sorted = times.sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const perChunk = mean / prefixes.length;

  return { name, median, mean, perChunk, heapDelta: heapAfter - heapBefore, chunks: prefixes.length };
}

// ── VectorJSON createParser() benchmark — truly incremental, O(N) total ──

function benchVectorJsonCreateParser(vj, fullJson, chunkSize, { warmup = 3, runs = 5 } = {}) {
  // Split into actual chunks (not accumulated prefixes — that's the point!)
  const chunks = [];
  for (let i = 0; i < fullJson.length; i += chunkSize) {
    chunks.push(fullJson.slice(i, i + chunkSize));
  }

  // Warmup
  for (let w = 0; w < warmup; w++) {
    const parser = vj.createParser();
    for (const chunk of chunks) {
      const s = parser.feed(chunk);
      if (s === "complete" || s === "end_early") break;
    }
    try { parser.getValue(); } catch {}
    parser.destroy();
  }

  forceGC();
  const heapBefore = heapMB();

  const times = [];
  for (let r = 0; r < runs; r++) {
    const start = performance.now();
    const parser = vj.createParser();
    for (const chunk of chunks) {
      const s = parser.feed(chunk);
      if (s === "complete" || s === "end_early") break;
    }
    const val = parser.getValue();
    // Materialize the value to be fair (other parsers return plain objects)
    if (val && typeof val === "object") {
      vj.materialize(val);
    }
    parser.destroy();
    times.push(performance.now() - start);
  }

  forceGC();
  const heapAfter = heapMB();

  const sorted = times.sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = times.reduce((a, b) => a + b, 0) / times.length;

  return { name: "⚡ VectorJSON (stream)", median, mean, perChunk: mean / chunks.length, heapDelta: heapAfter - heapBefore, chunks: chunks.length };
}

// ── JSON.parse baseline (only on complete, for reference) ──

function benchJsonParse(fullJson, { warmup = 3, runs = 5 } = {}) {
  for (let w = 0; w < warmup; w++) {
    JSON.parse(fullJson);
  }

  forceGC();
  const heapBefore = heapMB();

  const times = [];
  for (let r = 0; r < runs; r++) {
    const start = performance.now();
    JSON.parse(fullJson);
    times.push(performance.now() - start);
  }

  forceGC();
  const heapAfter = heapMB();

  const sorted = times.sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = times.reduce((a, b) => a + b, 0) / times.length;

  return { name: "JSON.parse (1× complete)", median, mean, perChunk: mean, heapDelta: heapAfter - heapBefore, chunks: 1 };
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  const vj = await vjInit();

  console.log("╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║   AI SDK Partial JSON Parser Benchmark                              ║");
  console.log("║                                                                      ║");
  console.log("║   Scenario: LLM streams tool_use JSON (~12 chars/chunk).            ║");
  console.log("║   Parser is called after EVERY chunk (what AI SDKs actually do).    ║");
  console.log("║                                                                      ║");
  console.log("║   Product            Parser                          Complexity      ║");
  console.log("║   ────────────────── ─────────────────────────────── ─────────────   ║");
  console.log("║   Vercel AI SDK      fixJson + JSON.parse            O(n²)           ║");
  console.log("║   OpenCode           ↳ uses Vercel AI SDK            O(n²)           ║");
  console.log("║   TanStack AI        partial-json (npm)              O(n²)           ║");
  console.log("║   Anthropic SDK      vendored partial-json-parser    O(n²)           ║");
  console.log("║   Claude Code        ↳ uses Anthropic SDK            O(n²)           ║");
  console.log("║   VectorJSON         createParser().feed() SIMD      O(n)            ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝");
  console.log();

  const sizes = [1, 5, 10, 50, 100];

  for (const sizeKB of sizes) {
    const fullJson = generatePayload(sizeKB);
    const actualKB = (fullJson.length / 1024).toFixed(1);
    const prefixes = simulateStream(fullJson, 12);

    console.log(`\n${"─".repeat(74)}`);
    console.log(`  Payload: ${actualKB} KB  │  Chunks: ${prefixes.length}  │  ~12 chars/chunk`);
    console.log(`${"─".repeat(74)}`);
    console.log(`  ${"Product".padEnd(32)} ${"Parser".padEnd(16)} ${"Total".padStart(10)} ${"Per-chunk".padStart(12)} ${"Heap Δ".padStart(10)}`);
    console.log(`  ${"─".repeat(72)}`);

    const results = [];

    // 1. Vercel AI SDK (async — parsePartialJson returns Promise)
    //    Also used by: OpenCode (TypeScript rewrite uses streamText() from ai)
    if (prefixes.length <= 10000) {
      results.push(await benchStream("Vercel AI SDK", (s) => vercelParse(s), prefixes, { warmup: 2, runs: 3 }));
    } else {
      results.push({ name: "Vercel AI SDK", median: NaN, mean: NaN, perChunk: NaN, heapDelta: 0, chunks: prefixes.length, skipped: true });
    }

    // 2. OpenCode (TypeScript rewrite uses Vercel AI SDK streamText() internally)
    //    Same parser as Vercel — shown separately so each product has its own row
    if (prefixes.length <= 10000) {
      results.push(await benchStream("OpenCode", (s) => vercelParse(s), prefixes, { warmup: 2, runs: 3 }));
    } else {
      results.push({ name: "OpenCode", median: NaN, mean: NaN, perChunk: NaN, heapDelta: 0, chunks: prefixes.length, skipped: true });
    }

    // 3. TanStack AI (wraps partial-json internally)
    results.push(await benchStream("TanStack AI", (s) => tanstackParse(s), prefixes));

    // 3. partial-json (the actual lib TanStack uses under the hood)
    results.push(await benchStream("partial-json", (s) => partialJsonParse(s), prefixes));

    // 5. Anthropic SDK (vendored tokenizer-based partial-json-parser, O(n²))
    results.push(await benchStream("Anthropic SDK", (s) => anthropicParse(s), prefixes));

    // 6. Claude Code (uses Anthropic SDK's partialParse on every input_json_delta)
    //    Same parser as Anthropic — shown separately so each product has its own row
    results.push(await benchStream("Claude Code", (s) => anthropicParse(s), prefixes));

    // 7. VectorJSON createParser() — truly incremental, O(N) total
    results.push(benchVectorJsonCreateParser(vj, fullJson, 12));

    // 6. JSON.parse baseline (single complete parse)
    results.push(benchJsonParse(fullJson));

    // Map parser names to underlying parser
    const usedBy = {
      "Vercel AI SDK":        "fixJson+parse",
      "OpenCode":             "= Vercel AI",
      "TanStack AI":          "partial-json",
      "partial-json":         "(lib)",
      "Anthropic SDK":        "tokenizer",
      "Claude Code":          "= Anthropic",
      "⚡ VectorJSON (stream)": "WASM SIMD",
      "JSON.parse (1× complete)": "(baseline)",
    };

    for (const r of results) {
      if (r.skipped) {
        const who = (usedBy[r.name] || "").padEnd(16);
        console.log(`  ${r.name.padEnd(32)} ${who} ${"(skipped)".padStart(10)}`);
        continue;
      }
      const who = (usedBy[r.name] || "").padEnd(16);
      const total = formatTime(r.mean).padStart(10);
      const perChunk = formatTime(r.perChunk).padStart(12);
      const heap = `${r.heapDelta >= 0 ? "+" : ""}${r.heapDelta.toFixed(1)} MB`.padStart(10);
      console.log(`  ${r.name.padEnd(32)} ${who} ${total} ${perChunk} ${heap}`);
    }

    // Show speedup of VectorJSON stream vs O(n²) parsers
    const o2Parsers = results.filter(r => !r.skipped && ["partial-json", "TanStack AI", "Vercel AI SDK", "OpenCode", "Anthropic SDK", "Claude Code"].includes(r.name));
    const vjStream = results.find(r => r.name === "⚡ VectorJSON (stream)");
    if (vjStream && o2Parsers.length > 0) {
      const slowest = o2Parsers.reduce((a, b) => (a.mean > b.mean ? a : b));
      const fastest = o2Parsers.reduce((a, b) => (a.mean < b.mean ? a : b));
      const speedupSlow = (slowest.mean / vjStream.mean).toFixed(1);
      const speedupFast = (fastest.mean / vjStream.mean).toFixed(1);
      console.log(`\n  ⚡ VectorJSON stream: ${speedupFast}–${speedupSlow}× faster than every AI SDK`);
    }
  }

  console.log(`\n${"═".repeat(74)}`);
  console.log(`  How each product parses streaming tool_use JSON:`);
  console.log(`  ${"─".repeat(70)}`);
  console.log(`  Vercel AI SDK  → fixJson() repair pass + JSON.parse, per chunk (O(n²))`);
  console.log(`  OpenCode       → delegates to Vercel AI SDK streamText() (same parser)`);
  console.log(`  TanStack AI    → wraps partial-json npm (O(n²) re-parse per chunk)`);
  console.log(`  Anthropic SDK  → tokenize→strip→unstrip→generate→JSON.parse (O(n²))`);
  console.log(`  Claude Code    → uses Anthropic SDK partialParse on input_json_delta`);
  console.log(`  VectorJSON     → createParser().feed() — O(n) total, WASM SIMD skip`);
  console.log(`  JSON.parse     → single complete parse, no partial support (baseline)`);
  console.log(`${"═".repeat(74)}\n`);
}

main().catch(console.error);
