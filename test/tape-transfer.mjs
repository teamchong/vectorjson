/**
 * Tape transfer tests — verify getTapeBuffer() + importTape() round-trip.
 */
import { parse, createParser, importTape, deepCompare } from "../dist/index.js";

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

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "Assertion failed");
}

/** Feed JSON string → getTapeBuffer → importTape. Returns the imported Proxy. */
function roundTrip(json) {
  const parser = createParser();
  parser.feed(json);
  const tape = parser.getTapeBuffer();
  parser.destroy();
  if (!tape) throw new Error("getTapeBuffer returned null");
  return importTape(tape);
}

console.log("\n🧪 Tape Transfer Tests\n");

await test("getTapeBuffer returns ArrayBuffer on complete parse", async () => {
  const parser = createParser();
  parser.feed('{"name":"Alice","age":30}');
  const tape = parser.getTapeBuffer();
  parser.destroy();
  assert(tape instanceof ArrayBuffer, "should be ArrayBuffer");
  assert(tape.byteLength > 8, "should have header + data");
});

await test("getTapeBuffer returns null on incomplete parse", async () => {
  const parser = createParser();
  parser.feed('{"name":"Ali');
  assert(parser.getTapeBuffer() === null, "should be null for incomplete");
  parser.destroy();
});

await test("round-trip matches direct parse", async () => {
  const json = '{"name":"Alice","age":30,"nested":{"x":[1,2,3]}}';
  const imported = roundTrip(json);
  const direct = parse(json).value;
  assert(deepCompare(imported, direct), "imported should equal direct parse");
});

await test("preserves strings with escapes", async () => {
  const obj = roundTrip('{"msg":"hello\\nworld","path":"C:\\\\Users"}');
  assertEqual(obj.msg, "hello\nworld");
  assertEqual(obj.path, "C:\\Users");
});

await test("preserves numbers (int, float, negative)", async () => {
  const obj = roundTrip('{"a":42,"b":3.14,"c":-100,"d":0}');
  assertEqual(obj.a, 42);
  assertEqual(obj.b, 3.14);
  assertEqual(obj.c, -100);
  assertEqual(obj.d, 0);
});

await test("preserves booleans and null", async () => {
  const obj = roundTrip('{"t":true,"f":false,"n":null}');
  assertEqual(obj.t, true);
  assertEqual(obj.f, false);
  assertEqual(obj.n, null);
});

await test("preserves nested objects and arrays", async () => {
  const obj = roundTrip(JSON.stringify({
    users: [
      { name: "Alice", scores: [100, 95, 88] },
      { name: "Bob", scores: [70, 80] },
    ],
    meta: { count: 2 },
  }));
  assertEqual(obj.users[0].name, "Alice");
  assertEqual(obj.users[0].scores[2], 88);
  assertEqual(obj.users[1].scores.length, 2);
  assertEqual(obj.meta.count, 2);
});

await test("imported result supports .free()", async () => {
  const obj = roundTrip('{"x":1}');
  assertEqual(obj.x, 1);
  obj.free(); // should not throw
});

await test("jsonl format round-trip", async () => {
  const parser = createParser({ format: "jsonl" });
  // Two JSONL values — getTapeBuffer should export only the first
  parser.feed('{"a":1}\n{"b":2}');
  const tape = parser.getTapeBuffer();
  assert(tape !== null, "getTapeBuffer should succeed for complete jsonl value");
  const obj = importTape(tape);
  assertEqual(obj.a, 1);
  // Second value should not leak into the first
  assertEqual(obj.b, undefined);
  parser.destroy();
});

await test("json5 format round-trip", async () => {
  const parser = createParser({ format: "json5" });
  // JSON5: unquoted keys, single-quoted strings, trailing comma, comments
  parser.feed(`{
    name: 'Alice', // line comment
    age: 30,
    /* block comment */
    tags: ['a', 'b',],
  }`);
  const tape = parser.getTapeBuffer();
  parser.destroy();
  assert(tape !== null, "getTapeBuffer should succeed for complete json5");
  const obj = importTape(tape);
  assertEqual(obj.name, "Alice");
  assertEqual(obj.age, 30);
  assertEqual(obj.tags[0], "a");
  assertEqual(obj.tags[1], "b");
  assertEqual(obj.tags.length, 2);
});

await test("large payload (1000 items)", async () => {
  const items = Array.from({ length: 1000 }, (_, i) => ({
    id: i, name: `item_${i}`, value: Math.random(),
  }));
  const obj = roundTrip(JSON.stringify({ items }));
  assertEqual(obj.items[0].id, 0);
  assertEqual(obj.items[999].name, "item_999");
  assertEqual(obj.items.length, 1000);
});

console.log(`\n✨ Tape Transfer Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
