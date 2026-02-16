/**
 * AI SDK Partial JSON Parser Benchmark
 *
 * For EACH product: benchmarks original code vs patched-with-VectorJSON code.
 * Both run the same access pattern the product actually uses.
 *
 * Original (what they do today):
 *   buffer += chunk;
 *   result = theirParser(buffer);  // re-parse ENTIRE buffer every chunk → O(n²)
 *
 * Patched (swap in VectorJSON streaming):
 *   parser.feed(chunk);            // only new bytes scanned → O(n)
 *   result = parser.getValue();
 *
 * Usage: bun --expose-gc bench/ai-parsers/bench.mjs
 */

import { parsePartialJson as vercelParse } from "ai";
const { parsePartialJSON: tanstackParse } = await import(
  "./node_modules/@tanstack/ai/dist/esm/activities/chat/stream/json-parser.js"
);
import { parse as partialJsonParse } from "partial-json";
import { partialParse as anthropicParse } from "@anthropic-ai/sdk/_vendor/partial-json-parser/parser.mjs";
import { init as vjInit } from "../../dist/index.js";

// ── Helpers ──────────────────────────────────────────────

function forceGC() {
  if (typeof globalThis.gc === "function") { globalThis.gc(); globalThis.gc(); }
}

function formatTime(ms) {
  if (ms < 0.001) return (ms * 1e6).toFixed(0) + " ns";
  if (ms < 1) return (ms * 1e3).toFixed(1) + " µs";
  if (ms < 1000) return ms.toFixed(1) + " ms";
  return (ms / 1000).toFixed(2) + " s";
}

// ── Generate realistic AI streaming payload ──────────────

function generatePayload(targetKB) {
  const items = [];
  const targetBytes = targetKB * 1024;
  let currentSize = 20;
  let id = 1;
  while (currentSize < targetBytes) {
    const item = {
      id: id++, type: "analysis",
      title: `Section ${id}: Analysis of topic ${id % 50}`,
      content: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(
        Math.max(1, Math.floor((targetKB / 100) * 3))
      ),
      confidence: +(Math.random().toFixed(4)),
      tags: ["ai", "ml", `section-${id}`],
      metadata: { model: "gpt-4-turbo", tokens: Math.floor(Math.random() * 1000) + 100,
        latency_ms: +(Math.random() * 500).toFixed(2) },
    };
    currentSize += JSON.stringify(item).length + 1;
    items.push(item);
  }
  return JSON.stringify({ results: items });
}

// ── Simulate each product's ORIGINAL code path ──────────

/**
 * Vercel AI SDK / OpenCode original:
 *   for await (const chunk of stream) {
 *     buffer += chunk;
 *     result = await parsePartialJson(buffer);  // async, re-parse entire buffer
 *   }
 */
async function benchVercelOriginal(fullJson, chunkSize, { warmup = 2, runs = 3 } = {}) {
  const prefixes = buildPrefixes(fullJson, chunkSize);
  for (let w = 0; w < warmup; w++) {
    for (const p of prefixes) await vercelParse(p);
  }
  forceGC();
  const times = [];
  for (let r = 0; r < runs; r++) {
    const start = performance.now();
    for (const p of prefixes) await vercelParse(p);
    times.push(performance.now() - start);
  }
  forceGC();
  return median(times);
}

/**
 * TanStack AI original:
 *   for await (const chunk of stream) {
 *     buffer += chunk;
 *     result = parsePartialJSON(buffer);  // wraps partial-json, re-parse entire buffer
 *   }
 */
function benchTanstackOriginal(fullJson, chunkSize, { warmup = 2, runs = 3 } = {}) {
  const prefixes = buildPrefixes(fullJson, chunkSize);
  for (let w = 0; w < warmup; w++) {
    for (const p of prefixes) tanstackParse(p);
  }
  forceGC();
  const times = [];
  for (let r = 0; r < runs; r++) {
    const start = performance.now();
    for (const p of prefixes) tanstackParse(p);
    times.push(performance.now() - start);
  }
  forceGC();
  return median(times);
}

/**
 * OpenClaw original (pi-ai → parseStreamingJson):
 *   block.partialJson += event.delta.partial_json;
 *   block.arguments = parseStreamingJson(block.partialJson);
 *   // parseStreamingJson = try JSON.parse, fallback to partial-json parse()
 */
function benchOpenClawOriginal(fullJson, chunkSize, { warmup = 2, runs = 3 } = {}) {
  const prefixes = buildPrefixes(fullJson, chunkSize);
  // Simulate parseStreamingJson: try JSON.parse first, fallback to partial-json
  const parseStreamingJson = (s) => {
    try { return JSON.parse(s); } catch { return partialJsonParse(s); }
  };
  for (let w = 0; w < warmup; w++) {
    for (const p of prefixes) parseStreamingJson(p);
  }
  forceGC();
  const times = [];
  for (let r = 0; r < runs; r++) {
    const start = performance.now();
    for (const p of prefixes) parseStreamingJson(p);
    times.push(performance.now() - start);
  }
  forceGC();
  return median(times);
}

/**
 * Anthropic SDK / Claude Code original:
 *   block.partialJson += event.delta.partial_json;
 *   block.arguments = partialParse(block.partialJson);  // vendored tokenizer parser
 */
function benchAnthropicOriginal(fullJson, chunkSize, { warmup = 2, runs = 3 } = {}) {
  const prefixes = buildPrefixes(fullJson, chunkSize);
  for (let w = 0; w < warmup; w++) {
    for (const p of prefixes) anthropicParse(p);
  }
  forceGC();
  const times = [];
  for (let r = 0; r < runs; r++) {
    const start = performance.now();
    for (const p of prefixes) anthropicParse(p);
    times.push(performance.now() - start);
  }
  forceGC();
  return median(times);
}

// ── Simulate each product's PATCHED code path (with VectorJSON) ──

/**
 * Vercel AI SDK patched with VectorJSON:
 *   const parser = vj.createParser();
 *   for await (const chunk of stream) {
 *     const s = parser.feed(chunk);             // only new bytes
 *     if (s === "complete" || s === "end_early") break;
 *   }
 *   result = vj.materialize(parser.getValue());  // one-shot materialization
 *   parser.destroy();
 */
function benchVercelPatched(vj, fullJson, chunkSize, opts) {
  return benchVjStream(vj, fullJson, chunkSize, opts);
}

/** TanStack AI patched: same streaming replacement */
function benchTanstackPatched(vj, fullJson, chunkSize, opts) {
  return benchVjStream(vj, fullJson, chunkSize, opts);
}

/** OpenClaw patched: same streaming replacement */
function benchOpenClawPatched(vj, fullJson, chunkSize, opts) {
  return benchVjStream(vj, fullJson, chunkSize, opts);
}

/** Anthropic SDK patched: same streaming replacement */
function benchAnthropicPatched(vj, fullJson, chunkSize, opts) {
  return benchVjStream(vj, fullJson, chunkSize, opts);
}

/** Claude Code patched: same streaming replacement */
function benchClaudeCodePatched(vj, fullJson, chunkSize, opts) {
  return benchVjStream(vj, fullJson, chunkSize, opts);
}

/** OpenCode patched: same streaming replacement */
function benchOpenCodePatched(vj, fullJson, chunkSize, opts) {
  return benchVjStream(vj, fullJson, chunkSize, opts);
}

// ── Shared VectorJSON streaming benchmark ────────────────

function benchVjStream(vj, fullJson, chunkSize, { warmup = 2, runs = 3 } = {}) {
  const chunks = buildChunks(fullJson, chunkSize);
  for (let w = 0; w < warmup; w++) {
    const parser = vj.createParser();
    for (const c of chunks) { const s = parser.feed(c); if (s === "complete" || s === "end_early") break; }
    try { vj.materialize(parser.getValue()); } catch {}
    parser.destroy();
  }
  forceGC();
  const times = [];
  for (let r = 0; r < runs; r++) {
    const start = performance.now();
    const parser = vj.createParser();
    for (const c of chunks) { const s = parser.feed(c); if (s === "complete" || s === "end_early") break; }
    const val = parser.getValue();
    if (val && typeof val === "object") vj.materialize(val);
    parser.destroy();
    times.push(performance.now() - start);
  }
  forceGC();
  return median(times);
}

// ── Utils ────────────────────────────────────────────────

/** Build accumulated prefixes (what O(n²) parsers see on each chunk) */
function buildPrefixes(fullJson, chunkSize) {
  const prefixes = [];
  for (let i = chunkSize; i < fullJson.length; i += chunkSize) prefixes.push(fullJson.slice(0, i));
  prefixes.push(fullJson);
  return prefixes;
}

/** Build actual chunks (what O(n) streaming sees) */
function buildChunks(fullJson, chunkSize) {
  const chunks = [];
  for (let i = 0; i < fullJson.length; i += chunkSize) chunks.push(fullJson.slice(i, i + chunkSize));
  return chunks;
}

function median(times) {
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  const vj = await vjInit();

  const products = [
    {
      name: "Vercel AI SDK",
      parser: "fixJson + JSON.parse",
      original: (json, cs, opts) => benchVercelOriginal(json, cs, opts),
      patched: (json, cs, opts) => benchVercelPatched(vj, json, cs, opts),
      isAsync: true,
    },
    {
      name: "OpenCode",
      parser: "= Vercel AI SDK",
      original: (json, cs, opts) => benchVercelOriginal(json, cs, opts),
      patched: (json, cs, opts) => benchOpenCodePatched(vj, json, cs, opts),
      isAsync: true,
    },
    {
      name: "TanStack AI",
      parser: "partial-json npm",
      original: (json, cs, opts) => benchTanstackOriginal(json, cs, opts),
      patched: (json, cs, opts) => benchTanstackPatched(vj, json, cs, opts),
      isAsync: false,
    },
    {
      name: "OpenClaw",
      parser: "pi-ai → partial-json",
      original: (json, cs, opts) => benchOpenClawOriginal(json, cs, opts),
      patched: (json, cs, opts) => benchOpenClawPatched(vj, json, cs, opts),
      isAsync: false,
    },
    {
      name: "Anthropic SDK",
      parser: "partial-json-parser",
      original: (json, cs, opts) => benchAnthropicOriginal(json, cs, opts),
      patched: (json, cs, opts) => benchAnthropicPatched(vj, json, cs, opts),
      isAsync: false,
    },
    {
      name: "Claude Code",
      parser: "= Anthropic SDK",
      original: (json, cs, opts) => benchAnthropicOriginal(json, cs, opts),
      patched: (json, cs, opts) => benchClaudeCodePatched(vj, json, cs, opts),
      isAsync: false,
    },
  ];

  console.log("╔══════════════════════════════════════════════════════════════════════════════╗");
  console.log("║   AI SDK Partial JSON Parser Benchmark                                      ║");
  console.log("║                                                                              ║");
  console.log("║   For EACH product: original code path vs patched with VectorJSON.           ║");
  console.log("║                                                                              ║");
  console.log("║   Original: buffer += chunk; result = parse(buffer)  ← O(n²) re-parse       ║");
  console.log("║   Patched:  parser.feed(chunk)                       ← O(n) new bytes only  ║");
  console.log("║                                                                              ║");
  console.log("║   ~12 chars/chunk (typical LLM token size).                                  ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════════╝");
  console.log();

  const sizes = [1, 5, 10, 50, 100];
  const chunkSize = 12;

  for (const sizeKB of sizes) {
    const fullJson = generatePayload(sizeKB);
    const actualKB = (fullJson.length / 1024).toFixed(0);
    const numChunks = Math.ceil(fullJson.length / chunkSize);
    const skipAsync = numChunks > 10000;

    console.log(`\n${"─".repeat(84)}`);
    console.log(`  Payload: ${actualKB} KB  │  Chunks: ${numChunks}  │  ~${chunkSize} chars/chunk`);
    console.log(`${"─".repeat(84)}`);
    console.log(`  ${"Product".padEnd(18)} ${"Original".padStart(12)} ${"+ VectorJSON".padStart(12)} ${"Speedup".padStart(10)}  ${"Original Parser"}`);
    console.log(`  ${"─".repeat(80)}`);

    for (const p of products) {
      if (skipAsync && p.isAsync) {
        console.log(`  ${p.name.padEnd(18)} ${"(too slow)".padStart(12)} ${"—".padStart(12)} ${"".padStart(10)}  ${p.parser}`);
        continue;
      }

      const origTime = await p.original(fullJson, chunkSize);
      const patchedTime = p.patched(fullJson, chunkSize);
      const speedup = (origTime / patchedTime).toFixed(0);

      console.log(
        `  ${p.name.padEnd(18)} ${formatTime(origTime).padStart(12)} ${formatTime(patchedTime).padStart(12)} ${(speedup + "×").padStart(10)}  ${p.parser}`
      );
    }
  }

  console.log(`\n${"═".repeat(84)}`);
  console.log(`  What each product does today → what VectorJSON replaces it with:`);
  console.log(`  ${"─".repeat(80)}`);
  console.log(`  Vercel AI SDK   buffer += chunk; parsePartialJson(buffer)     → parser.feed(chunk)`);
  console.log(`  OpenCode        buffer += chunk; parsePartialJson(buffer)     → parser.feed(chunk)`);
  console.log(`  TanStack AI     buffer += chunk; parsePartialJSON(buffer)     → parser.feed(chunk)`);
  console.log(`  OpenClaw        partialJson += delta; parseStreamingJson(buf) → parser.feed(chunk)`);
  console.log(`  Anthropic SDK   partialJson += delta; partialParse(buf)       → parser.feed(chunk)`);
  console.log(`  Claude Code     partialJson += delta; partialParse(buf)       → parser.feed(chunk)`);
  console.log(`${"═".repeat(84)}\n`);
}

main().catch(console.error);
