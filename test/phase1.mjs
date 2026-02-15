/**
 * Phase 1: Full JSON parsing verification.
 * Tests all JSON types, nested structures, edge cases,
 * and correctness vs JSON.parse().
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

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "Assertion failed");
}

function assertDeepEqual(actual, expected) {
  assertEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)));
}

console.log("\n🧪 VectorJSON Phase 1 — Full Parse Tests\n");
const vj = await init();

// --- Scalar types ---
await test("null", () => assertEqual(vj.parse("null").value, null));
await test("true", () => assertEqual(vj.parse("true").value, true));
await test("false", () => assertEqual(vj.parse("false").value, false));
await test("positive integer", () => assertEqual(vj.parse("42").value, 42));
await test("negative integer", () => assertEqual(vj.parse("-7").value, -7));
await test("zero", () => assertEqual(vj.parse("0").value, 0));
await test("float", () => {
  const r = vj.parse("3.14159").value;
  if (Math.abs(r - 3.14159) > 1e-10) throw new Error(`Got ${r}`);
});
await test("exponent notation", () => {
  const r = vj.parse("1.5e10").value;
  if (Math.abs(r - 1.5e10) > 1) throw new Error(`Got ${r}`);
});
await test("negative exponent", () => {
  const r = vj.parse("1e-5").value;
  if (Math.abs(r - 1e-5) > 1e-15) throw new Error(`Got ${r}`);
});
await test("large integer", () => assertEqual(vj.parse("9007199254740991").value, 9007199254740991)); // MAX_SAFE_INTEGER
await test("simple string", () => assertEqual(vj.parse('"hello"').value, "hello"));
await test("empty string", () => assertEqual(vj.parse('""').value, ""));
await test("string with escapes", () => {
  assertEqual(vj.parse('"hello\\nworld"').value, "hello\nworld");
});
await test("string with tab", () => assertEqual(vj.parse('"a\\tb"').value, "a\tb"));
await test("string with backslash", () => assertEqual(vj.parse('"a\\\\b"').value, "a\\b"));
await test("string with quote", () => assertEqual(vj.parse('"a\\"b"').value, 'a"b'));
await test("string with unicode", () => assertEqual(vj.parse('"\\u0041"').value, "A"));

// --- Arrays ---
await test("empty array", () => assertEqual(vj.parse("[]").value, []));
await test("array of ints", () => assertEqual(vj.parse("[1,2,3]").value, [1,2,3]));
await test("array of mixed", () => assertEqual(vj.parse('[1,"a",true,null]').value, [1,"a",true,null]));
await test("nested arrays", () => assertEqual(vj.parse("[[1,2],[3,4]]").value, [[1,2],[3,4]]));
await test("deeply nested arrays", () => assertEqual(vj.parse("[[[1]]]").value, [[[1]]]));
await test("array with objects", () => {
  assertEqual(vj.parse('[{"a":1},{"b":2}]').value, [{a:1},{b:2}]);
});

// --- Objects ---
await test("empty object", () => assertEqual(vj.parse("{}").value, {}));
await test("simple object", () => assertEqual(vj.parse('{"a":1}').value, {a:1}));
await test("object with all types", () => {
  assertEqual(vj.parse('{"n":null,"b":true,"i":42,"s":"hi","a":[1],"o":{}}').value,
    {n:null,b:true,i:42,s:"hi",a:[1],o:{}});
});
await test("nested objects", () => {
  assertEqual(vj.parse('{"a":{"b":{"c":1}}}').value, {a:{b:{c:1}}});
});
await test("object with array values", () => {
  assertEqual(vj.parse('{"ids":[1,2,3],"names":["a","b"]}').value,
    {ids:[1,2,3],names:["a","b"]});
});

// --- Complex real-world-like structures ---
await test("package.json-like", () => {
  const input = JSON.stringify({
    name: "test-package",
    version: "1.0.0",
    dependencies: { lodash: "^4.17.21", express: "^4.18.0" },
    scripts: { test: "jest", build: "tsc" },
    keywords: ["test", "json"],
    private: true,
    files: ["dist/", "src/"]
  });
  const result = vj.parse(input).value;
  const expected = JSON.parse(input);
  assertDeepEqual(result, expected);
});

await test("API response-like", () => {
  const input = JSON.stringify({
    status: 200,
    data: {
      users: [
        { id: 1, name: "Alice", active: true, score: 95.5 },
        { id: 2, name: "Bob", active: false, score: null },
      ],
      total: 2,
      page: 1,
    },
    meta: { requestId: "abc-123", timestamp: 1707868800 }
  });
  const result = vj.parse(input).value;
  assertDeepEqual(result, JSON.parse(input));
});

// --- Whitespace handling ---
await test("whitespace around values", () => {
  assertEqual(vj.parse('  { "a" : 1 , "b" : 2 }  ').value, {a:1,b:2});
});
await test("newlines and tabs", () => {
  assertEqual(vj.parse('{\n\t"a":\n\t1\n}').value, {a:1});
});

// --- Error cases ---
await test("invalid JSON returns invalid status", () => {
  const result = vj.parse("{bad");
  assert(result.status !== "complete", `Expected non-complete status, got "${result.status}"`);
});
await test("trailing garbage returns complete_early", () => {
  const result = vj.parse("42 extra");
  assertEqual(result.status, "complete_early", "status should be complete_early");
  assertEqual(result.value, 42);
});

// --- Large-ish JSON ---
await test("100-element array", () => {
  const arr = Array.from({length: 100}, (_, i) => i);
  const input = JSON.stringify(arr);
  const result = vj.parse(input).value;
  assertEqual(result, arr);
});

await test("object with 50 keys", () => {
  const obj = {};
  for (let i = 0; i < 50; i++) obj[`key${i}`] = i;
  const input = JSON.stringify(obj);
  const result = vj.parse(input).value;
  assertDeepEqual(result, obj);
});

console.log(`\n✨ Phase 1 Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
