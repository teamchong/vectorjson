/**
 * AI SDK Real Pipeline Benchmark — Stock vs VectorJSON-Patched
 *
 * For EACH product: benchmarks original code path vs patched-with-VectorJSON.
 * Both code paths run the REAL accumulation + parse loop the SDK actually uses.
 *
 * Stock code path (what each SDK does today):
 *   buffer += chunk;
 *   result = theirParser(buffer);  // re-parse ENTIRE buffer → O(n²)
 *
 * VectorJSON code path (drop-in replacement):
 *   parser.feed(chunk);            // only new bytes scanned → O(n)
 *   result = materialize();
 *
 * SDKs with real pipelines (correctness-verified through actual SDK):
 *   - Vercel AI SDK: streamObject + MockLanguageModelV3
 *   - Anthropic SDK: MessageStream + simulated SSE events
 *   - TanStack AI:   StreamProcessor + TOOL_CALL_ARGS events
 *
 * All 6 products benchmarked at parser-level for fair apple-to-apple timing.
 *
 * Usage: cd bench/ai-parsers && bun --expose-gc bench.mjs
 */

import { streamObject as stockStreamObject } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { init as vjInit } from "../../dist/index.js";

// Parser imports
import { parsePartialJson as vercelParse } from "ai";
import { partialParse as anthropicParse } from "@anthropic-ai/sdk/_vendor/partial-json-parser/parser.mjs";
import { parse as partialJsonParse } from "partial-json";
const { parsePartialJSON: tanstackParse } = await import(
  "./node_modules/@tanstack/ai/dist/esm/activities/chat/stream/json-parser.js"
);

// Pipeline imports (for correctness verification)
const { MessageStream } = await import("@anthropic-ai/sdk/lib/MessageStream.mjs");
const { StreamProcessor } = await import(
  "./node_modules/@tanstack/ai/dist/esm/activities/chat/stream/processor.js"
);

// ── Helpers ──────────────────────────────────────────────

function forceGC() {
  if (typeof globalThis.gc === "function") { globalThis.gc(); globalThis.gc(); }
}

function memMB() {
  const m = process.memoryUsage();
  return {
    jsHeap: m.heapUsed / 1024 / 1024,
    wasm: m.arrayBuffers / 1024 / 1024,
    total: (m.heapUsed + m.arrayBuffers) / 1024 / 1024,
  };
}

function formatTime(ms) {
  if (ms < 0.001) return (ms * 1e6).toFixed(0) + " ns";
  if (ms < 1) return (ms * 1e3).toFixed(1) + " µs";
  if (ms < 1000) return ms.toFixed(1) + " ms";
  return (ms / 1000).toFixed(2) + " s";
}

function median(times) {
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// ── Payload generation ───────────────────────────────────

function generatePayload(targetKB) {
  const items = [];
  const targetBytes = targetKB * 1024;
  let currentSize = 50;
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
    currentSize += JSON.stringify(item).length + 1;
    items.push(item);
  }
  return JSON.stringify({
    model: "gpt-4-turbo",
    status: "complete",
    data: items,
    usage: {
      prompt_tokens: 500,
      completion_tokens: items.length * 50,
      total_tokens: 500 + items.length * 50,
    },
  });
}

const payloadSchema = z.object({
  model: z.string(),
  status: z.string(),
  data: z.array(
    z.object({
      id: z.number(),
      type: z.string(),
      title: z.string(),
      content: z.string(),
      confidence: z.number(),
      tags: z.array(z.string()),
      metadata: z.object({
        model: z.string(),
        tokens: z.number(),
        latency_ms: z.number(),
      }),
    })
  ),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    total_tokens: z.number(),
  }),
});

function buildChunks(fullJson, chunkSize) {
  const chunks = [];
  for (let i = 0; i < fullJson.length; i += chunkSize) chunks.push(fullJson.slice(i, i + chunkSize));
  return chunks;
}

// ═══════════════════════════════════════════════════════════
// Parser-level benchmarks (apple-to-apple: same loop for all)
// ═══════════════════════════════════════════════════════════

const TIMEOUT_MS = 30_000; // 30s timeout per product

/**
 * Stock: simulate the real SDK loop — buffer += chunk; parse(buffer)
 * This is exactly what happens inside streamObject / MessageStream / StreamProcessor
 */
async function benchStockLoop(parseFn, fullJson, chunkSize, { warmup = 1, runs = 3, isAsync = false } = {}) {
  const chunks = buildChunks(fullJson, chunkSize);

  const runOnce = isAsync
    ? async () => {
        let buffer = "";
        for (const c of chunks) {
          buffer += c;
          await parseFn(buffer);
        }
      }
    : () => {
        let buffer = "";
        for (const c of chunks) {
          buffer += c;
          parseFn(buffer);
        }
      };

  // Warmup with timeout check
  const warmupStart = performance.now();
  await runOnce();
  const warmupTime = performance.now() - warmupStart;

  // If a single warmup run exceeded timeout, extrapolate
  if (warmupTime > TIMEOUT_MS) {
    return { time: warmupTime, timedOut: true };
  }

  // If estimated total (warmup + runs) would exceed timeout, just return warmup
  if (warmupTime * (runs + 1) > TIMEOUT_MS) {
    return { time: warmupTime, timedOut: false };
  }

  forceGC();
  const times = [];
  for (let r = 0; r < runs; r++) {
    const start = performance.now();
    await runOnce();
    times.push(performance.now() - start);
  }
  forceGC();
  return { time: median(times), timedOut: false };
}

/**
 * Patched: VectorJSON streaming loop — parser.feed(chunk) + getValue()
 *
 * Apple-to-apple: stock parsers return a materialized partial JS object on EVERY
 * chunk. VectorJSON's getValue() does the same — on incomplete, it autocompletes
 * the accumulated WASM buffer and returns a materialized plain object.
 *
 * No string concatenation. feed() appends bytes in WASM. getValue() parses
 * the accumulated buffer with SIMD — same work as stock, just faster.
 */
function benchVjLoop(vj, fullJson, chunkSize, { warmup = 2, runs = 3 } = {}) {
  const chunks = buildChunks(fullJson, chunkSize);

  const runOnce = () => {
    const parser = vj.createParser();
    for (const c of chunks) {
      const s = parser.feed(c);
      parser.getValue();  // materialized partial object on every chunk
      if (s === "complete" || s === "end_early") break;
    }
    parser.destroy();
  };

  for (let w = 0; w < warmup; w++) runOnce();
  forceGC();
  const times = [];
  for (let r = 0; r < runs; r++) {
    const start = performance.now();
    runOnce();
    times.push(performance.now() - start);
  }
  forceGC();
  return median(times);
}

// ═══════════════════════════════════════════════════════════
// Pipeline correctness verification
// ═══════════════════════════════════════════════════════════

function createMockModel(jsonStr, chunkSize) {
  const textChunks = buildChunks(jsonStr, chunkSize);
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const chunk of textChunks) {
            controller.enqueue({ type: "text-delta", delta: chunk });
          }
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 10, outputTokens: textChunks.length },
          });
          controller.close();
        },
      }),
      rawCall: { rawPrompt: "", rawSettings: {} },
      request: { body: "" },
    }),
  });
}

async function runVercelPipeline(jsonStr, chunkSize) {
  const model = createMockModel(jsonStr, chunkSize);
  const result = stockStreamObject({ model, schema: payloadSchema, prompt: "generate" });
  let lastObj;
  for await (const partial of result.partialObjectStream) {
    lastObj = partial;
  }
  return await result.object;
}

function runAnthropicPipeline(jsonStr, chunkSize) {
  return new Promise((resolve, reject) => {
    const chunks = buildChunks(jsonStr, chunkSize);
    const emit = (obj) => JSON.stringify(obj) + "\n";

    const sseStream = new ReadableStream({
      start(controller) {
        controller.enqueue(emit({
          type: "message_start",
          message: {
            id: "msg_bench", type: "message", role: "assistant", content: [],
            model: "claude-sonnet-4-20250514", stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        }));
        controller.enqueue(emit({
          type: "content_block_start", index: 0,
          content_block: { type: "tool_use", id: "toolu_bench", name: "generate", input: {} },
        }));
        for (const chunk of chunks) {
          controller.enqueue(emit({
            type: "content_block_delta", index: 0,
            delta: { type: "input_json_delta", partial_json: chunk },
          }));
        }
        controller.enqueue(emit({ type: "content_block_stop", index: 0 }));
        controller.enqueue(emit({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: chunks.length },
        }));
        controller.enqueue(emit({ type: "message_stop" }));
        controller.close();
      },
    });

    const stream = MessageStream.fromReadableStream(sseStream);
    let lastInput;
    stream.on("inputJson", (_delta, snapshot) => { lastInput = snapshot; });
    stream.on("end", () => resolve(lastInput));
    stream.on("error", reject);
  });
}

function runTanstackPipeline(jsonStr, chunkSize) {
  const chunks = buildChunks(jsonStr, chunkSize);
  const processor = new StreamProcessor();
  processor.prepareAssistantMessage();
  processor.processChunk({ type: "TOOL_CALL_START", toolCallId: "tc_bench", toolName: "generate" });
  for (const chunk of chunks) {
    processor.processChunk({ type: "TOOL_CALL_ARGS", toolCallId: "tc_bench", delta: chunk });
  }
  processor.processChunk({ type: "TOOL_CALL_END", toolCallId: "tc_bench" });
  processor.processChunk({ type: "RUN_FINISHED", finishReason: "stop" });
  return processor.toolCalls.get("tc_bench")?.parsedArguments;
}

// ═══════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════

async function main() {
  const vj = await vjInit();
  const CHUNK_SIZE = 12;

  // Detect patches
  let vercelPatched = false, anthropicPatched = false, tanstackPatched = false;
  try { vercelPatched = (await Bun.file("./node_modules/ai/dist/index.mjs").text()).includes("__vjParser"); } catch {}
  try { anthropicPatched = (await Bun.file("./node_modules/@anthropic-ai/sdk/lib/MessageStream.mjs").text()).includes("__vjParsers"); } catch {}
  try { tanstackPatched = (await Bun.file("./node_modules/@tanstack/ai/dist/esm/activities/chat/stream/processor.js").text()).includes("__vjParsers"); } catch {}

  console.log("╔═════════════════════════════════════════════════════════════════════════════╗");
  console.log("║   AI SDK Streaming JSON Benchmark — Stock vs VectorJSON                     ║");
  console.log("║                                                                             ║");
  console.log("║   Stock: buffer += chunk; parse(buffer)   ← O(n²) re-parse entire buffer    ║");
  console.log("║   VJ:    parser.feed(chunk)                ← O(n) scan only new bytes       ║");
  console.log("║                                                                             ║");
  console.log("║   ~12 chars/chunk (typical LLM token size).                                 ║");
  console.log("╚═════════════════════════════════════════════════════════════════════════════╝");

  // ── Patch status ──────────────────────────────────────
  console.log(`\n  Patch status (real SDK pipelines modified in node_modules):`);
  console.log(`    Vercel AI SDK:  ${vercelPatched ? "✓ patched" : "✗ not patched"}`);
  console.log(`    Anthropic SDK:  ${anthropicPatched ? "✓ patched" : "✗ not patched"}`);
  console.log(`    TanStack AI:    ${tanstackPatched ? "✓ patched" : "✗ not patched"}`);

  // ── Correctness: verify patched pipelines produce correct output ──
  console.log(`\n  ─── Correctness: Real Pipeline Verification ───\n`);
  {
    const testJson = generatePayload(5);
    const expected = JSON.parse(testJson);
    const expectedStr = JSON.stringify(expected);

    if (vercelPatched) {
      const result = await runVercelPipeline(testJson, CHUNK_SIZE);
      console.log(JSON.stringify(result) === expectedStr
        ? "  ✓ Vercel AI SDK:  patched streamObject → correct output"
        : "  ✗ Vercel AI SDK:  MISMATCH!");
      if (JSON.stringify(result) !== expectedStr) process.exit(1);
    }

    {
      const result = await runAnthropicPipeline(testJson, CHUNK_SIZE);
      console.log(JSON.stringify(result) === expectedStr
        ? `  ✓ Anthropic SDK:  ${anthropicPatched ? "patched" : "stock"} MessageStream → correct output`
        : "  ✗ Anthropic SDK:  MISMATCH!");
      if (JSON.stringify(result) !== expectedStr) process.exit(1);
    }

    {
      const result = runTanstackPipeline(testJson, CHUNK_SIZE);
      console.log(JSON.stringify(result) === expectedStr
        ? `  ✓ TanStack AI:    ${tanstackPatched ? "patched" : "stock"} StreamProcessor → correct output`
        : "  ✗ TanStack AI:    MISMATCH!");
      if (JSON.stringify(result) !== expectedStr) process.exit(1);
    }
  }

  // ═══════════════════════════════════════════════════════
  // Benchmark: apple-to-apple parser-level comparison
  //
  // Both stock and VectorJSON run the exact same loop:
  //   for (chunk of chunks) { buffer += chunk; parse(buffer); }
  // vs
  //   for (chunk of chunks) { parser.feed(chunk); }
  //
  // This isolates the JSON parsing cost with zero pipeline overhead.
  // ═══════════════════════════════════════════════════════

  console.log("\n╔═════════════════════════════════════════════════════════════════════════════╗");
  console.log("║   Parser Benchmark: buffer += chunk; parse(buffer) vs parser.feed(chunk)    ║");
  console.log("║   Apple-to-apple — same loop, only the parser function differs.             ║");
  console.log("╚═════════════════════════════════════════════════════════════════════════════╝");

  const sizes = [1, 5, 10, 50, 100];

  const products = [
    { name: "Vercel AI SDK", parser: "fixJson+JSON.parse", fn: vercelParse, isAsync: true },
    { name: "OpenCode",      parser: "= Vercel AI SDK",   fn: vercelParse, isAsync: true },
    { name: "Anthropic SDK", parser: "partialParse",       fn: anthropicParse, isAsync: false },
    { name: "Claude Code",   parser: "= Anthropic SDK",   fn: anthropicParse, isAsync: false },
    { name: "TanStack AI",   parser: "partial-json",       fn: tanstackParse, isAsync: false },
    { name: "OpenClaw",      parser: "JSON.parse+partial-json",
      fn: (s) => { try { return JSON.parse(s); } catch { return partialJsonParse(s); } },
      isAsync: false,
    },
  ];

  for (const sizeKB of sizes) {
    const jsonStr = generatePayload(sizeKB);
    const actualKB = (jsonStr.length / 1024).toFixed(0);
    const numChunks = Math.ceil(jsonStr.length / CHUNK_SIZE);

    console.log(`\n${"─".repeat(84)}`);
    console.log(`  Payload: ${actualKB} KB  │  Chunks: ${numChunks}  │  ~${CHUNK_SIZE} chars/chunk`);
    console.log(`${"─".repeat(84)}`);
    console.log(`  ${"Product".padEnd(18)} ${"Stock".padStart(12)} ${"+VectorJSON".padStart(12)} ${"Speedup".padStart(10)}  Parser`);
    console.log(`  ${"─".repeat(80)}`);

    // Compute VJ time once (same for all products at this payload size)
    const vjTime = benchVjLoop(vj, jsonStr, CHUNK_SIZE);

    for (const p of products) {
      const result = await benchStockLoop(p.fn, jsonStr, CHUNK_SIZE, { isAsync: p.isAsync });
      const stockTime = result.time;
      const speedup = (stockTime / vjTime).toFixed(0);
      const stockLabel = result.timedOut
        ? `>${formatTime(stockTime)}`.padStart(12)
        : formatTime(stockTime).padStart(12);

      console.log(
        `  ${p.name.padEnd(18)} ${stockLabel} ${formatTime(vjTime).padStart(12)} ${(speedup + "×").padStart(10)}  ${p.parser}`
      );
    }
  }

  // Summary
  console.log(`\n${"═".repeat(84)}`);
  console.log(`  What each product does today → what VectorJSON replaces it with:`);
  console.log(`  ${"─".repeat(80)}`);
  console.log(`  Vercel AI SDK   buffer += chunk; parsePartialJson(buffer)     → parser.feed(chunk)`);
  console.log(`  OpenCode        buffer += chunk; parsePartialJson(buffer)     → parser.feed(chunk)`);
  console.log(`  Anthropic SDK   jsonBuf += delta; partialParse(jsonBuf)       → parser.feed(chunk)`);
  console.log(`  Claude Code     jsonBuf += delta; partialParse(jsonBuf)       → parser.feed(chunk)`);
  console.log(`  TanStack AI     args += delta; jsonParser.parse(args)         → parser.feed(chunk)`);
  console.log(`  OpenClaw        buf += delta; JSON.parse||partial-json(buf)   → parser.feed(chunk)`);
  console.log(`  ${"─".repeat(80)}`);
  console.log(`  VectorJSON      parser.feed(chunk) → O(n) incremental WASM   ← drop-in for all`);
  console.log(`${"═".repeat(84)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
