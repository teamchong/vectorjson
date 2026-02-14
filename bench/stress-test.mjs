/**
 * Stress Test: Vercel AI SDK concat-reparse pattern vs VectorJSON streaming
 *
 * Simulates the real-world scenario where an AI SDK receives a streaming JSON
 * response (like an LLM structured output) and needs to parse it incrementally.
 *
 * The Vercel AI SDK pattern:
 *   buffer += chunk
 *   try { result = JSON.parse(buffer) } catch {}
 *
 * This is O(n²) — on every chunk it re-parses the ENTIRE accumulated buffer.
 * For large responses this causes:
 *   - Quadratic CPU time growth
 *   - Massive heap churn (new string + parsed objects on every chunk)
 *   - GC pressure that eventually causes jank or OOM
 *
 * VectorJSON streaming:
 *   parser.feed(chunk)  // O(chunk_size) — only processes new bytes
 *
 * This test generates increasingly large JSON payloads, simulates chunked
 * delivery, and measures CPU time + heap growth at each stage.
 *
 * Usage:
 *   node --expose-gc bench/stress-test.mjs
 */
import { init } from "../dist/index.js";

// --- Helpers ---

function forceGC() {
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
    globalThis.gc();
  }
}

function heapMB() {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

/**
 * Generate a realistic streaming AI response payload of approximately `targetKB` size.
 * Returns a JSON string representing structured output from an LLM.
 */
function generatePayload(targetKB) {
  const items = [];
  const targetBytes = targetKB * 1024;
  let currentSize = 50; // overhead for wrapper

  let id = 1;
  while (currentSize < targetBytes) {
    const item = {
      id: id++,
      type: "analysis",
      title: `Section ${id}: Analysis of topic ${id % 50}`,
      content: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(
        Math.max(1, Math.floor((targetKB / 100) * 3))
      ),
      confidence: Math.random(),
      tags: ["ai", "analysis", "section-" + id],
      metadata: {
        model: "gpt-4-turbo",
        tokens: Math.floor(Math.random() * 1000) + 100,
        latency_ms: Math.random() * 500,
      },
    };
    const itemStr = JSON.stringify(item);
    currentSize += itemStr.length + 1; // +1 for comma
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

/**
 * Simulate chunked delivery of a JSON string.
 * Returns an array of Uint8Array chunks.
 */
function chunkify(json, chunkSize) {
  const bytes = new TextEncoder().encode(json);
  const chunks = [];
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    chunks.push(bytes.slice(i, Math.min(i + chunkSize, bytes.byteLength)));
  }
  return chunks;
}

// --- Stress test runner ---

async function run() {
  const vj = await init();
  const gcAvailable = typeof globalThis.gc === "function";

  console.log("\n╔══════════════════════════════════════════════════════════════════════════════╗");
  console.log("║     Stress Test: Concat+Reparse O(n²) vs VectorJSON Stream O(n)            ║");
  console.log("╠══════════════════════════════════════════════════════════════════════════════╣");
  console.log("║  Simulates AI SDK streaming JSON responses at increasing sizes.             ║");
  console.log("║  Measures CPU time and heap memory at each payload size.                    ║");
  if (!gcAvailable) {
    console.log("║  ⚠  Run with --expose-gc for accurate heap measurements                    ║");
  }
  console.log("╚══════════════════════════════════════════════════════════════════════════════╝\n");

  const CHUNK_SIZE = 256; // bytes per chunk (simulates SSE event data)
  const payloadSizesKB = [10, 50, 100, 250, 500, 1000, 2000];

  // Table header
  console.log(
    "  " +
      "Size".padEnd(8) +
      "│ " +
      "Concat+Reparse".padEnd(32) +
      "│ " +
      "VectorJSON Stream".padEnd(32) +
      "│ " +
      "Speedup"
  );
  console.log(
    "  " +
      "".padEnd(8) +
      "│ " +
      "Time        Heap Δ    Peak".padEnd(32) +
      "│ " +
      "Time        Heap Δ    Peak".padEnd(32) +
      "│"
  );
  console.log("  " + "─".repeat(89));

  const results = [];

  for (const sizeKB of payloadSizesKB) {
    const json = generatePayload(sizeKB);
    const actualKB = (json.length / 1024).toFixed(0);
    const chunks = chunkify(json, CHUNK_SIZE);

    // ───── Approach 1: Concat + reparse (Vercel AI SDK pattern) ─────
    forceGC();
    let concatTime, concatHeapDelta, concatPeak;
    {
      const heapBefore = heapMB();
      let peak = heapBefore;
      const start = performance.now();

      let buffer = "";
      let lastResult = null;
      const decoder = new TextDecoder();

      for (const chunk of chunks) {
        buffer += decoder.decode(chunk);
        try {
          lastResult = JSON.parse(buffer);
        } catch {
          // expected — incomplete JSON
        }
        // Sample heap periodically
        if (chunks.indexOf(chunk) % 20 === 0) {
          const h = heapMB();
          if (h > peak) peak = h;
        }
      }

      concatTime = performance.now() - start;
      const heapAfter = heapMB();
      if (heapAfter > peak) peak = heapAfter;
      concatHeapDelta = heapAfter - heapBefore;
      concatPeak = peak;
    }

    // ───── Approach 2: VectorJSON streaming ─────
    forceGC();
    let streamTime, streamHeapDelta, streamPeak;
    {
      const heapBefore = heapMB();
      let peak = heapBefore;
      const start = performance.now();

      const parser = vj.createParser();
      let status;

      for (const chunk of chunks) {
        status = parser.feed(chunk);
        if (status === "complete" || status === "error" || status === "end_early") break;
      }

      // Materialize the result
      const result = parser.getValue();
      parser.destroy();

      streamTime = performance.now() - start;
      const heapAfter = heapMB();
      if (heapAfter > peak) peak = heapAfter;
      streamHeapDelta = heapAfter - heapBefore;
      streamPeak = peak;
    }

    const speedup = concatTime / streamTime;

    results.push({
      sizeKB: +actualKB,
      concatTime,
      concatHeapDelta,
      concatPeak,
      streamTime,
      streamHeapDelta,
      streamPeak,
      speedup,
    });

    // Print row
    const concatCol =
      `${concatTime.toFixed(1).padStart(7)} ms  ` +
      `${concatHeapDelta.toFixed(1).padStart(5)} MB  ` +
      `${concatPeak.toFixed(1).padStart(5)} MB`;

    const streamCol =
      `${streamTime.toFixed(1).padStart(7)} ms  ` +
      `${streamHeapDelta.toFixed(1).padStart(5)} MB  ` +
      `${streamPeak.toFixed(1).padStart(5)} MB`;

    console.log(
      `  ${(actualKB + " KB").padEnd(8)}│ ${concatCol.padEnd(32)}│ ${streamCol.padEnd(32)}│ ${speedup.toFixed(1)}x`
    );
  }

  // ───── Summary ─────
  console.log("\n  " + "═".repeat(89));
  console.log("\n  Scaling Analysis:\n");

  // Show how concat+reparse time scales quadratically
  if (results.length >= 3) {
    const first = results[0];
    const last = results[results.length - 1];
    const sizeRatio = last.sizeKB / first.sizeKB;
    const concatTimeRatio = last.concatTime / first.concatTime;
    const streamTimeRatio = last.streamTime / first.streamTime;

    console.log(`  Payload size grew ${sizeRatio.toFixed(0)}x (${first.sizeKB} KB → ${last.sizeKB} KB)`);
    console.log(`  Concat+reparse time grew ${concatTimeRatio.toFixed(1)}x (expected ~${(sizeRatio ** 2).toFixed(0)}x for O(n²))`);
    console.log(`  VectorJSON stream time grew ${streamTimeRatio.toFixed(1)}x (expected ~${sizeRatio.toFixed(0)}x for O(n))`);
    console.log();

    if (concatTimeRatio > sizeRatio * 1.5) {
      console.log("  ⚠ Concat+reparse shows SUPER-LINEAR growth — classic O(n²) memory/CPU pattern.");
    } else if (concatTimeRatio > sizeRatio) {
      console.log("  ⚠ Concat+reparse shows worse-than-linear growth.");
    }

    if (streamTimeRatio <= sizeRatio * 1.3) {
      console.log("  ✓ VectorJSON streaming shows near-linear O(n) scaling.");
    }
  }

  // ───── Memory pressure simulation ─────
  console.log("\n╔══════════════════════════════════════════════════════════════════════════════╗");
  console.log("║           Memory Pressure: 50 sequential streaming responses                ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════════╝\n");

  const SEQUENTIAL_COUNT = 50;
  const SEQUENTIAL_SIZE_KB = 100;

  // Generate payloads
  const payloads = [];
  for (let i = 0; i < SEQUENTIAL_COUNT; i++) {
    payloads.push(chunkify(generatePayload(SEQUENTIAL_SIZE_KB), CHUNK_SIZE));
  }

  // Concat+reparse approach
  forceGC();
  {
    const heapBefore = heapMB();
    const heapTimeline = [];
    const start = performance.now();

    for (let i = 0; i < payloads.length; i++) {
      const chunks = payloads[i];
      let buffer = "";
      const decoder = new TextDecoder();
      for (const chunk of chunks) {
        buffer += decoder.decode(chunk);
        try {
          JSON.parse(buffer);
        } catch {}
      }
      heapTimeline.push({ iteration: i + 1, heapMB: heapMB() });
    }

    const elapsed = performance.now() - start;
    const heapAfter = heapMB();
    const peakHeap = Math.max(...heapTimeline.map((h) => h.heapMB));

    console.log(`  Concat+reparse (${SEQUENTIAL_COUNT} × ${SEQUENTIAL_SIZE_KB}KB):`);
    console.log(`    Total time:  ${elapsed.toFixed(0)} ms`);
    console.log(`    Heap before: ${heapBefore.toFixed(1)} MB`);
    console.log(`    Heap after:  ${heapAfter.toFixed(1)} MB`);
    console.log(`    Peak heap:   ${peakHeap.toFixed(1)} MB`);
    console.log(`    Heap growth: ${(heapAfter - heapBefore).toFixed(1)} MB`);

    // Show heap timeline (sampled)
    console.log("    Heap timeline (every 10th):");
    for (const sample of heapTimeline.filter((_, i) => i % 10 === 9)) {
      const bar = "█".repeat(Math.floor(sample.heapMB / 2));
      console.log(`      #${String(sample.iteration).padStart(3)}: ${sample.heapMB.toFixed(1).padStart(6)} MB  ${bar}`);
    }
  }

  console.log();

  // VectorJSON streaming approach
  forceGC();
  {
    const heapBefore = heapMB();
    const heapTimeline = [];
    const start = performance.now();

    for (let i = 0; i < payloads.length; i++) {
      const chunks = payloads[i];
      const parser = vj.createParser();
      let status;
      for (const chunk of chunks) {
        status = parser.feed(chunk);
        if (status === "complete" || status === "error") break;
      }
      parser.getValue();
      parser.destroy();
      heapTimeline.push({ iteration: i + 1, heapMB: heapMB() });
    }

    const elapsed = performance.now() - start;
    const heapAfter = heapMB();
    const peakHeap = Math.max(...heapTimeline.map((h) => h.heapMB));

    console.log(`  VectorJSON stream (${SEQUENTIAL_COUNT} × ${SEQUENTIAL_SIZE_KB}KB):`);
    console.log(`    Total time:  ${elapsed.toFixed(0)} ms`);
    console.log(`    Heap before: ${heapBefore.toFixed(1)} MB`);
    console.log(`    Heap after:  ${heapAfter.toFixed(1)} MB`);
    console.log(`    Peak heap:   ${peakHeap.toFixed(1)} MB`);
    console.log(`    Heap growth: ${(heapAfter - heapBefore).toFixed(1)} MB`);

    console.log("    Heap timeline (every 10th):");
    for (const sample of heapTimeline.filter((_, i) => i % 10 === 9)) {
      const bar = "█".repeat(Math.floor(sample.heapMB / 2));
      console.log(`      #${String(sample.iteration).padStart(3)}: ${sample.heapMB.toFixed(1).padStart(6)} MB  ${bar}`);
    }
  }

  console.log("\n  Done.\n");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
