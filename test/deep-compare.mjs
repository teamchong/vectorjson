/**
 * Tests: deepCompare — WASM-backed structural equality.
 *
 * Covers: primitives, cross-type numbers, strings (short/long/escapes/unicode),
 * arrays, objects, nesting, edge cases, fixtures, Uint8Array input, and
 * JS fallback path.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { init } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.error(`  ❌ ${name}: ${err.message}`); }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "Assertion failed");
}

console.log("\n🧪 VectorJSON — Deep Compare Tests\n");
const vj = await init();

// --- Helpers ---
/** Parse JSON and return the proxy/value */
function p(json) {
  return vj.parse(json).value;
}
/** Parse from Uint8Array and return the proxy/value */
function pBytes(json) {
  return vj.parse(new TextEncoder().encode(json)).value;
}
/** Assert deep comparison result */
function eq(a, b, expected, msg) {
  const result = vj.deepCompare(a, b);
  assert(result === expected, msg || `Expected ${expected}, got ${result}`);
}
/** Assert deep comparison with options */
function eqOpts(a, b, opts, expected, msg) {
  const result = vj.deepCompare(a, b, opts);
  assert(result === expected, msg || `Expected ${expected}, got ${result}`);
}

// ═══════════════════════════════════════════════
// Equal primitives
// ═══════════════════════════════════════════════
await test("equal: null", () => eq(p("null"), p("null"), true));
await test("equal: true", () => eq(p("true"), p("true"), true));
await test("equal: false", () => eq(p("false"), p("false"), true));
await test("equal: integer", () => eq(p("42"), p("42"), true));
await test("equal: zero", () => eq(p("0"), p("0"), true));
await test("equal: negative integer", () => eq(p("-7"), p("-7"), true));
await test("equal: float", () => eq(p("3.14"), p("3.14"), true));
await test("equal: string", () => eq(p('"hello"'), p('"hello"'), true));
await test("equal: empty string", () => eq(p('""'), p('""'), true));

// ═══════════════════════════════════════════════
// Unequal primitives
// ═══════════════════════════════════════════════
await test("unequal: null vs true", () => eq(p("null"), p("true"), false));
await test("unequal: null vs false", () => eq(p("null"), p("false"), false));
await test("unequal: true vs false", () => eq(p("true"), p("false"), false));
await test("unequal: different numbers", () => eq(p("42"), p("43"), false));
await test("unequal: different strings", () => eq(p('"hello"'), p('"world"'), false));
await test("unequal: string length mismatch", () => eq(p('"hi"'), p('"hello"'), false));
await test("unequal: number vs string", () => eq(p("42"), p('"42"'), false));
await test("unequal: null vs 0", () => eq(p("null"), p("0"), false));
await test("unequal: false vs 0", () => eq(p("false"), p("0"), false));
await test("unequal: null vs empty string", () => eq(p("null"), p('""'), false));
await test("unequal: empty array vs empty object", () => eq(p("[]"), p("{}"), false));

// ═══════════════════════════════════════════════
// Cross-type numbers: unsigned vs double vs signed
// ═══════════════════════════════════════════════
await test("cross-type: unsigned 42 vs double 42.0", () =>
  eq(p("42"), p("42.0"), true));
await test("cross-type: negative signed vs double", () =>
  eq(p("-5"), p("-5.0"), true));
await test("cross-type: large number 1e6", () =>
  eq(p("1000000"), p("1e6"), true));
await test("cross-type: zero int vs zero float", () =>
  eq(p("0"), p("0.0"), true));
await test("cross-type: unequal across types", () =>
  eq(p("42"), p("42.5"), false));
await test("cross-type: MAX_SAFE_INTEGER", () =>
  eq(p("9007199254740991"), p("9007199254740991"), true));
await test("cross-type: large double", () =>
  eq(p("1.7976931348623157e+308"), p("1.7976931348623157e+308"), true));
await test("cross-type: small double", () =>
  eq(p("5e-324"), p("5e-324"), true));
await test("cross-type: negative zero vs positive zero as double", () => {
  // JSON -0.0 and 0.0: -0 === 0 is true in JS, but the raw bits differ.
  // The tape stores them as double with different bits, and f64 == treats -0 == 0.
  eq(p("-0.0"), p("0.0"), true);
});

// ═══════════════════════════════════════════════
// Strings: various lengths and content
// ═══════════════════════════════════════════════
await test("string: single character", () =>
  eq(p('"x"'), p('"x"'), true));
await test("string: single char mismatch", () =>
  eq(p('"x"'), p('"y"'), false));
await test("string: exactly 16 bytes (SIMD boundary)", () => {
  const s = '"abcdefghijklmnop"'; // 16 chars
  eq(p(s), p(s), true);
});
await test("string: 17 bytes (crosses SIMD boundary)", () => {
  const s = '"abcdefghijklmnopq"'; // 17 chars
  eq(p(s), p(s), true);
});
await test("string: long (200 chars)", () => {
  const s = '"' + "a".repeat(200) + '"';
  eq(p(s), p(s), true);
});
await test("string: long mismatch at end", () => {
  const s1 = '"' + "a".repeat(199) + 'x"';
  const s2 = '"' + "a".repeat(199) + 'y"';
  eq(p(s1), p(s2), false);
});
await test("strings with escapes: identical", () =>
  eq(p('"hello\\nworld"'), p('"hello\\nworld"'), true));
await test("strings with escapes: different", () =>
  eq(p('"hello\\nworld"'), p('"hello\\tworld"'), false));
await test("strings with unicode escapes", () =>
  eq(p('"\\u0041"'), p('"\\u0041"'), true));
await test("strings with backslash", () =>
  eq(p('"a\\\\b"'), p('"a\\\\b"'), true));
await test("strings with quotes", () =>
  eq(p('"say \\"hi\\""'), p('"say \\"hi\\""'), true));

// ═══════════════════════════════════════════════
// Arrays
// ═══════════════════════════════════════════════
await test("equal: empty arrays", () => eq(p("[]"), p("[]"), true));
await test("equal: simple arrays", () => eq(p("[1,2,3]"), p("[1,2,3]"), true));
await test("equal: mixed-type arrays", () =>
  eq(p('[1,"two",true,null]'), p('[1,"two",true,null]'), true));
await test("equal: nested empty arrays", () =>
  eq(p("[[],[],[]]"), p("[[],[],[]]"), true));
await test("equal: array of strings", () =>
  eq(p('["a","b","c"]'), p('["a","b","c"]'), true));
await test("equal: array of booleans", () =>
  eq(p("[true,false,true]"), p("[true,false,true]"), true));
await test("unequal: different length arrays", () =>
  eq(p("[1,2]"), p("[1,2,3]"), false));
await test("unequal: same length different elements", () =>
  eq(p("[1,2,3]"), p("[1,2,4]"), false));
await test("unequal: same length different types", () =>
  eq(p('[1,"2",3]'), p("[1,2,3]"), false));
await test("equal: large array of numbers (100 elements)", () => {
  const arr = JSON.stringify(Array.from({ length: 100 }, (_, i) => i));
  eq(p(arr), p(arr), true);
});
await test("unequal: large array last element differs", () => {
  const a = Array.from({ length: 100 }, (_, i) => i);
  const b = [...a];
  b[99] = 999;
  eq(p(JSON.stringify(a)), p(JSON.stringify(b)), false);
});

// ═══════════════════════════════════════════════
// Objects
// ═══════════════════════════════════════════════
await test("equal: empty objects", () => eq(p("{}"), p("{}"), true));
await test("equal: simple objects", () =>
  eq(p('{"a":1,"b":"two","c":true}'), p('{"a":1,"b":"two","c":true}'), true));
await test("equal: object with null value", () =>
  eq(p('{"key":null}'), p('{"key":null}'), true));
await test("unequal: different values", () =>
  eq(p('{"a":1,"b":2}'), p('{"a":1,"b":3}'), false));
await test("unequal: different keys", () =>
  eq(p('{"a":1,"b":2}'), p('{"a":1,"c":2}'), false));
await test("equal: different key order (default ignores key order)", () =>
  eq(p('{"a":1,"b":2}'), p('{"b":2,"a":1}'), true));
await test("unequal: different key count", () =>
  eq(p('{"a":1}'), p('{"a":1,"b":2}'), false));
await test("equal: object with all value types", () => {
  const json = '{"n":null,"t":true,"f":false,"i":42,"d":3.14,"s":"hi","a":[1],"o":{"x":1}}';
  eq(p(json), p(json), true);
});

// ═══════════════════════════════════════════════
// Nested structures
// ═══════════════════════════════════════════════
await test("equal: nested objects", () =>
  eq(p('{"a":{"b":{"c":1}}}'), p('{"a":{"b":{"c":1}}}'), true));
await test("equal: nested arrays", () =>
  eq(p("[[1,2],[3,[4,5]]]"), p("[[1,2],[3,[4,5]]]"), true));
await test("equal: mixed nesting", () => {
  const json = '{"items":[{"id":1,"tags":["a","b"]},{"id":2,"tags":[]}]}';
  eq(p(json), p(json), true);
});
await test("unequal: deep nested difference", () =>
  eq(p('{"a":{"b":{"c":1}}}'), p('{"a":{"b":{"c":2}}}'), false));
await test("equal: deeply nested (20 levels)", () => {
  let json = "1";
  for (let i = 0; i < 20; i++) json = `{"v":${json}}`;
  eq(p(json), p(json), true);
});
await test("unequal: deeply nested (20 levels) leaf differs", () => {
  let json1 = "1", json2 = "2";
  for (let i = 0; i < 20; i++) {
    json1 = `{"v":${json1}}`;
    json2 = `{"v":${json2}}`;
  }
  eq(p(json1), p(json2), false);
});
await test("equal: array of objects", () => {
  const json = '[{"name":"Alice","age":30},{"name":"Bob","age":25}]';
  eq(p(json), p(json), true);
});
await test("unequal: array of objects one field differs", () => {
  eq(
    p('[{"name":"Alice","age":30},{"name":"Bob","age":25}]'),
    p('[{"name":"Alice","age":30},{"name":"Bob","age":26}]'),
    false,
  );
});

// ═══════════════════════════════════════════════
// Uint8Array input (different code path for parsing)
// ═══════════════════════════════════════════════
await test("Uint8Array: equal objects", () => {
  const json = '{"hello":"world","n":42}';
  eq(pBytes(json), pBytes(json), true);
});
await test("Uint8Array: unequal objects", () => {
  eq(pBytes('{"a":1}'), pBytes('{"a":2}'), false);
});
await test("Uint8Array vs string parse: equal", () => {
  const json = '{"key":"value","arr":[1,2,3]}';
  eq(p(json), pBytes(json), true);
});

// ═══════════════════════════════════════════════
// Self-comparison (identity: same proxy both args)
// ═══════════════════════════════════════════════
await test("identity: same array proxy", () => {
  const arr = p("[1,2,3]");
  eq(arr, arr, true);
});
await test("identity: same object proxy", () => {
  const obj = p('{"a":1}');
  eq(obj, obj, true);
});

// ═══════════════════════════════════════════════
// Whitespace differences in source (semantic equality)
// ═══════════════════════════════════════════════
await test("whitespace: compact vs spaced (same semantics)", () => {
  eq(p('{"a":1,"b":2}'), p('{ "a" : 1 , "b" : 2 }'), true);
});
await test("whitespace: array compact vs spaced", () => {
  eq(p("[1,2,3]"), p("[ 1 , 2 , 3 ]"), true);
});

// ═══════════════════════════════════════════════
// Large payloads from fixtures
// ═══════════════════════════════════════════════
for (const name of ["tiny", "small", "medium", "large"]) {
  const fixturePath = join(__dirname, "..", "bench", "fixtures", `${name}.json`);
  let json;
  try { json = readFileSync(fixturePath, "utf-8"); } catch { continue; }

  await test(`fixture ${name}.json: self-equal`, () => {
    const a = p(json);
    const b = p(json);
    assert(vj.deepCompare(a, b) === true, `${name}.json should be equal to itself`);
  });

  await test(`fixture ${name}.json: detects mutation`, () => {
    // Parse, mutate via JSON round-trip, re-parse
    const obj = JSON.parse(json);
    const keys = Object.keys(obj);
    if (keys.length > 0) {
      obj[keys[0]] = "__MUTATED__";
    }
    const a = p(json);
    const b = p(JSON.stringify(obj));
    assert(vj.deepCompare(a, b) === false, `${name}.json mutation should be detected`);
  });
}

// ═══════════════════════════════════════════════
// Strict key order mode ({ ignoreKeyOrder: false })
// ═══════════════════════════════════════════════
await test("strict key order: same order → equal", () =>
  eqOpts(p('{"a":1,"b":2}'), p('{"a":1,"b":2}'), { ignoreKeyOrder: false }, true));
await test("strict key order: different order → NOT equal", () =>
  eqOpts(p('{"a":1,"b":2}'), p('{"b":2,"a":1}'), { ignoreKeyOrder: false }, false));
await test("strict key order: nested objects same order", () =>
  eqOpts(p('{"x":{"a":1,"b":2}}'), p('{"x":{"a":1,"b":2}}'), { ignoreKeyOrder: false }, true));
await test("strict key order: nested objects different order", () =>
  eqOpts(p('{"x":{"a":1,"b":2}}'), p('{"x":{"b":2,"a":1}}'), { ignoreKeyOrder: false }, false));

// ═══════════════════════════════════════════════
// Ignore key order (default) — key order doesn't matter
// ═══════════════════════════════════════════════
await test("ignore key order: simple reorder", () =>
  eq(p('{"a":1,"b":2,"c":3}'), p('{"c":3,"a":1,"b":2}'), true));
await test("ignore key order: nested object reorder", () =>
  eq(p('{"x":{"a":1,"b":2},"y":3}'), p('{"y":3,"x":{"b":2,"a":1}}'), true));
await test("ignore key order: deeply nested reorder", () => {
  eq(
    p('{"a":{"b":{"c":1,"d":2},"e":3},"f":4}'),
    p('{"f":4,"a":{"e":3,"b":{"d":2,"c":1}}}'),
    true,
  );
});
await test("ignore key order: same keys different values", () =>
  eq(p('{"a":1,"b":2}'), p('{"b":2,"a":99}'), false));
await test("ignore key order: array inside reordered object", () => {
  eq(
    p('{"items":[1,2,3],"name":"test"}'),
    p('{"name":"test","items":[1,2,3]}'),
    true,
  );
});
await test("ignore key order: array order still matters", () =>
  eq(p('{"a":[1,2,3]}'), p('{"a":[3,2,1]}'), false));
await test("ignore key order: many keys (20) shuffled", () => {
  const keys = Array.from({ length: 20 }, (_, i) => `key_${i}`);
  const objA = {};
  keys.forEach((k, i) => objA[k] = i);
  const shuffled = [...keys].reverse();
  const objB = {};
  shuffled.forEach(k => objB[k] = objA[k]);
  eq(p(JSON.stringify(objA)), p(JSON.stringify(objB)), true);
});
await test("ignore key order: duplicate-value keys but different mapping", () =>
  eq(p('{"a":"x","b":"y"}'), p('{"b":"x","a":"y"}'), false));
await test("ignore key order: object in array, reordered keys", () =>
  eq(
    p('[{"a":1,"b":2},{"c":3,"d":4}]'),
    p('[{"b":2,"a":1},{"d":4,"c":3}]'),
    true,
  ));
await test("ignore key order: fast path (keys already in order)", () => {
  // Both parse the same JSON → keys in same order → hits ordered fast path
  const json = '{"alpha":1,"beta":2,"gamma":3}';
  eq(p(json), p(json), true);
});
await test("ignore key order: same outer keys, nested keys reordered", () => {
  // Outer keys are in the same order → ordered fast-path fires,
  // but inner object keys are reordered → must still recurse with unordered
  eq(
    p('{"a":1,"b":{"x":1,"y":2},"c":3}'),
    p('{"a":1,"b":{"y":2,"x":1},"c":3}'),
    true,
  );
});
await test("ignore key order: deeply nested inner reorder with same outer keys", () => {
  eq(
    p('{"timestamp":"2024","value":42,"tags":{"region":"us","env":"prod"}}'),
    p('{"timestamp":"2024","value":42,"tags":{"env":"prod","region":"us"}}'),
    true,
  );
});

// ═══════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════
await test("edge: nested empty containers", () =>
  eq(p('[{},[],{},[[],{}]]'), p('[{},[],{},[[],{}]]'), true));
await test("edge: object with numeric string key", () =>
  eq(p('{"0":true,"1":false}'), p('{"0":true,"1":false}'), true));
await test("edge: very long key", () => {
  const key = "k".repeat(500);
  const json = `{"${key}":"value"}`;
  eq(p(json), p(json), true);
});
await test("edge: many keys (50)", () => {
  const obj = {};
  for (let i = 0; i < 50; i++) obj[`key_${i}`] = i;
  const json = JSON.stringify(obj);
  eq(p(json), p(json), true);
});
await test("edge: string with only spaces", () =>
  eq(p('"   "'), p('"   "'), true));
await test("edge: string with only spaces vs different count", () =>
  eq(p('"   "'), p('"    "'), false));

// ═══════════════════════════════════════════════
// Fallback: plain JS objects (non-proxy comparison)
// ═══════════════════════════════════════════════
await test("fallback: plain JS objects (equal)", () =>
  eq({ a: 1, b: "two" }, { a: 1, b: "two" }, true));
await test("fallback: plain JS objects (unequal)", () =>
  eq({ a: 1 }, { a: 2 }, false));
await test("fallback: plain JS arrays", () =>
  eq([1, 2, 3], [1, 2, 3], true));
await test("fallback: plain JS nested", () =>
  eq({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }, true));
await test("fallback: mixed proxy and plain object", () => {
  const proxy = p('{"a":1}');
  eq(proxy, { a: 1 }, true);
});
await test("fallback: mixed proxy and plain array", () => {
  const proxy = p("[1,2,3]");
  eq(proxy, [1, 2, 3], true);
});
await test("fallback: null values", () =>
  eq(null, null, true));
await test("fallback: primitive numbers", () =>
  eq(42, 42, true));
await test("fallback: primitive strings", () =>
  eq("hello", "hello", true));

// ═══════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
