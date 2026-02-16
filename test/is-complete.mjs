/**
 * Tests for isComplete() and toJSON() on ParseResult.
 *
 * isComplete(value) checks if a container (object/array) from an incomplete
 * parse is fully present in the original input (not autocompleted).
 *
 * toJSON() materializes the full value via JSON.parse — fastest possible.
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
    throw new Error(message || `Expected ${e}, got ${a}`);
  }
}

console.log("\n🧪 VectorJSON isComplete() + toJSON() Tests\n");

const vj = await init();

// ═══════════════════════════════════════════════════
// isComplete — complete parses (always true)
// ═══════════════════════════════════════════════════

console.log("--- isComplete: complete parses (always true) ---");

await test("complete: isComplete on root object is true", () => {
  const r = vj.parse('{"data":[1,2,3]}');
  assert(r.status === "complete", `status=${r.status}`);
  assert(r.isComplete(r.value) === true);
});

await test("complete: isComplete on nested array is true", () => {
  const r = vj.parse('{"data":[1,2,3]}');
  assert(r.isComplete(r.value.data) === true);
});

await test("complete: isComplete on primitive is true", () => {
  const r = vj.parse('{"data":[1,2,3]}');
  assert(r.isComplete(r.value.data[2]) === true);
});

await test("complete: isComplete on null is true", () => {
  const r = vj.parse("[null]");
  assert(r.isComplete(null) === true);
});

await test("complete: isComplete on undefined is true", () => {
  const r = vj.parse("42");
  assert(r.isComplete(undefined) === true);
});

await test("complete: isComplete on number is true", () => {
  const r = vj.parse("42");
  assert(r.isComplete(42) === true);
});

await test("complete: isComplete on string is true", () => {
  const r = vj.parse('"hello"');
  assert(r.isComplete("hello") === true);
});

// ═══════════════════════════════════════════════════
// isComplete — incomplete parses
// ═══════════════════════════════════════════════════

console.log("\n--- isComplete: incomplete parses ---");

await test("incomplete: root array is not complete", () => {
  const r = vj.parse('[{"name":"alice"},{"name":"bo');
  assert(r.status === "incomplete", `status=${r.status}`);
  assert(r.isComplete(r.value) === false, "root array should be incomplete");
});

await test("incomplete: first complete element is complete", () => {
  const r = vj.parse('[{"name":"alice"},{"name":"bo');
  assert(r.isComplete(r.value[0]) === true, "first element should be complete");
});

await test("incomplete: second autocompleted element is not complete", () => {
  const r = vj.parse('[{"name":"alice"},{"name":"bo');
  assert(r.isComplete(r.value[1]) === false, "second element should be incomplete");
});

await test("incomplete: values accessible from incomplete elements", () => {
  const r = vj.parse('[{"name":"alice"},{"name":"bo');
  assertEqual(r.value[0].name, "alice");
  assertEqual(r.value[1].name, "bo");
});

await test("incomplete: array length includes autocompleted elements", () => {
  const r = vj.parse('[{"name":"alice"},{"name":"bo');
  assert(r.value.length === 2, `length=${r.value.length}`);
});

await test("incomplete: object with dangling colon", () => {
  const r = vj.parse('{"a":1,"b":');
  assert(r.status === "incomplete", `status=${r.status}`);
  assert(r.isComplete(r.value) === false, "root object should be incomplete");
  assertEqual(r.value.a, 1);
});

await test("incomplete: nested array within object", () => {
  const r = vj.parse('{"items":[1,2,');
  assert(r.status === "incomplete");
  assert(r.isComplete(r.value) === false);
  assert(r.isComplete(r.value.items) === false);
});

await test("incomplete: primitives always return true from isComplete", () => {
  const r = vj.parse('[1,2,');
  assert(r.status === "incomplete");
  assert(r.isComplete(1) === true);
  assert(r.isComplete("hello") === true);
  assert(r.isComplete(null) === true);
  assert(r.isComplete(true) === true);
});

// ═══════════════════════════════════════════════════
// isComplete — streaming UI pattern
// ═══════════════════════════════════════════════════

console.log("\n--- isComplete: streaming UI pattern ---");

await test("streaming pattern: filter complete elements", () => {
  const r = vj.parse('[{"id":1,"done":true},{"id":2,"text":"hell');
  assert(r.status === "incomplete");

  const complete = [];
  const preview = [];
  for (let i = 0; i < r.value.length; i++) {
    if (r.isComplete(r.value[i])) {
      complete.push(r.value[i].id);
    } else {
      preview.push(r.value[i].id);
    }
  }

  assertEqual(complete, [1], "only first element should be complete");
  assertEqual(preview, [2], "second element should be preview");
});

await test("streaming pattern: multiple complete elements", () => {
  const r = vj.parse('[{"id":1},{"id":2},{"id":3},{"id":');
  assert(r.status === "incomplete");

  let completeCount = 0;
  for (let i = 0; i < r.value.length; i++) {
    if (r.isComplete(r.value[i])) completeCount++;
  }
  assert(completeCount === 3, `expected 3 complete, got ${completeCount}`);
  assert(r.isComplete(r.value[3]) === false);
});

await test("streaming pattern: index-based without .length", () => {
  // Simulates the README pattern: track index, check isComplete per element
  const r = vj.parse('[{"id":1},{"id":2},{"id":3},{"id":');
  assert(r.status === "incomplete");

  const executed = [];
  let next = 0;
  while (r.value[next] !== undefined && r.isComplete(r.value[next])) {
    executed.push(r.value[next].id);
    next++;
  }
  assertEqual(executed, [1, 2, 3], "should execute 3 complete elements");
  assert(next === 3, `next should be 3, got ${next}`);
});

await test("streaming pattern: isComplete(undefined) is true — needs guard", () => {
  // Without a guard, looping past the end would hit undefined → isComplete returns true
  const r = vj.parse('[{"id":1}');
  assert(r.isComplete(undefined) === true, "isComplete(undefined) should be true");
  assert(r.value[999] === undefined, "out-of-bounds should be undefined");
  // This is why the while loop needs: tasks[next] !== undefined && ...
});

// ═══════════════════════════════════════════════════
// isComplete — complete_early
// ═══════════════════════════════════════════════════

console.log("\n--- isComplete: complete_early ---");

await test("complete_early: isComplete always true", () => {
  const r = vj.parse('{"a":1}{"b":2}');
  assert(r.status === "complete_early", `status=${r.status}`);
  assert(r.isComplete(r.value) === true);
});

// ═══════════════════════════════════════════════════
// toJSON — complete parses
// ═══════════════════════════════════════════════════

console.log("\n--- toJSON: complete parses ---");

await test("toJSON: complete object", () => {
  const r = vj.parse('{"data":[1,2,3]}');
  const json = r.toJSON();
  assertEqual(json, { data: [1, 2, 3] });
});

await test("toJSON: complete array", () => {
  const r = vj.parse("[1,2,3]");
  assertEqual(r.toJSON(), [1, 2, 3]);
});

await test("toJSON: complete scalar", () => {
  assertEqual(vj.parse("42").toJSON(), 42);
  assertEqual(vj.parse("true").toJSON(), true);
  assertEqual(vj.parse("null").toJSON(), null);
  assertEqual(vj.parse('"hello"').toJSON(), "hello");
});

await test("toJSON: cached (same reference)", () => {
  const r = vj.parse('{"x":1}');
  const a = r.toJSON();
  const b = r.toJSON();
  assert(a === b, "toJSON should return cached result");
});

await test("toJSON: matches JSON.parse", () => {
  const input = '{"a":1,"b":{"c":[true,false,null]}}';
  const r = vj.parse(input);
  assertEqual(r.toJSON(), JSON.parse(input));
});

// ═══════════════════════════════════════════════════
// toJSON — incomplete parses (uses autocompleted input)
// ═══════════════════════════════════════════════════

console.log("\n--- toJSON: incomplete parses ---");

await test("toJSON: incomplete array autocompleted", () => {
  const r = vj.parse("[1,2,3");
  assert(r.status === "incomplete");
  const json = r.toJSON();
  assertEqual(json, [1, 2, 3]);
});

await test("toJSON: incomplete object autocompleted", () => {
  const r = vj.parse('{"a":1,"b":');
  assert(r.status === "incomplete");
  const json = r.toJSON();
  assert(json.a === 1, `a=${json.a}`);
  // b should be null (autocomplete fills missing value with null)
  assert(json.b === null, `b=${json.b}`);
});

await test("toJSON: incomplete nested structure", () => {
  const r = vj.parse('[{"name":"alice"},{"name":"bo');
  assert(r.status === "incomplete");
  const json = r.toJSON();
  assert(Array.isArray(json));
  assert(json.length === 2);
  assert(json[0].name === "alice");
  assert(json[1].name === "bo");
});

// ═══════════════════════════════════════════════════
// toJSON — complete_early
// ═══════════════════════════════════════════════════

console.log("\n--- toJSON: complete_early ---");

await test("toJSON: complete_early returns first value only", () => {
  const r = vj.parse('{"a":1}{"b":2}');
  assert(r.status === "complete_early");
  assertEqual(r.toJSON(), { a: 1 });
});

// ═══════════════════════════════════════════════════
// toJSON — Uint8Array input
// ═══════════════════════════════════════════════════

console.log("\n--- toJSON: Uint8Array input ---");

await test("toJSON: Uint8Array complete", () => {
  const bytes = new TextEncoder().encode('{"binary":true}');
  const r = vj.parse(bytes);
  assertEqual(r.toJSON(), { binary: true });
});

await test("toJSON: Uint8Array incomplete", () => {
  const bytes = new TextEncoder().encode("[1,2,");
  const r = vj.parse(bytes);
  assert(r.status === "incomplete");
  assertEqual(r.toJSON(), [1, 2, null]);
});

// ═══════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════

console.log("\n--- Edge cases ---");

await test("isComplete: non-proxy object returns true", () => {
  const r = vj.parse('{"a":1}');
  // Pass a random plain object — should return true (not a tracked proxy)
  assert(r.isComplete({}) === true);
  assert(r.isComplete([]) === true);
});

await test("isComplete: works after multiple parses", () => {
  const r1 = vj.parse('[1,2,');
  const r2 = vj.parse('[3,4,5]');
  assert(r1.isComplete(r1.value) === false);
  assert(r2.isComplete(r2.value) === true);
});

await test("toJSON: invalid parse has undefined toJSON result", () => {
  const r = vj.parse("{invalid}");
  assert(r.status === "invalid");
  assert(r.toJSON() === undefined);
});

await test("isComplete: empty incomplete input", () => {
  const r = vj.parse("");
  assert(r.status === "incomplete");
  assert(r.isComplete(undefined) === true);
});

console.log("\n✨ isComplete + toJSON tests complete!\n");
