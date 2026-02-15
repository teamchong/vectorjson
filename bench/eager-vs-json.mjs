/**
 * Benchmark: Eager Materialization — VectorJSON vs JSON.parse
 *
 * Tests shape-aware constructor caching + key interning.
 * Usage: bun bench/eager-vs-json.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { init } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function bench(fn, { warmup = 100, durationMs = 3000 } = {}) {
  for (let i = 0; i < warmup; i++) fn();
  let ops = 0;
  const start = performance.now();
  const deadline = start + durationMs;
  while (performance.now() < deadline) { fn(); ops++; }
  const elapsed = performance.now() - start;
  return { ops, opsPerSec: (ops / elapsed) * 1000, meanMs: elapsed / ops };
}

function fmt(ms) {
  if (ms < 0.001) return (ms * 1e6).toFixed(0) + " ns";
  if (ms < 1) return (ms * 1e3).toFixed(1) + " µs";
  return ms.toFixed(2) + " ms";
}

async function run() {
  const vj = await init();

  // Generate homogeneous test data (typical API response)
  const homogeneous = JSON.stringify({
    data: Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      name: `user_${i}`,
      email: `user${i}@example.com`,
      active: i % 2 === 0,
      score: Math.random() * 100,
    })),
  });

  // Generate heterogeneous test data (varied shapes)
  const heterogeneous = JSON.stringify({
    users: Array.from({ length: 200 }, (_, i) => ({
      id: i,
      name: `user_${i}`,
      ...(i % 2 === 0 ? { email: `u${i}@x.com` } : {}),
      ...(i % 3 === 0 ? { role: "admin" } : {}),
      ...(i % 5 === 0 ? { tags: ["a", "b"] } : {}),
    })),
    settings: { theme: "dark", lang: "en" },
    meta: { total: 200, page: 1 },
  });

  // Load fixture files if available
  const fixtures = {};
  for (const name of ["small", "medium", "large"]) {
    const path = join(__dirname, "fixtures", `${name}.json`);
    if (existsSync(path)) {
      fixtures[name] = readFileSync(path, "utf-8");
    }
  }

  console.log("\n╔═══════════════════════════════════════════════════════════════════╗");
  console.log("║        Eager Materialization — Shape-Aware Constructors          ║");
  console.log("╚═══════════════════════════════════════════════════════════════════╝\n");

  const tests = [
    ["homogeneous (1000 same-shape objs)", homogeneous],
    ["heterogeneous (varied shapes)", heterogeneous],
    ...Object.entries(fixtures).map(([name, data]) => [`fixture: ${name}.json (${(data.length / 1024).toFixed(1)}KB)`, data]),
  ];

  for (const [label, json] of tests) {
    console.log(`  ─── ${label} ───`);

    // JSON.parse
    const jp = bench(() => JSON.parse(json));
    console.log(`  ${"JSON.parse".padEnd(35)} ${fmt(jp.meanMs).padStart(10)}  (${jp.opsPerSec.toFixed(0)} ops/s)`);

    // VectorJSON eager
    const ve = bench(() => vj.parse(json, { mode: "eager" }));
    console.log(`  ${"VectorJSON eager".padEnd(35)} ${fmt(ve.meanMs).padStart(10)}  (${ve.opsPerSec.toFixed(0)} ops/s)`);

    // VectorJSON lazy (for reference)
    const vl = bench(() => vj.parse(json));
    console.log(`  ${"VectorJSON lazy (no materialize)".padEnd(35)} ${fmt(vl.meanMs).padStart(10)}  (${vl.opsPerSec.toFixed(0)} ops/s)`);

    // VectorJSON lazy + full materialize (simulate eager via lazy + JSON.stringify)
    const vm = bench(() => {
      const r = vj.parse(json);
      const m = vj.materialize(r);
      return m;
    });
    console.log(`  ${"VectorJSON lazy+materialize".padEnd(35)} ${fmt(vm.meanMs).padStart(10)}  (${vm.opsPerSec.toFixed(0)} ops/s)`);

    const ratio = ve.meanMs / jp.meanMs;
    console.log(`  → eager vs JSON.parse: ${ratio.toFixed(2)}x ${ratio <= 1 ? "FASTER ✅" : "slower"}\n`);
  }

  // Repeated parse benchmark (tests constructor cache warmth)
  console.log("╔═══════════════════════════════════════════════════════════════════╗");
  console.log("║       Repeated Parse (Same Shape — Constructor Cache Warm)       ║");
  console.log("╚═══════════════════════════════════════════════════════════════════╝\n");

  const small = JSON.stringify({ id: 1, name: "Alice", email: "a@b.com", active: true });
  console.log(`  ─── small object: ${small} ───`);

  const jpSmall = bench(() => JSON.parse(small), { warmup: 1000, durationMs: 3000 });
  console.log(`  ${"JSON.parse".padEnd(35)} ${fmt(jpSmall.meanMs).padStart(10)}  (${jpSmall.opsPerSec.toFixed(0)} ops/s)`);

  const veSmall = bench(() => vj.parse(small, { mode: "eager" }), { warmup: 1000, durationMs: 3000 });
  console.log(`  ${"VectorJSON eager (cached ctor)".padEnd(35)} ${fmt(veSmall.meanMs).padStart(10)}  (${veSmall.opsPerSec.toFixed(0)} ops/s)`);

  const ratioSmall = veSmall.meanMs / jpSmall.meanMs;
  console.log(`  → ratio: ${ratioSmall.toFixed(2)}x ${ratioSmall <= 1 ? "FASTER ✅" : "slower"}\n`);
}

run().catch(e => { console.error(e); process.exit(1); });
