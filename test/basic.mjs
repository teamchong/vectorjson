/**
 * Basic verification test for VectorJSON Phase 0.
 *
 * Tests: Zig engine compiles to WASM + WAT shim links + JS loads both
 *        + parses {"hello": "world"} + returns correct JS object.
 */

import { init } from "../dist/index.js";

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
  } catch (err) {
    console.error(`  ❌ ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "Assertion failed");
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(
      message || `Expected ${e}, got ${a}`
    );
  }
}

console.log("\n🧪 VectorJSON Basic Tests\n");

// Initialize
const vj = await init();

await test("parse simple object", () => {
  const result = vj.parse('{"hello": "world"}');
  assertEqual(result, { hello: "world" });
});

await test("parse nested object", () => {
  const result = vj.parse('{"a": {"b": 1, "c": true}}');
  assertEqual(result, { a: { b: 1, c: true } });
});

await test("parse array", () => {
  const result = vj.parse("[1, 2, 3]");
  assertEqual(result, [1, 2, 3]);
});

await test("parse mixed types", () => {
  const result = vj.parse('[null, true, false, 42, "hello", {"key": "val"}]');
  assertEqual(result, [null, true, false, 42, "hello", { key: "val" }]);
});

await test("parse number types", () => {
  const result = vj.parse('{"int": 42, "neg": -7, "float": 3.14}');
  const obj = /** @type {any} */ (result);
  assertEqual(obj.int, 42);
  assertEqual(obj.neg, -7);
  assert(Math.abs(obj.float - 3.14) < 0.001, `Expected 3.14, got ${obj.float}`);
});

await test("parse empty containers", () => {
  assertEqual(vj.parse("{}"), {});
  assertEqual(vj.parse("[]"), []);
});

await test("parse string with escapes", () => {
  const result = vj.parse('{"msg": "hello\\nworld"}');
  const obj = /** @type {any} */ (result);
  assertEqual(obj.msg, "hello\nworld");
});

await test("parse deeply nested", () => {
  const result = vj.parse('{"a": {"b": {"c": {"d": 42}}}}');
  assertEqual(result, { a: { b: { c: { d: 42 } } } });
});

await test("parse Uint8Array input", () => {
  const bytes = new TextEncoder().encode('{"binary": true}');
  const result = vj.parse(bytes);
  assertEqual(result, { binary: true });
});

await test("parse error throws SyntaxError", async () => {
  let threw = false;
  try {
    vj.parse("{invalid json}");
  } catch (err) {
    threw = true;
    assert(err instanceof SyntaxError, `Expected SyntaxError, got ${err.constructor.name}`);
  }
  assert(threw, "Expected parse to throw");
});

await test("parse scalar values", () => {
  assertEqual(vj.parse("42"), 42);
  assertEqual(vj.parse("true"), true);
  assertEqual(vj.parse("false"), false);
  assertEqual(vj.parse("null"), null);
  assertEqual(vj.parse('"hello"'), "hello");
});

await test("round-trip: JSON.stringify(vectorjson.parse(x)) === x", () => {
  const inputs = [
    '{"a":1,"b":2}',
    '[1,2,3]',
    '"hello"',
    '42',
    'true',
    'false',
    'null',
  ];
  for (const input of inputs) {
    const result = vj.parse(input);
    const output = JSON.stringify(result);
    assertEqual(output, input, `Round-trip failed for: ${input}`);
  }
});

console.log("\n✨ All tests complete!\n");
