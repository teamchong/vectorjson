/**
 * Phase 2: Streaming parser tests.
 * Tests incremental feeding of JSON chunks, status detection, and NDJSON.
 */
import { init } from "../dist/index.js";

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.error(`  ❌ ${name}: ${err.message}`); }
}

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(msg || `Expected ${e}, got ${a}`);
}

console.log("\n🧪 VectorJSON Phase 2 — Streaming Parser Tests\n");
const vj = await init();

// --- Basic streaming ---
await test("stream: feed complete JSON in one chunk", () => {
  const p = vj.createParser();
  const status = p.feed('{"hello":"world"}');
  assertEqual(status, "complete");
  assertEqual(p.getValue(), { hello: "world" });
  p.destroy();
});

await test("stream: feed JSON in multiple chunks", () => {
  const p = vj.createParser();
  assertEqual(p.feed('{"hel'), "incomplete");
  assertEqual(p.feed('lo":"w'), "incomplete");
  assertEqual(p.feed('orld"}'), "complete");
  assertEqual(p.getValue(), { hello: "world" });
  p.destroy();
});

await test("stream: feed array in chunks", () => {
  const p = vj.createParser();
  assertEqual(p.feed("[1,"), "incomplete");
  assertEqual(p.feed("2,"), "incomplete");
  assertEqual(p.feed("3]"), "complete");
  assertEqual(p.getValue(), [1, 2, 3]);
  p.destroy();
});

await test("stream: deeply nested in tiny chunks", () => {
  const json = '{"a":{"b":{"c":[1,2,3]}}}';
  const p = vj.createParser();
  for (let i = 0; i < json.length - 1; i++) {
    const status = p.feed(json[i]);
    if (status !== "incomplete") throw new Error(`Unexpected status at char ${i}: ${status}`);
  }
  assertEqual(p.feed(json[json.length - 1]), "complete");
  assertEqual(p.getValue(), { a: { b: { c: [1, 2, 3] } } });
  p.destroy();
});

await test("stream: scalar value", () => {
  const p = vj.createParser();
  assertEqual(p.feed("42"), "complete");
  assertEqual(p.getValue(), 42);
  p.destroy();
});

await test("stream: string value", () => {
  const p = vj.createParser();
  assertEqual(p.feed('"he'), "incomplete");
  assertEqual(p.feed('llo"'), "complete");
  assertEqual(p.getValue(), "hello");
  p.destroy();
});

await test("stream: boolean values", () => {
  const p1 = vj.createParser();
  assertEqual(p1.feed("true"), "complete");
  assertEqual(p1.getValue(), true);
  p1.destroy();

  const p2 = vj.createParser();
  assertEqual(p2.feed("false"), "complete");
  assertEqual(p2.getValue(), false);
  p2.destroy();
});

await test("stream: null value", () => {
  const p = vj.createParser();
  assertEqual(p.feed("null"), "complete");
  assertEqual(p.getValue(), null);
  p.destroy();
});

// --- NDJSON / end_early ---
await test("stream: end_early with trailing data", () => {
  const p = vj.createParser();
  const status = p.feed('{"a":1}\n{"b":2}');
  assertEqual(status, "end_early");
  assertEqual(p.getValue(), { a: 1 });
  const remaining = p.getRemaining();
  if (!remaining) throw new Error("Expected remaining bytes");
  const remainingStr = new TextDecoder().decode(remaining);
  assertEqual(remainingStr, '{"b":2}');
  p.destroy();
});

await test("stream: end_early with two JSON objects", () => {
  const p = vj.createParser();
  assertEqual(p.feed('[1,2][3,4]'), "end_early");
  assertEqual(p.getValue(), [1, 2]);
  const remaining = p.getRemaining();
  assertEqual(new TextDecoder().decode(remaining), "[3,4]");
  p.destroy();
});

// --- Status checks ---
await test("stream: getStatus reflects current state", () => {
  const p = vj.createParser();
  assertEqual(p.getStatus(), "incomplete");
  p.feed('{"x": ');
  assertEqual(p.getStatus(), "incomplete");
  p.feed("1}");
  assertEqual(p.getStatus(), "complete");
  p.destroy();
});

await test("stream: getValue caches result", () => {
  const p = vj.createParser();
  p.feed('{"a":1}');
  const v1 = p.getValue();
  const v2 = p.getValue();
  assertEqual(v1 === v2, true, "Should return same cached reference");
  p.destroy();
});

await test("stream: getValue on incomplete returns undefined", () => {
  const p = vj.createParser();
  p.feed('{"incomplete');
  const val = p.getValue();
  if (val !== undefined) throw new Error("Expected undefined for incomplete parse");
  p.destroy();
});

// --- Multiple concurrent streams ---
await test("stream: multiple concurrent parsers", () => {
  const p1 = vj.createParser();
  const p2 = vj.createParser();
  p1.feed('{"a":');
  p2.feed("[");
  p1.feed("1}");
  p2.feed("2]");
  assertEqual(p1.getValue(), { a: 1 });
  assertEqual(p2.getValue(), [2]);
  p1.destroy();
  p2.destroy();
});

// --- Byte input ---
await test("stream: feed Uint8Array chunks", () => {
  const p = vj.createParser();
  const encoder = new TextEncoder();
  p.feed(encoder.encode('{"key":'));
  p.feed(encoder.encode('"value"}'));
  assertEqual(p.getValue(), { key: "value" });
  p.destroy();
});

// --- Large streaming ---
await test("stream: 1KB chunks of large JSON", () => {
  const arr = Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item_${i}` }));
  const json = JSON.stringify(arr);
  const p = vj.createParser();
  const chunkSize = 1024;
  for (let i = 0; i < json.length; i += chunkSize) {
    const chunk = json.slice(i, i + chunkSize);
    const status = p.feed(chunk);
    if (i + chunkSize >= json.length) {
      assertEqual(status, "complete", `Final chunk should complete, got ${status}`);
    }
  }
  const result = p.getValue();
  assertEqual(JSON.stringify(result), json);
  p.destroy();
});

// --- String with escapes in stream ---
await test("stream: string with escapes split across chunks", () => {
  const p = vj.createParser();
  p.feed('{"msg": "hello\\');
  assertEqual(p.getStatus(), "incomplete");
  p.feed('nworld"}');
  assertEqual(p.getStatus(), "complete");
  const result = /** @type {any} */ (p.getValue());
  assertEqual(result.msg, "hello\nworld");
  p.destroy();
});

console.log(`\n✨ Phase 2 Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
