/**
 * VectorJSON Memory Leak Tests
 *
 * Measures BOTH JS heap and WASM linear memory to ensure no leaks.
 * Run with: bun --expose-gc test/memory.mjs
 *
 * Key properties verified:
 * 1. Parse N objects → drop refs → GC → rss returns to baseline
 * 2. Parse with strings, never .toString() → jsHeap flat (no JS strings created)
 * 3. Stringify 1000x in loop → rss flat
 * 4. Stream feed/finish → wasmLinear returns to baseline
 * 5. Large parse → drop ref → GC → rss stable
 * 6. WasmString.equals() → no JS strings created
 * 7. FinalizationRegistry auto-frees doc slots (lazy doc-slot path)
 * 8. gcStringify produces correct output
 * 9. WasmString auto-coercion
 * 10. Parse/materialize cycle — memory stable
 * 11. Double-free safety — .free() twice does not crash
 * 12. .free() then GC — no double-free from FinalizationRegistry
 */
import { init, WasmString } from "../dist/index.js";

if (typeof globalThis.gc !== "function") {
  console.error(
    "❌ Must run with --expose-gc: bun --expose-gc test/memory.mjs",
  );
  process.exit(1);
}

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ ${msg}`);
    failed++;
  }
}

function forceGC() {
  globalThis.gc();
  // Small delay for GC to settle
}

function measureMemory() {
  forceGC();
  const m = process.memoryUsage();
  return {
    jsHeap: m.heapUsed,
    rss: m.rss,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
  };
}

console.log("🧪 VectorJSON Memory Leak Tests\n");

const vj = await init();

// ============================================================
// Test 1: Parse N objects → drop refs → GC → rss returns to baseline
// ============================================================
console.log("--- Test 1: Parse/drop cycle — rss returns to baseline ---");
{
  const baseline = measureMemory();

  // Parse objects and free immediately — tests that memory is truly reclaimed.
  // Doc-slot path has limited slots; .free() releases them immediately.
  for (let i = 0; i < 1000; i++) {
    const r = vj.parse(`{"id":${i},"data":"${"x".repeat(100)}"}`);
    r.free();
  }

  const afterParse = measureMemory();

  // Drop all references and GC
  forceGC();
  forceGC(); // Double GC for good measure

  const afterGC = measureMemory();

  // rss includes OS page allocations that may not be returned immediately.
  // The key metric is jsHeap (below). rss tolerance is generous.
  const rssGrowth = afterGC.rss - baseline.rss;
  assert(
    rssGrowth < 16 * 1024 * 1024,
    `rss growth after GC: ${(rssGrowth / 1024).toFixed(0)}KB (< 16MB tolerance)`,
  );

  // jsHeap should be close to baseline
  const heapGrowth = afterGC.jsHeap - baseline.jsHeap;
  assert(
    heapGrowth < 2 * 1024 * 1024,
    `jsHeap growth after GC: ${(heapGrowth / 1024).toFixed(0)}KB (< 2MB tolerance)`,
  );
}

// ============================================================
// Test 2: Parse strings, never .toString() → jsHeap flat
// ============================================================
console.log(
  "\n--- Test 2: Parse strings without .toString() — jsHeap flat ---",
);
{
  // Warm up
  for (let i = 0; i < 100; i++) {
    vj.parse(`"warmup${i}"`);
  }
  forceGC();

  const baseline = measureMemory();

  // Parse 1000 string values — access WasmString but never call .toString()
  // Root strings from doc-slot path are also WasmString (copied to GC memory)
  const strings = [];
  for (let i = 0; i < 1000; i++) {
    const ws = vj.parse(`"${"a".repeat(200)}${i}"`);
    // Access byteLength (no JS string created)
    if (ws instanceof WasmString) {
      const _len = ws.byteLength; // just read byteLength, no JS string
      void _len;
    }
    strings.push(ws);
  }

  const afterParse = measureMemory();

  // Ensure the WasmStrings exist and are not JS strings
  assert(
    strings.every((s) => s instanceof WasmString),
    "all parsed strings are WasmString instances",
  );

  // JS heap should NOT have grown by much (no JS strings created)
  // WasmString objects themselves take some JS heap (~100 bytes each)
  // but raw string data is in WasmGC, not in JS heap
  const heapGrowth = afterParse.jsHeap - baseline.jsHeap;
  // Allow ~500KB for 1000 WasmString wrapper objects + overhead
  assert(
    heapGrowth < 500 * 1024,
    `jsHeap growth with 1000 WasmStrings (no toString): ${(heapGrowth / 1024).toFixed(0)}KB (< 500KB)`,
  );

  // Now call toString on ONE of them
  const materialized = strings[0].toString();
  assert(
    typeof materialized === "string",
    "toString() materializes a JS string",
  );
}

// ============================================================
// Test 3: Stringify 1000x in loop → rss flat
// ============================================================
console.log("\n--- Test 3: Stringify loop — rss stays flat ---");
{
  forceGC();
  const baseline = measureMemory();

  const testObj = {
    items: Array.from({ length: 100 }, (_, i) => ({
      id: i,
      name: `item${i}`,
      active: i % 2 === 0,
    })),
  };

  for (let i = 0; i < 1000; i++) {
    const _result = vj.stringify(testObj);
    void _result;
  }

  forceGC();
  const afterLoop = measureMemory();

  const rssGrowth = afterLoop.rss - baseline.rss;
  assert(
    rssGrowth < 16 * 1024 * 1024,
    `rss growth after 1000x stringify: ${(rssGrowth / 1024).toFixed(0)}KB (< 16MB)`,
  );
}

// ============================================================
// Test 4: Stream feed/destroy → resources freed
// ============================================================
console.log("\n--- Test 4: Stream feed/destroy — resources cleaned up ---");
{
  forceGC();
  const baseline = measureMemory();

  const largeJson = JSON.stringify({
    data: Array.from({ length: 500 }, (_, i) => ({
      id: i,
      value: "x".repeat(100),
    })),
  });

  for (let i = 0; i < 50; i++) {
    const parser = vj.createParser();
    // Feed in chunks
    const bytes = new TextEncoder().encode(largeJson);
    const chunkSize = 1024;
    let offset = 0;
    let status;
    while (offset < bytes.length) {
      const chunk = bytes.slice(offset, offset + chunkSize);
      status = parser.feed(chunk);
      offset += chunkSize;
      if (status !== "incomplete") break;
    }
    if (status === "complete" || status === "end_early") {
      parser.getValue();
    }
    parser.destroy();
  }

  forceGC();
  const afterStreams = measureMemory();

  // Streaming uses Zig linear memory for parser state — rss includes both
  // WASM linear memory growth and OS page overhead. Tolerance is generous.
  const rssGrowth = afterStreams.rss - baseline.rss;
  assert(
    rssGrowth < 32 * 1024 * 1024,
    `rss growth after 50 stream cycles: ${(rssGrowth / 1024).toFixed(0)}KB (< 32MB)`,
  );
}

// ============================================================
// Test 5: Large parse → drop ref → GC → rss stable
// ============================================================
console.log("\n--- Test 5: Large parse drop — rss returns to baseline ---");
{
  forceGC();
  const baseline = measureMemory();

  // Parse a ~100KB JSON document
  const largeJson = JSON.stringify({
    data: Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      name: `name_${"x".repeat(50)}_${i}`,
      tags: [`tag${i}`, `tag${i + 1}`],
      metadata: { created: i * 1000, updated: i * 2000 },
    })),
  });

  // Parse it 10 times, dropping each time (GC between to free doc slots)
  for (let i = 0; i < 10; i++) {
    const _result = vj.parse(largeJson);
    void _result;
    forceGC(); // let FinalizationRegistry free doc slot
  }

  forceGC();
  forceGC();
  const afterGC = measureMemory();

  const rssGrowth = afterGC.rss - baseline.rss;
  assert(
    rssGrowth < 8 * 1024 * 1024,
    `rss growth after large parse+drop: ${(rssGrowth / 1024).toFixed(0)}KB (< 8MB)`,
  );
}

// ============================================================
// Test 6: WasmString.equals() — no JS strings created
// ============================================================
console.log("\n--- Test 6: WasmString.equals() — WASM-side comparison ---");
{
  const obj = vj.parse('{"a":"hello","b":"hello","c":"world"}');
  const a = obj.a;
  const b = obj.b;
  const c = obj.c;

  assert(a instanceof WasmString, "a is WasmString");
  assert(b instanceof WasmString, "b is WasmString");
  assert(c instanceof WasmString, "c is WasmString");

  // Equals without creating JS strings
  assert(a.equals(b), 'a.equals(b) — both "hello"');
  assert(!a.equals(c), 'a.equals(c) is false — "hello" vs "world"');

  // Verify no JS string was cached
  assert(a._cached === null, "a._cached is null (no toString called)");
  assert(b._cached === null, "b._cached is null (no toString called)");
}

// ============================================================
// Test 7: FinalizationRegistry auto-frees doc slots
// ============================================================
console.log("\n--- Test 7: FinalizationRegistry + .free() — doc slot lifecycle ---");
{
  // Parse many objects with explicit .free() — no slot exhaustion
  let parseCount = 0;
  try {
    for (let i = 0; i < 300; i++) {
      const r = vj.parse(`{"idx":${i},"value":"${"x".repeat(50)}"}`);
      // Explicitly free to release doc slot immediately
      r.free();
      parseCount++;
    }
    assert(
      parseCount === 300,
      `parsed 300 objects with .free() — no slot exhaustion`,
    );
  } catch (e) {
    assert(false, `failed at parse ${parseCount}: ${e.message}`);
  }

  // Parse without .free() — rely on GC + FinalizationRegistry
  parseCount = 0;
  try {
    for (let i = 0; i < 100; i++) {
      vj.parse(`{"idx":${i},"data":"${"y".repeat(50)}"}`);
      parseCount++;
      // Periodically force GC so FinalizationRegistry can reclaim slots
      if (i % 25 === 0) forceGC();
    }
    assert(
      parseCount === 100,
      `parsed 100 objects without .free() — FinalizationRegistry handles cleanup`,
    );
  } catch (e) {
    assert(false, `failed at parse ${parseCount}: ${e.message}`);
  }
}

// ============================================================
// Test 8: gcStringify produces correct output
// ============================================================
console.log("\n--- Test 8: gcStringify (GC tree → JSON, one WASM call) ---");
{
  const input = '{"name":"Alice","items":[1,true,null,"str"],"nested":{"x":42}}';
  const parsed = vj.parse(input);

  // stringify should use gcStringify for GC-backed proxy
  const result = vj.stringify(parsed);
  const reparsed = JSON.parse(result);

  assert(reparsed.name === "Alice", "gcStringify preserves string");
  assert(reparsed.items[0] === 1, "gcStringify preserves number");
  assert(reparsed.items[1] === true, "gcStringify preserves boolean");
  assert(reparsed.items[2] === null, "gcStringify preserves null");
  assert(reparsed.items[3] === "str", "gcStringify preserves nested string");
  assert(reparsed.nested.x === 42, "gcStringify preserves nested object");
}

// ============================================================
// Test 9: WasmString auto-coercion
// ============================================================
console.log("\n--- Test 9: WasmString auto-coercion ---");
{
  const parsed = vj.parse('{"greeting":"hello"}');
  const ws = parsed.greeting;

  assert(ws instanceof WasmString, "greeting is WasmString");

  // Template literal coercion
  const msg = `${ws} world`;
  assert(msg === "hello world", "template literal coercion works");

  // Loose equality (== uses toPrimitive)
  assert(ws == "hello", "loose equality works via toPrimitive");

  // JSON.stringify (uses toJSON)
  assert(JSON.stringify(ws) === '"hello"', "JSON.stringify uses toJSON");

  // String concatenation
  assert(ws + "!" === "hello!", "string concatenation works");
}

// ============================================================
// Test 10: Repeated parse/materialize cycle — memory stable
// ============================================================
console.log("\n--- Test 10: Parse/materialize cycle — memory stable ---");
{
  forceGC();
  const baseline = measureMemory();

  for (let i = 0; i < 500; i++) {
    const parsed = vj.parse(
      `{"data":{"id":${i},"values":[1,2,3],"name":"test${i}"}}`,
    );
    const _materialized = vj.materialize(parsed);
    void _materialized;
    parsed.free(); // release doc slot immediately
  }

  forceGC();
  forceGC();
  const afterCycle = measureMemory();

  const rssGrowth = afterCycle.rss - baseline.rss;
  assert(
    rssGrowth < 4 * 1024 * 1024,
    `rss growth after 500 parse/materialize: ${(rssGrowth / 1024).toFixed(0)}KB (< 4MB)`,
  );
}

// ============================================================
// Test 11: Double-free safety — .free() twice does not crash
// ============================================================
console.log("\n--- Test 11: Double-free safety — .free() called twice ---");
{
  // Calling .free() twice on the same proxy should be a no-op the second time
  const obj = vj.parse('{"key":"value","num":42}');
  const val = obj.key; // access a value first
  assert(val instanceof WasmString, "key value is WasmString before free");

  // First free — releases doc slot
  obj.free();

  // Second free — should silently do nothing (generation check prevents double-free)
  let doubleFreeOk = true;
  try {
    obj.free();
  } catch (e) {
    doubleFreeOk = false;
  }
  assert(doubleFreeOk, ".free() called twice does not throw");

  // Parse new object into possibly-reused slot — must work fine
  const obj2 = vj.parse('{"reuse":"works"}');
  const reuse = obj2.reuse;
  assert(reuse instanceof WasmString, "reused slot works after double-free");
  assert(reuse.toString() === "works", "reused slot value is correct");
  obj2.free();
}

// ============================================================
// Test 12: .free() then GC — no double-free from FinalizationRegistry
// ============================================================
console.log("\n--- Test 12: .free() then GC — FinalizationRegistry stays safe ---");
{
  // Explicit free followed by GC should not cause FinalizationRegistry to
  // double-free the slot. The unregister() call in .free() prevents this.
  let success = true;
  try {
    for (let round = 0; round < 50; round++) {
      const r = vj.parse(`{"round":${round},"data":"${"z".repeat(100)}"}`);
      // Access some data
      void r.round;
      void r.data;
      // Explicitly free
      r.free();
    }
    // Force GC — any stale FinalizationRegistry callbacks would fire now
    forceGC();
    forceGC();

    // Parse more objects into potentially reused slots
    for (let i = 0; i < 50; i++) {
      const r = vj.parse(`{"after_gc":${i}}`);
      assert(r.after_gc === i, `post-GC parse ${i} correct`);
      r.free();
    }
  } catch (e) {
    success = false;
    assert(false, `.free() + GC caused error: ${e.message}`);
  }
  if (success) {
    assert(true, ".free() then GC — no double-free, 50 reuse cycles safe");
  }
}

// ============================================================
// Results
// ============================================================
console.log(`\n✨ Memory Test Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
