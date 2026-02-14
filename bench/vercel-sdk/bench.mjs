/**
 * Real Vercel AI SDK Benchmark — Stock vs VectorJSON-Patched
 *
 * Runs the actual SDK streamObject pipeline with MockLanguageModelV3.
 * Stock SDK: parsePartialJson → fixJson → JSON.parse (concat+reparse O(n²))
 * Patched SDK: parsePartialJson → VectorJSON.parse (WASM-accelerated)
 *
 * Same streamObject, same TransformStream, same schema validation —
 * only the JSON parsing function is swapped.
 *
 * Tracks JS heap + WASM linear memory for honest totals.
 *
 * Usage: bun --expose-gc bench.mjs
 */
import { streamObject as stockStreamObject } from "ai";
import { streamObject as patchedStreamObject } from "./ai-patched.mjs";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";

// --- Helpers ---

function forceGC() {
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
    globalThis.gc();
  }
}

function memMB() {
  const m = process.memoryUsage();
  return {
    jsHeap: m.heapUsed / 1024 / 1024,
    wasm: m.arrayBuffers / 1024 / 1024,
    rss: m.rss / 1024 / 1024,
    total: (m.heapUsed + m.arrayBuffers) / 1024 / 1024,
  };
}

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
      tags: ["ai", "analysis", `section-${id}`],
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

// Zod schema matching the payload
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

/** Create a mock model that streams jsonStr in chunkSize-char text-delta chunks */
function createMockModel(jsonStr, chunkSize) {
  const textChunks = [];
  for (let i = 0; i < jsonStr.length; i += chunkSize) {
    textChunks.push(jsonStr.slice(i, i + chunkSize));
  }
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

/** Run streamObject and consume the full pipeline */
async function runStreamObject(streamObjectFn, jsonStr, chunkSize) {
  const model = createMockModel(jsonStr, chunkSize);
  const result = streamObjectFn({
    model,
    schema: payloadSchema,
    prompt: "generate",
  });

  // Consume partial object stream (triggers parsePartialJson on every chunk)
  let lastObj;
  for await (const partial of result.partialObjectStream) {
    lastObj = partial;
  }
  return await result.object;
}

// --- Main ---
async function run() {
  const CHUNK_SIZE = 50; // chars per chunk — simulates token-level streaming

  console.log("\n╔══════════════════════════════════════════════════════════════════════════════╗");
  console.log("║  Vercel AI SDK: Stock vs VectorJSON-Patched                                ║");
  console.log("║  Same streamObject pipeline — only parsePartialJson is swapped             ║");
  console.log("║  Memory: JS heap + WASM (arrayBuffers) = Total                             ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════════╝\n");

  // ─── Correctness check ───
  {
    const testJson = generatePayload(10);
    const stockResult = await runStreamObject(stockStreamObject, testJson, 50);
    const patchedResult = await runStreamObject(patchedStreamObject, testJson, 50);
    const stockStr = JSON.stringify(stockResult);
    const patchedStr = JSON.stringify(patchedResult);
    if (stockStr === patchedStr) {
      console.log("  ✓ Correctness: Stock and Patched produce identical final objects\n");
    } else {
      console.error("  ✗ MISMATCH: Stock and Patched produce different results!");
      process.exit(1);
    }
  }

  // ─── Part 1: Single request scaling ───
  const payloadSizesKB = [10, 50, 100, 250, 500];

  console.log("  ─── Part 1: Single Request Scaling ───\n");
  console.log(
    "  " +
      "Size".padEnd(10) +
      "│ " + "Stock SDK".padEnd(30) +
      "│ " + "Patched (VectorJSON)".padEnd(30) +
      "│ Speedup"
  );
  console.log(
    "  " +
      "".padEnd(10) +
      "│ " + "Time        JS+WASM Δ".padEnd(30) +
      "│ " + "Time        JS+WASM Δ".padEnd(30) +
      "│"
  );
  console.log("  " + "─".repeat(85));

  for (const sizeKB of payloadSizesKB) {
    const jsonStr = generatePayload(sizeKB);
    const actualKB = (jsonStr.length / 1024).toFixed(0);

    // Stock SDK
    forceGC();
    const stockBefore = memMB();
    const stockStart = performance.now();
    await runStreamObject(stockStreamObject, jsonStr, CHUNK_SIZE);
    const stockTime = performance.now() - stockStart;
    const stockAfter = memMB();
    const stockDelta = stockAfter.total - stockBefore.total;

    // Patched SDK
    forceGC();
    const patchBefore = memMB();
    const patchStart = performance.now();
    await runStreamObject(patchedStreamObject, jsonStr, CHUNK_SIZE);
    const patchTime = performance.now() - patchStart;
    const patchAfter = memMB();
    const patchDelta = patchAfter.total - patchBefore.total;

    const speedup = stockTime / patchTime;
    const fmtMB = (v) => ((v >= 0 ? "+" : "") + v.toFixed(1) + " MB").padStart(10);
    const fmtMs = (v) =>
      v >= 1000
        ? `${(v / 1000).toFixed(1)} s`.padStart(10)
        : `${v.toFixed(1)} ms`.padStart(10);

    console.log(
      `  ${(actualKB + " KB").padEnd(10)}│ ` +
        `${fmtMs(stockTime)}  ${fmtMB(stockDelta)}`.padEnd(30) +
        `│ ` +
        `${fmtMs(patchTime)}  ${fmtMB(patchDelta)}`.padEnd(30) +
        `│ ${speedup.toFixed(1)}x`
    );
  }

  // ─── Part 2: Sustained pressure ───
  const SEQ_COUNT = 100;
  const SEQ_SIZE_KB = 100;
  console.log(`\n  ─── Part 2: Sustained Pressure (${SEQ_COUNT} × ${SEQ_SIZE_KB}KB) ───\n`);

  const seqJson = generatePayload(SEQ_SIZE_KB);

  // Stock SDK sustained
  forceGC();
  {
    const before = memMB();
    const timeline = [];
    const start = performance.now();

    for (let i = 0; i < SEQ_COUNT; i++) {
      await runStreamObject(stockStreamObject, seqJson, CHUNK_SIZE);
      if (i % 25 === 24) {
        timeline.push({ iteration: i + 1, ...memMB() });
      }
    }

    const elapsed = performance.now() - start;
    forceGC();
    const after = memMB();

    console.log(`  Stock SDK (${SEQ_COUNT} × ${SEQ_SIZE_KB}KB):`);
    console.log(`    Time:         ${(elapsed / 1000).toFixed(1)} sec`);
    console.log(`    JS heap:      ${before.jsHeap.toFixed(1)} → ${after.jsHeap.toFixed(1)} MB  (Δ ${(after.jsHeap - before.jsHeap).toFixed(1)} MB)`);
    console.log(`    WASM memory:  ${before.wasm.toFixed(1)} → ${after.wasm.toFixed(1)} MB  (Δ ${(after.wasm - before.wasm).toFixed(1)} MB)`);
    console.log(`    JS+WASM:      ${before.total.toFixed(1)} → ${after.total.toFixed(1)} MB  (Δ ${(after.total - before.total).toFixed(1)} MB)`);
    console.log(`    RSS:          ${before.rss.toFixed(1)} → ${after.rss.toFixed(1)} MB`);
    console.log("    Timeline:");
    for (const s of timeline) {
      const bar = "█".repeat(Math.max(1, Math.floor(s.total / 5)));
      console.log(`      #${String(s.iteration).padStart(3)}: JS ${s.jsHeap.toFixed(1).padStart(6)} + WASM ${s.wasm.toFixed(1).padStart(5)} = ${s.total.toFixed(1).padStart(7)} MB  RSS ${s.rss.toFixed(0).padStart(5)} MB  ${bar}`);
    }
  }

  console.log();

  // Patched SDK sustained
  forceGC();
  {
    const before = memMB();
    const timeline = [];
    const start = performance.now();

    for (let i = 0; i < SEQ_COUNT; i++) {
      await runStreamObject(patchedStreamObject, seqJson, CHUNK_SIZE);
      if (i % 25 === 24) {
        forceGC();
        timeline.push({ iteration: i + 1, ...memMB() });
      }
    }

    const elapsed = performance.now() - start;
    forceGC();
    const after = memMB();

    console.log(`  Patched SDK + VectorJSON (${SEQ_COUNT} × ${SEQ_SIZE_KB}KB):`);
    console.log(`    Time:         ${(elapsed / 1000).toFixed(1)} sec`);
    console.log(`    JS heap:      ${before.jsHeap.toFixed(1)} → ${after.jsHeap.toFixed(1)} MB  (Δ ${(after.jsHeap - before.jsHeap).toFixed(1)} MB)`);
    console.log(`    WASM memory:  ${before.wasm.toFixed(1)} → ${after.wasm.toFixed(1)} MB  (Δ ${(after.wasm - before.wasm).toFixed(1)} MB)`);
    console.log(`    JS+WASM:      ${before.total.toFixed(1)} → ${after.total.toFixed(1)} MB  (Δ ${(after.total - before.total).toFixed(1)} MB)`);
    console.log(`    RSS:          ${before.rss.toFixed(1)} → ${after.rss.toFixed(1)} MB`);
    console.log("    Timeline:");
    for (const s of timeline) {
      const bar = "█".repeat(Math.max(1, Math.floor(s.total / 5)));
      console.log(`      #${String(s.iteration).padStart(3)}: JS ${s.jsHeap.toFixed(1).padStart(6)} + WASM ${s.wasm.toFixed(1).padStart(5)} = ${s.total.toFixed(1).padStart(7)} MB  RSS ${s.rss.toFixed(0).padStart(5)} MB  ${bar}`);
    }
  }

  console.log("\n  Done.\n");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
