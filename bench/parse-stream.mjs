/**
 * Benchmark: Parse & Stream — VectorJSON vs JSON.parse
 *
 * Tests one-shot parse and streaming parse across all fixture sizes.
 * Tracks: ops/sec, mean time, peak heap, heap delta.
 *
 * Usage:
 *   node --expose-gc bench/parse-stream.mjs
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, createParser } from "../dist/index.js";
import { parse as partialParse } from "./ai-parsers/node_modules/partial-json/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Utilities ---

function forceGC() {
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
    globalThis.gc();
  }
}

function heapMB() {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

function formatNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(2);
}

function formatTime(ms) {
  if (ms < 0.001) return (ms * 1e6).toFixed(0) + " ns";
  if (ms < 1) return (ms * 1e3).toFixed(1) + " µs";
  return ms.toFixed(2) + " ms";
}

/**
 * Run a benchmark function for at least `durationMs` and return stats.
 */
function bench(fn, { warmup = 50, durationMs = 2000 } = {}) {
  // Warmup
  for (let i = 0; i < warmup; i++) fn();

  forceGC();
  const heapBefore = heapMB();
  let peakHeap = heapBefore;

  let ops = 0;
  const start = performance.now();
  const deadline = start + durationMs;

  while (performance.now() < deadline) {
    fn();
    ops++;
    // Sample heap periodically
    if (ops % 100 === 0) {
      const h = heapMB();
      if (h > peakHeap) peakHeap = h;
    }
  }

  const elapsed = performance.now() - start;
  const heapAfter = heapMB();
  if (heapAfter > peakHeap) peakHeap = heapAfter;

  return {
    ops,
    opsPerSec: (ops / elapsed) * 1000,
    meanMs: elapsed / ops,
    heapDeltaMB: heapAfter - heapBefore,
    peakHeapMB: peakHeap,
    totalMs: elapsed,
  };
}

function printResult(label, stats) {
  console.log(
    `  ${label.padEnd(30)} ${formatNum(stats.opsPerSec).padStart(10)} ops/s  ` +
      `${formatTime(stats.meanMs).padStart(10)}  ` +
      `heap Δ ${stats.heapDeltaMB.toFixed(2).padStart(7)} MB  ` +
      `peak ${stats.peakHeapMB.toFixed(1).padStart(6)} MB`
  );
}

// --- Main ---

async function run() {
  const fixtures = ["tiny", "small", "medium", "large", "xlarge"];
  const data = {};

  for (const name of fixtures) {
    const path = join(__dirname, "fixtures", `${name}.json`);
    try {
      data[name] = readFileSync(path, "utf-8");
    } catch {
      console.warn(`  ⚠ Fixture ${name}.json not found, skipping`);
    }
  }

  // Also try huge
  try {
    data.huge = readFileSync(join(__dirname, "fixtures", "huge.json"), "utf-8");
    fixtures.push("huge");
  } catch {}

  console.log("\n╔═════════════════════════════════════════════════════════════════════════════╗");
  console.log("║                      Parse Benchmark — One-Shot                             ║");
  console.log("╚═════════════════════════════════════════════════════════════════════════════╝\n");

  for (const name of fixtures) {
    if (!data[name]) continue;
    const json = data[name];
    const sizeKB = (Buffer.byteLength(json) / 1024).toFixed(1);
    console.log(`  ─── ${name}.json (${sizeKB} KB) ───`);

    // JSON.parse
    const jpResult = bench(() => JSON.parse(json));
    printResult("JSON.parse", jpResult);

    // partial-json parse
    const pjResult = bench(() => partialParse(json));
    printResult("partial-json parse", pjResult);

    // VectorJSON.parse
    const vjResult = bench(() => parse(json));
    printResult("VectorJSON.parse", vjResult);

    const pjRatio = pjResult.opsPerSec / jpResult.opsPerSec;
    const vjRatio = vjResult.opsPerSec / jpResult.opsPerSec;
    console.log(
      `  ${"→ partial-json vs JSON.parse".padEnd(30)} ${pjRatio.toFixed(2)}x ${pjRatio >= 1 ? "faster" : "slower"}`
    );
    console.log(
      `  ${"→ VectorJSON vs JSON.parse".padEnd(30)} ${vjRatio.toFixed(2)}x ${vjRatio >= 1 ? "faster" : "slower"}\n`
    );
  }

  // ==============================================
  // Streaming benchmark: chunk-by-chunk vs one-shot
  // ==============================================
  console.log("╔═════════════════════════════════════════════════════════════════════════════╗");
  console.log("║                    Streaming Parse — Chunked Feed                           ║");
  console.log("╚═════════════════════════════════════════════════════════════════════════════╝\n");

  const chunkSizes = [64, 256, 1024, 4096];

  for (const name of ["medium", "large", "xlarge"]) {
    if (!data[name]) continue;
    const json = data[name];
    const bytes = new TextEncoder().encode(json);
    const sizeKB = (bytes.byteLength / 1024).toFixed(1);
    console.log(`  ─── ${name}.json (${sizeKB} KB) ───`);

    // Baseline: JSON.parse (one-shot)
    const baseline = bench(() => JSON.parse(json), { durationMs: 1500 });
    printResult("JSON.parse (baseline)", baseline);

    // partial-json (one-shot, no streaming API)
    const pjOneShot = bench(() => partialParse(json), { durationMs: 1500 });
    printResult("partial-json (one-shot)", pjOneShot);

    // partial-json concat+reparse (simulates streaming — re-parses on every chunk)
    for (const chunkSize of chunkSizes) {
      const label = `partial-json reparse (${chunkSize}B)`;
      const result = bench(
        () => {
          let buffer = "";
          for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
            const end = Math.min(offset + chunkSize, bytes.byteLength);
            buffer += new TextDecoder().decode(bytes.slice(offset, end));
            partialParse(buffer);
          }
        },
        { durationMs: 1500, warmup: 3 }
      );
      printResult(label, result);
    }

    // VectorJSON one-shot
    const vjOneShot = bench(() => parse(json), { durationMs: 1500 });
    printResult("VectorJSON.parse (one-shot)", vjOneShot);

    // VectorJSON streaming with different chunk sizes
    for (const chunkSize of chunkSizes) {
      const label = `VectorJSON stream (${chunkSize}B chunks)`;
      const result = bench(
        () => {
          const parser = createParser();
          for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
            const end = Math.min(offset + chunkSize, bytes.byteLength);
            const chunk = bytes.slice(offset, end);
            parser.feed(chunk);
          }
          parser.getValue();
          parser.destroy();
        },
        { durationMs: 1500, warmup: 10 }
      );
      printResult(label, result);
    }
    console.log();
  }

  // ==============================================
  // Concat-reparse O(n²) vs stream O(n)
  // ==============================================
  console.log("╔════════════════════════════════════════════════════════════════════════════╗");
  console.log("║          Concat+Reparse O(n²) vs VectorJSON Stream O(n)                    ║");
  console.log("╚════════════════════════════════════════════════════════════════════════════╝\n");

  for (const name of ["medium", "large"]) {
    if (!data[name]) continue;
    const json = data[name];
    const bytes = new TextEncoder().encode(json);
    const sizeKB = (bytes.byteLength / 1024).toFixed(1);
    const chunkSize = 256;
    const numChunks = Math.ceil(bytes.byteLength / chunkSize);

    console.log(`  ─── ${name}.json (${sizeKB} KB, ${numChunks} chunks of ${chunkSize}B) ───`);

    // Approach 1: Concat + JSON.parse reparse on every chunk (Vercel AI SDK pattern)
    forceGC();
    {
      const heapBefore = heapMB();
      const start = performance.now();
      let buffer = "";
      let reparseCount = 0;
      let lastResult = null;

      for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        const end = Math.min(offset + chunkSize, bytes.byteLength);
        const chunk = new TextDecoder().decode(bytes.slice(offset, end));
        buffer += chunk;
        try {
          lastResult = JSON.parse(buffer);
          reparseCount++;
        } catch {
          // Incomplete JSON — expected
        }
      }
      const elapsed = performance.now() - start;
      const heapAfter = heapMB();
      console.log(
        `  ${"concat+JSON.parse (O(n²))".padEnd(30)} ` +
          `${elapsed.toFixed(2).padStart(8)} ms  ` +
          `reparses: ${reparseCount}  ` +
          `heap Δ ${(heapAfter - heapBefore).toFixed(2).padStart(7)} MB`
      );
    }

    // Approach 1b: Concat + partial-json reparse on every chunk
    forceGC();
    {
      const heapBefore = heapMB();
      const start = performance.now();
      let buffer = "";
      let parseCount = 0;

      for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        const end = Math.min(offset + chunkSize, bytes.byteLength);
        const chunk = new TextDecoder().decode(bytes.slice(offset, end));
        buffer += chunk;
        partialParse(buffer);
        parseCount++;
      }
      const elapsed = performance.now() - start;
      const heapAfter = heapMB();
      console.log(
        `  ${"concat+partial-json (O(n²))".padEnd(30)} ` +
          `${elapsed.toFixed(2).padStart(8)} ms  ` +
          `parses: ${parseCount}  ` +
          `heap Δ ${(heapAfter - heapBefore).toFixed(2).padStart(7)} MB`
      );
    }

    // Approach 2: VectorJSON streaming O(n)
    forceGC();
    {
      const heapBefore = heapMB();
      const start = performance.now();
      const parser = createParser();
      let status;

      for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        const end = Math.min(offset + chunkSize, bytes.byteLength);
        const chunk = bytes.slice(offset, end);
        status = parser.feed(chunk);
        if (status === "complete" || status === "error") break;
      }
      const result = parser.getValue();
      parser.destroy();

      const elapsed = performance.now() - start;
      const heapAfter = heapMB();
      console.log(
        `  ${"VectorJSON stream (O(n))".padEnd(30)} ` +
          `${elapsed.toFixed(2).padStart(8)} ms  ` +
          `status: ${status}  ` +
          `heap Δ ${(heapAfter - heapBefore).toFixed(2).padStart(7)} MB`
      );
    }
    console.log();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
