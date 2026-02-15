/**
 * VectorJSON Zero-Copy WasmGC Tests
 *
 * Tests parse() — returns Proxy objects backed by WasmGC structs/arrays.
 * Values are only materialized when accessed.
 */
import { init } from "../dist/index.js";

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

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ ${msg}: expected ${e}, got ${a}`);
    failed++;
  }
}

console.log("🧪 VectorJSON Zero-Copy WasmGC Tests\n");

const vj = await init();

// ============================================================
// Primitive types
// ============================================================
console.log("--- Primitive Types ---");

assertEq(vj.parse("null").value, null, "parse null");
assertEq(vj.parse("true").value, true, "parse true");
assertEq(vj.parse("false").value, false, "parse false");
assertEq(vj.parse("42").value, 42, "parse integer");
assertEq(vj.parse("3.14").value, 3.14, "parse float");
assertEq(vj.parse('"hello"').value, "hello", "parse string");
assertEq(vj.parse('""').value, "", "parse empty string");

// ============================================================
// Object property access
// ============================================================
console.log("\n--- Object Property Access ---");

const obj1 = vj.parse('{"name":"Alice","age":30}').value;
assertEq(obj1.name, "Alice", "object string property");
assertEq(obj1.age, 30, "object number property");
assertEq(obj1.missing, undefined, "missing property returns undefined");
assert("name" in obj1, "'in' operator works for existing key");
assert(!("missing" in obj1), "'in' operator works for missing key");

// ============================================================
// Nested object access
// ============================================================
console.log("\n--- Nested Objects ---");

const obj2 = vj.parse('{"user":{"name":"Bob","address":{"city":"NYC"}}}').value;
assertEq(obj2.user.name, "Bob", "nested object property");
assertEq(obj2.user.address.city, "NYC", "deeply nested property");

// ============================================================
// Array access
// ============================================================
console.log("\n--- Array Access ---");

const arr1 = vj.parse("[1,2,3]").value;
assertEq(arr1.length, 3, "array length");
assertEq(arr1[0], 1, "array index 0");
assertEq(arr1[1], 2, "array index 1");
assertEq(arr1[2], 3, "array index 2");

// ============================================================
// Mixed nested structures
// ============================================================
console.log("\n--- Mixed Structures ---");

const complex = vj.parse(
  '{"items":[{"id":1,"name":"Widget"},{"id":2,"name":"Gadget"}],"total":2}',
).value;
assertEq(complex.total, 2, "top-level number");
assertEq(complex.items.length, 2, "nested array length");
assertEq(complex.items[0].id, 1, "nested array[0].id");
assertEq(complex.items[0].name, "Widget", "nested array[0].name");
assertEq(complex.items[1].name, "Gadget", "nested array[1].name");

// ============================================================
// Object.keys / ownKeys
// ============================================================
console.log("\n--- Object.keys ---");

const obj3 = vj.parse('{"a":1,"b":2,"c":3}').value;
const keys = Object.keys(obj3);
assertEq(keys, ["a", "b", "c"], "Object.keys returns all keys");

// ============================================================
// Array iteration (for...of)
// ============================================================
console.log("\n--- Array Iteration ---");

const arr2 = vj.parse("[10,20,30]").value;
const collected = [];
for (const item of arr2) {
  collected.push(item);
}
assertEq(collected, [10, 20, 30], "for...of iteration");

// ============================================================
// JSON.stringify on lazy proxy (via toJSON)
// ============================================================
console.log("\n--- JSON.stringify ---");

const obj4 = vj.parse('{"x":1,"y":[2,3]}').value;
const stringified = JSON.stringify(obj4);
// Should produce the same output (key order may differ, but we use insertion order)
const reparsed = JSON.parse(stringified);
assertEq(reparsed.x, 1, "JSON.stringify preserves number");
assertEq(reparsed.y, [2, 3], "JSON.stringify preserves array");

// ============================================================
// materialize()
// ============================================================
console.log("\n--- materialize() ---");

const lazy = vj.parse('{"a":[1,true,null,"str"],"b":{"nested":42}}').value;
const plain = vj.materialize(lazy);
assertEq(plain.a, [1, true, null, "str"], "materialize array");
assertEq(plain.b.nested, 42, "materialize nested object");

// Materialize on plain values is a no-op
assertEq(vj.materialize(42), 42, "materialize plain number");
assertEq(vj.materialize("str"), "str", "materialize plain string");
assertEq(vj.materialize(null), null, "materialize null");

// ============================================================
// Empty containers
// ============================================================
console.log("\n--- Empty Containers ---");

const emptyObj = vj.parse("{}").value;
assertEq(Object.keys(emptyObj), [], "empty object keys");

const emptyArr = vj.parse("[]").value;
assertEq(emptyArr.length, 0, "empty array length");

// ============================================================
// Persistence across parses
// ============================================================
console.log("\n--- Persistence ---");

const first = vj.parse('{"msg":"first"}').value;
const second = vj.parse('{"msg":"second"}').value;
// First result should still be valid (strings copied into GC heap)
assertEq(first.msg, "first", "first result persists after second parse");
assertEq(second.msg, "second", "second result correct");

// ============================================================
// Error handling
// ============================================================
console.log("\n--- Error Handling ---");

{
  const result = vj.parse("{invalid}");
  assert(result.status === "invalid", "parse returns invalid status on invalid JSON");
}

// ============================================================
// Unicode strings
// ============================================================
console.log("\n--- Unicode ---");

const unicode = vj.parse('{"emoji":"\\u2764","jp":"\\u3053\\u3093\\u306b\\u3061\\u306f"}').value;
assertEq(unicode.emoji, "❤", "unicode escape (heart)");
assertEq(unicode.jp, "こんにちは", "unicode escape (Japanese)");

// ============================================================
// Results
// ============================================================
console.log(`\n✨ Zero-Copy Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
