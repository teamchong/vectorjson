/**
 * Benchmark: Stringify — VectorJSON vs JSON.stringify
 *
 * Tests stringify across all fixture sizes + repeated stringification (loop).
 * Tracks: ops/sec, mean time, peak heap, heap delta.
 *
 * Usage:
 *   node --expose-gc bench/stringify-loop.mjs
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { init } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

function bench(fn, { warmup = 50, durationMs = 2000 } = {}) {
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

async function run() {
  const vj = await init();

  const fixtures = ["tiny", "small", "medium", "large", "xlarge", "huge"];
  const objects = {};

  for (const name of fixtures) {
    const path = join(__dirname, "fixtures", `${name}.json`);
    try {
      objects[name] = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      // skip missing
    }
  }

  console.log("\n╔═════════════════════════════════════════════════════════════════════════════╗");
  console.log("║                     Stringify Benchmark — One-Shot                          ║");
  console.log("╚═════════════════════════════════════════════════════════════════════════════╝\n");

  for (const name of fixtures) {
    if (!objects[name]) continue;
    const obj = objects[name];
    const jsonLen = JSON.stringify(obj).length;
    const sizeKB = (jsonLen / 1024).toFixed(1);
    console.log(`  ─── ${name}.json (~${sizeKB} KB) ───`);

    const jsResult = bench(() => JSON.stringify(obj));
    printResult("JSON.stringify", jsResult);

    const vjResult = bench(() => vj.stringify(obj));
    printResult("VectorJSON.stringify", vjResult);

    const speedup = vjResult.opsPerSec / jsResult.opsPerSec;
    console.log(
      `  ${"→ speedup".padEnd(30)} ${speedup.toFixed(2)}x ${speedup >= 1 ? "faster" : "slower"}\n`
    );
  }

  // ==============================================
  // Loop stringify: repeated stringification in a tight loop
  // Simulates logging / serialization hot paths
  // ==============================================
  console.log("╔═════════════════════════════════════════════════════════════════════════════╗");
  console.log("║              Loop Stringify — 1000 iterations, heap tracking                ║");
  console.log("╚═════════════════════════════════════════════════════════════════════════════╝\n");

  const loopCount = 1000;

  for (const name of ["medium", "large"]) {
    if (!objects[name]) continue;
    const obj = objects[name];
    const jsonLen = JSON.stringify(obj).length;
    const sizeKB = (jsonLen / 1024).toFixed(1);
    console.log(`  ─── ${name}.json (~${sizeKB} KB) × ${loopCount} iterations ───`);

    // JSON.stringify loop
    forceGC();
    {
      const heapBefore = heapMB();
      const heapSamples = [heapBefore];
      const start = performance.now();

      for (let i = 0; i < loopCount; i++) {
        JSON.stringify(obj);
        if (i % 100 === 0) heapSamples.push(heapMB());
      }

      const elapsed = performance.now() - start;
      const heapAfter = heapMB();
      heapSamples.push(heapAfter);
      const peakHeap = Math.max(...heapSamples);

      console.log(
        `  ${"JSON.stringify".padEnd(30)} ` +
          `${elapsed.toFixed(1).padStart(8)} ms  ` +
          `heap Δ ${(heapAfter - heapBefore).toFixed(2).padStart(7)} MB  ` +
          `peak ${peakHeap.toFixed(1).padStart(6)} MB`
      );
    }

    // VectorJSON.stringify loop
    forceGC();
    {
      const heapBefore = heapMB();
      const heapSamples = [heapBefore];
      const start = performance.now();

      for (let i = 0; i < loopCount; i++) {
        vj.stringify(obj);
        if (i % 100 === 0) heapSamples.push(heapMB());
      }

      const elapsed = performance.now() - start;
      const heapAfter = heapMB();
      heapSamples.push(heapAfter);
      const peakHeap = Math.max(...heapSamples);

      console.log(
        `  ${"VectorJSON.stringify".padEnd(30)} ` +
          `${elapsed.toFixed(1).padStart(8)} ms  ` +
          `heap Δ ${(heapAfter - heapBefore).toFixed(2).padStart(7)} MB  ` +
          `peak ${peakHeap.toFixed(1).padStart(6)} MB`
      );
    }
    console.log();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
