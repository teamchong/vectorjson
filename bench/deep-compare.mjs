/**
 * Benchmark: Deep Compare — VectorJSON vs parse+parse+manual-deep-equal
 *
 * Compares VectorJSON's WASM-accelerated deepCompare with JS-side approaches:
 *   1. JSON.parse both → manual recursive deep equal
 *   2. JSON.stringify both → string compare
 *   3. VectorJSON.deepCompare (WASM)
 *
 * Usage:
 *   node --expose-gc bench/deep-compare.mjs
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

function bench(fn, { warmup = 30, durationMs = 2000 } = {}) {
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
    if (ops % 50 === 0) {
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
    `  ${label.padEnd(35)} ${formatNum(stats.opsPerSec).padStart(10)} ops/s  ` +
      `${formatTime(stats.meanMs).padStart(10)}  ` +
      `heap Δ ${stats.heapDeltaMB.toFixed(2).padStart(7)} MB`
  );
}

/**
 * Simple recursive deep-equal (like fast-deep-equal without edge cases).
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (typeof a === "object") {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }

  return false;
}

async function run() {
  const vj = await init();
  const encoder = new TextEncoder();

  const fixtures = ["tiny", "small", "medium", "large"];
  const data = {};

  for (const name of fixtures) {
    const path = join(__dirname, "fixtures", `${name}.json`);
    try {
      data[name] = readFileSync(path, "utf-8");
    } catch {
      // skip
    }
  }

  console.log("\n╔══════════════════════════════════════════════════════════════════════════════╗");
  console.log("║                Deep Compare Benchmark — Equal Objects                       ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════════╝\n");

  for (const name of fixtures) {
    if (!data[name]) continue;
    const json = data[name];
    const sizeKB = (Buffer.byteLength(json) / 1024).toFixed(1);
    const objA = JSON.parse(json);
    const objB = JSON.parse(json);
    const bytesA = encoder.encode(json);
    const bytesB = encoder.encode(json);

    console.log(`  ─── ${name}.json (${sizeKB} KB) — identical objects ───`);

    // Approach 1: JSON.stringify both, compare strings
    const strCmpResult = bench(() => {
      JSON.stringify(objA) === JSON.stringify(objB);
    });
    printResult("stringify+compare", strCmpResult);

    // Approach 2: JS deep-equal
    const deepEqResult = bench(() => {
      deepEqual(objA, objB);
    });
    printResult("JS deepEqual (recursive)", deepEqResult);

    // Approach 3: VectorJSON.deepCompare
    const vjResult = bench(() => {
      vj.deepCompare(objA, objB);
    });
    printResult("VectorJSON.deepCompare", vjResult);

    console.log();
  }

  // ==============================================
  // Compare with differences
  // ==============================================
  console.log("╔══════════════════════════════════════════════════════════════════════════════╗");
  console.log("║              Deep Compare Benchmark — With Differences                      ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════════╝\n");

  for (const name of ["medium", "large"]) {
    if (!data[name]) continue;
    const json = data[name];
    const sizeKB = (Buffer.byteLength(json) / 1024).toFixed(1);
    const objA = JSON.parse(json);
    // Create a modified version
    const objB = JSON.parse(json);

    // Introduce some differences
    if (objB.data && Array.isArray(objB.data)) {
      // Medium: modify some items
      for (let i = 0; i < Math.min(10, objB.data.length); i++) {
        objB.data[i].name = "MODIFIED_" + i;
        objB.data[i].score = 999;
      }
    } else if (objB.metrics && Array.isArray(objB.metrics)) {
      // Large: modify some metrics
      for (let i = 0; i < Math.min(5, objB.metrics.length); i++) {
        objB.metrics[i].name = "modified_metric";
      }
    }

    console.log(`  ─── ${name}.json (${sizeKB} KB) — with modifications ───`);

    const strCmpResult = bench(() => {
      JSON.stringify(objA) === JSON.stringify(objB);
    });
    printResult("stringify+compare", strCmpResult);

    const deepEqResult = bench(() => {
      deepEqual(objA, objB);
    });
    printResult("JS deepEqual (recursive)", deepEqResult);

    const vjResult = bench(() => {
      vj.deepCompare(objA, objB);
    });
    printResult("VectorJSON.deepCompare", vjResult);

    // Show diff count
    const diffs = vj.deepCompare(objA, objB);
    console.log(`  → found ${diffs.length} difference(s)\n`);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
