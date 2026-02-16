/**
 * Benchmark: End-to-End — parse → JSON.stringify
 *
 * Compares:
 *   JSON.stringify(JSON.parse(str))
 *   JSON.stringify(vj.parse(str).value)
 *
 * Usage:
 *   bun --expose-gc bench/end-to-end.mjs
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { init } from "../dist/index.js";
import { parse as partialParse } from "./ai-parsers/node_modules/partial-json/dist/index.js";

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
    `  ${label.padEnd(35)} ${formatNum(stats.opsPerSec).padStart(10)} ops/s  ` +
      `${formatTime(stats.meanMs).padStart(10)}  ` +
      `heap Δ ${stats.heapDeltaMB.toFixed(2).padStart(7)} MB  ` +
      `peak ${stats.peakHeapMB.toFixed(1).padStart(6)} MB`
  );
}

async function run() {
  const vj = await init();

  const fixtures = ["tiny", "small", "medium", "large", "xlarge"];
  const data = {};

  for (const name of fixtures) {
    const path = join(__dirname, "fixtures", `${name}.json`);
    try {
      data[name] = readFileSync(path, "utf-8");
    } catch {
      // skip missing
    }
  }

  try {
    data.huge = readFileSync(join(__dirname, "fixtures", "huge.json"), "utf-8");
    fixtures.push("huge");
  } catch {}

  console.log("\n╔═════════════════════════════════════════════════════════════════════════════╗");
  console.log("║           End-to-End: parse → JSON.stringify                                ║");
  console.log("╚═════════════════════════════════════════════════════════════════════════════╝\n");

  for (const name of fixtures) {
    if (!data[name]) continue;
    const json = data[name];
    const sizeKB = (Buffer.byteLength(json) / 1024).toFixed(1);
    console.log(`  ─── ${name}.json (${sizeKB} KB) ───`);

    // JSON.stringify(JSON.parse(str))
    const jpResult = bench(() => {
      JSON.stringify(JSON.parse(json));
    });
    printResult("JSON.parse → JSON.stringify", jpResult);

    // partial-json parse → JSON.stringify
    const pjResult = bench(() => {
      JSON.stringify(partialParse(json));
    });
    printResult("partial-json → JSON.stringify", pjResult);

    // vj.stringify(vj.parse(str).value) — one WASM call for stringify
    const vjResult = bench(() => {
      vj.stringify(vj.parse(json).value);
    });
    printResult("vj.parse → vj.stringify", vjResult);

    const pjRatio = pjResult.opsPerSec / jpResult.opsPerSec;
    const ratio = vjResult.opsPerSec / jpResult.opsPerSec;
    console.log(
      `  ${"→ partial-json vs JSON".padEnd(35)} ${pjRatio.toFixed(2)}x ${pjRatio >= 1 ? "faster" : "slower"}`
    );
    console.log(
      `  ${"→ VectorJSON vs JSON".padEnd(35)} ${ratio.toFixed(2)}x ${ratio >= 1 ? "faster" : "slower"}\n`
    );
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
