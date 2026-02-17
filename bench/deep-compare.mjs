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
import { parse, deepCompare } from "../dist/index.js";

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
    `  ${label.padEnd(40)} ${formatNum(stats.opsPerSec).padStart(10)} ops/s  ` +
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

  console.log("\n╔══════════════════════════════════════════════════════════════════════════════════╗");
  console.log("║                    Deep Compare Benchmark — Equal Objects                        ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════════════╝\n");

  for (const name of fixtures) {
    if (!data[name]) continue;
    const json = data[name];
    const sizeKB = (Buffer.byteLength(json) / 1024).toFixed(1);
    const objA = JSON.parse(json);
    const objB = JSON.parse(json);

    // Parse with VJ to get proxies for WASM comparison
    const proxyA = parse(json).value;
    const proxyB = parse(json).value;

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

    // Approach 3: VectorJSON.deepCompare (default — ignore key order)
    const vjResult = bench(() => {
      deepCompare(proxyA, proxyB);
    });
    printResult("VJ ignore key order (default)", vjResult);

    // Approach 4: VectorJSON.deepCompare (strict key order)
    const vjStrictResult = bench(() => {
      deepCompare(proxyA, proxyB, { ignoreKeyOrder: false });
    });
    printResult("VJ strict key order", vjStrictResult);

    console.log();
  }

  // ==============================================
  // Compare with differences
  // ==============================================
  console.log("╔══════════════════════════════════════════════════════════════════════════════════╗");
  console.log("║                  Deep Compare Benchmark — With Differences                       ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════════════╝\n");

  /**
   * Generic deep mutation: walk the object and change the first string value found.
   * Works for any fixture shape — no fixture-specific mutation logic needed.
   */
  function mutate(obj) {
    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (typeof item === "object" && item !== null) { mutate(item); return; }
      }
      if (obj.length > 0) obj[0] = "__MODIFIED__";
    } else if (typeof obj === "object" && obj !== null) {
      for (const key of Object.keys(obj)) {
        if (typeof obj[key] === "string") { obj[key] = "__MODIFIED__"; return; }
        if (typeof obj[key] === "object" && obj[key] !== null) { mutate(obj[key]); return; }
      }
    }
  }

  for (const name of fixtures) {
    if (!data[name]) continue;
    const json = data[name];
    const sizeKB = (Buffer.byteLength(json) / 1024).toFixed(1);
    const objA = JSON.parse(json);
    const objB = JSON.parse(json);
    mutate(objB);

    const proxyA = parse(json).value;
    const modifiedJson = JSON.stringify(objB);
    const proxyB = parse(modifiedJson).value;

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
      deepCompare(proxyA, proxyB);
    });
    printResult("VJ ignore key order (default)", vjResult);

    const vjStrictResult = bench(() => {
      deepCompare(proxyA, proxyB, { ignoreKeyOrder: false });
    });
    printResult("VJ strict key order", vjStrictResult);

    const isEqual = deepCompare(proxyA, proxyB);
    console.log(`  → equal: ${isEqual}\n`);
  }

  // ==============================================
  // Shuffled keys — only VJ can handle this correctly
  // ==============================================
  console.log("╔══════════════════════════════════════════════════════════════════════════════════╗");
  console.log("║              Deep Compare Benchmark — Shuffled Key Order                         ║");
  console.log("╚══════════════════════════════════════════════════════════════════════════════════╝\n");

  /**
   * Recursively shuffle all object keys (arrays keep element order).
   */
  function shuffleKeys(obj) {
    if (Array.isArray(obj)) return obj.map(shuffleKeys);
    if (typeof obj !== "object" || obj === null) return obj;
    const keys = Object.keys(obj);
    // Fisher-Yates shuffle
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    const out = {};
    for (const k of keys) out[k] = shuffleKeys(obj[k]);
    return out;
  }

  for (const name of fixtures) {
    if (!data[name]) continue;
    const json = data[name];
    const sizeKB = (Buffer.byteLength(json) / 1024).toFixed(1);
    const objA = JSON.parse(json);
    const objB = shuffleKeys(objA);
    const jsonB = JSON.stringify(objB);

    const proxyA = parse(json).value;
    const proxyB = parse(jsonB).value;

    // Verify they're semantically equal
    const check = deepCompare(proxyA, proxyB);
    if (!check) { console.log(`  ⚠ ${name}.json: shuffled keys not equal (skipping)`); continue; }

    console.log(`  ─── ${name}.json (${sizeKB} KB) — shuffled keys ───`);

    // Strict key order (should return false for reordered keys)
    const vjStrictResult = bench(() => {
      deepCompare(proxyA, proxyB, { ignoreKeyOrder: false });
    });
    printResult("VJ strict key order (→ false)", vjStrictResult);

    // Ignore key order — default (should return true)
    const vjIgnoreResult = bench(() => {
      deepCompare(proxyA, proxyB);
    });
    printResult("VJ ignore key order (→ true)", vjIgnoreResult);

    // Baseline: same-order comparison for reference
    const proxyA2 = parse(json).value;
    const vjSameOrderResult = bench(() => {
      deepCompare(proxyA, proxyA2);
    });
    printResult("VJ same-order baseline", vjSameOrderResult);

    console.log();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
