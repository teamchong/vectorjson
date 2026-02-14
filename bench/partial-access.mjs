/**
 * Benchmark: Partial Access — the real win of Path B
 *
 * Measures the time to parse AND access a small subset of a large JSON.
 * This is the common real-world pattern: parse a large API response,
 * but only need a few fields.
 *
 * Usage:
 *   node --expose-gc bench/partial-access.mjs
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

function bench(fn, { warmup = 50, durationMs = 2000 } = {}) {
  for (let i = 0; i < warmup; i++) fn();
  forceGC();

  let ops = 0;
  const start = performance.now();
  const deadline = start + durationMs;
  while (performance.now() < deadline) {
    fn();
    ops++;
  }
  const elapsed = performance.now() - start;
  return {
    opsPerSec: (ops / elapsed) * 1000,
    meanMs: elapsed / ops,
    totalMs: elapsed,
    ops,
  };
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

function printResult(label, stats) {
  console.log(
    `  ${label.padEnd(40)} ${formatNum(stats.opsPerSec).padStart(10)} ops/s  ` +
      `${formatTime(stats.meanMs).padStart(10)}`
  );
}

async function run() {
  const vj = await init();

  // --- Synthetic: large array with many objects ---
  const syntheticItems = [];
  for (let i = 0; i < 10000; i++) {
    syntheticItems.push({
      id: i,
      name: `item_${i}`,
      description: `This is a detailed description for item number ${i} with some extra text to make it larger.`,
      tags: ["alpha", "beta", "gamma"],
      metadata: { created: "2024-01-01", score: Math.random() * 100 },
    });
  }
  const syntheticJson = JSON.stringify({ items: syntheticItems, total: 10000 });
  const syntheticSizeKB = (Buffer.byteLength(syntheticJson) / 1024).toFixed(1);

  console.log(
    "\n╔══════════════════════════════════════════════════════════════════════════════╗"
  );
  console.log(
    "║              Partial Access Benchmark — Path B True Lazy                    ║"
  );
  console.log(
    "╚══════════════════════════════════════════════════════════════════════════════╝\n"
  );

  // ==============================================
  // Test 1: Access ONLY the "total" field (1 property)
  // ==============================================
  console.log(
    `  ─── Synthetic (${syntheticSizeKB} KB, 10K items) — Access 1 field: .total ───`
  );

  printResult(
    "JSON.parse → .total",
    bench(() => {
      const r = JSON.parse(syntheticJson);
      return r.total;
    })
  );
  printResult(
    "VectorJSON.parse → .total",
    bench(() => {
      const r = vj.parse(syntheticJson);
      const v = r.total;
      r.close();
      return v;
    })
  );
  console.log();

  // ==============================================
  // Test 2: Access first item's name
  // ==============================================
  console.log(
    `  ─── Synthetic (${syntheticSizeKB} KB) — Access .items[0].name ───`
  );

  printResult(
    "JSON.parse → .items[0].name",
    bench(() => {
      const r = JSON.parse(syntheticJson);
      return r.items[0].name;
    })
  );
  printResult(
    "VectorJSON.parse → .items[0].name",
    bench(() => {
      const r = vj.parse(syntheticJson);
      const v = r.items[0].name;
      r.close();
      return v;
    })
  );
  console.log();

  // ==============================================
  // Test 3: Access 10 items out of 10,000
  // ==============================================
  console.log(
    `  ─── Synthetic (${syntheticSizeKB} KB) — Access 10 items (.id + .name) ───`
  );

  printResult(
    "JSON.parse → 10 items",
    bench(() => {
      const r = JSON.parse(syntheticJson);
      let sum = 0;
      for (let i = 0; i < 10; i++) {
        sum += r.items[i].id;
        void r.items[i].name;
      }
      return sum;
    })
  );
  printResult(
    "VectorJSON.parse → 10 items",
    bench(() => {
      const r = vj.parse(syntheticJson);
      let sum = 0;
      for (let i = 0; i < 10; i++) {
        sum += r.items[i].id;
        void r.items[i].name;
      }
      r.close();
      return sum;
    })
  );
  console.log();

  // ==============================================
  // Test 4: Full materialization (worst case for lazy)
  // ==============================================
  console.log(
    `  ─── Synthetic (${syntheticSizeKB} KB) — Full access (all items) ───`
  );

  printResult(
    "JSON.parse (full)",
    bench(
      () => {
        const r = JSON.parse(syntheticJson);
        let sum = 0;
        for (let i = 0; i < r.items.length; i++) {
          sum += r.items[i].id;
        }
        return sum;
      },
      { durationMs: 1500 }
    )
  );
  printResult(
    "VectorJSON.parse (full access)",
    bench(
      () => {
        const r = vj.parse(syntheticJson);
        const items = r.items;
        let sum = 0;
        for (let i = 0; i < items.length; i++) {
          sum += items[i].id;
        }
        r.close();
        return sum;
      },
      { durationMs: 1500 }
    )
  );
  console.log();

  // ==============================================
  // Test 5: Real fixtures — partial access
  // ==============================================
  for (const name of ["large", "xlarge"]) {
    let json;
    try {
      json = readFileSync(
        join(__dirname, "fixtures", `${name}.json`),
        "utf-8"
      );
    } catch {
      continue;
    }
    const sizeKB = (Buffer.byteLength(json) / 1024).toFixed(1);

    // Parse once to discover structure
    const sample = JSON.parse(json);
    const topKeys = Object.keys(sample);
    const firstKey = topKeys[0];

    console.log(
      `  ─── ${name}.json (${sizeKB} KB) — Access first key: "${firstKey}" ───`
    );

    printResult(
      `JSON.parse → .${firstKey}`,
      bench(() => {
        const r = JSON.parse(json);
        return r[firstKey];
      })
    );
    printResult(
      `VectorJSON.parse → .${firstKey}`,
      bench(() => {
        const r = vj.parse(json);
        const v = r[firstKey];
        r.close();
        return v;
      })
    );

    const speedupJP = bench(() => {
      const r = JSON.parse(json);
      return r[firstKey];
    }).opsPerSec;
    const speedupVJ = bench(() => {
      const r = vj.parse(json);
      const v = r[firstKey];
      r.close();
      return v;
    }).opsPerSec;
    console.log(
      `  → VectorJSON speedup: ${(speedupVJ / speedupJP).toFixed(2)}x\n`
    );
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
