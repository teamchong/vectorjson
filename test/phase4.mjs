/**
 * Phase 4: Deep Compare tests
 * Verify vectorjson.deepCompare() detects structural diffs correctly.
 */
import { init } from "../dist/index.js";

let pass = 0;
let fail = 0;

function assert(condition, msg) {
  if (condition) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}`);
  }
}

function assertDiffs(diffs, expected, msg) {
  // Sort both by path for stable comparison
  const sortFn = (a, b) => a.path.localeCompare(b.path) || a.type.localeCompare(b.type);
  const sortedDiffs = [...diffs].sort(sortFn);
  const sortedExpected = [...expected].sort(sortFn);

  const actual = JSON.stringify(sortedDiffs);
  const exp = JSON.stringify(sortedExpected);

  if (actual === exp) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}`);
    console.log(`    expected: ${exp}`);
    console.log(`    actual:   ${actual}`);
  }
}

async function run() {
  const vj = await init();

  console.log("\n=== Phase 4: Deep Compare Tests ===\n");

  // --- Equal values (no diffs) ---
  console.log("Equal values:");
  assertDiffs(vj.deepCompare({ a: 1 }, { a: 1 }), [], "identical objects");
  assertDiffs(vj.deepCompare([1, 2, 3], [1, 2, 3]), [], "identical arrays");
  assertDiffs(vj.deepCompare(null, null), [], "null == null");
  assertDiffs(vj.deepCompare(true, true), [], "true == true");
  assertDiffs(vj.deepCompare(42, 42), [], "42 == 42");
  assertDiffs(vj.deepCompare("hello", "hello"), [], '"hello" == "hello"');
  assertDiffs(
    vj.deepCompare({ a: { b: [1, 2] } }, { a: { b: [1, 2] } }),
    [],
    "deeply nested equal"
  );

  // --- Changed values ---
  console.log("\nChanged values:");
  assertDiffs(
    vj.deepCompare({ a: 1 }, { a: 2 }),
    [{ path: "$.a", type: "changed" }],
    "number changed"
  );
  assertDiffs(
    vj.deepCompare({ a: "hello" }, { a: "world" }),
    [{ path: "$.a", type: "changed" }],
    "string changed"
  );
  assertDiffs(
    vj.deepCompare({ a: true }, { a: false }),
    [{ path: "$.a", type: "changed" }],
    "boolean changed"
  );
  assertDiffs(
    vj.deepCompare([1, 2, 3], [1, 99, 3]),
    [{ path: "$[1]", type: "changed" }],
    "array element changed"
  );

  // --- Type changes ---
  console.log("\nType changes:");
  assertDiffs(
    vj.deepCompare({ a: 1 }, { a: "1" }),
    [{ path: "$.a", type: "type_changed" }],
    "number → string"
  );
  assertDiffs(
    vj.deepCompare({ a: [] }, { a: {} }),
    [{ path: "$.a", type: "type_changed" }],
    "array → object"
  );
  assertDiffs(
    vj.deepCompare({ a: null }, { a: 0 }),
    [{ path: "$.a", type: "type_changed" }],
    "null → number"
  );

  // --- Added/removed keys ---
  console.log("\nAdded/removed keys:");
  assertDiffs(
    vj.deepCompare({ a: 1, b: 2 }, { a: 1 }),
    [{ path: "$.b", type: "removed" }],
    "key removed"
  );
  assertDiffs(
    vj.deepCompare({ a: 1 }, { a: 1, b: 2 }),
    [{ path: "$.b", type: "added" }],
    "key added"
  );
  assertDiffs(
    vj.deepCompare({ a: 1 }, { b: 1 }),
    [
      { path: "$.a", type: "removed" },
      { path: "$.b", type: "added" },
    ],
    "key renamed (removed + added)"
  );

  // --- Array length differences ---
  console.log("\nArray length differences:");
  assertDiffs(
    vj.deepCompare([1, 2, 3], [1, 2]),
    [{ path: "$[2]", type: "removed" }],
    "array element removed"
  );
  assertDiffs(
    vj.deepCompare([1, 2], [1, 2, 3]),
    [{ path: "$[2]", type: "added" }],
    "array element added"
  );
  assertDiffs(
    vj.deepCompare([1, 2, 3, 4], [1, 2]),
    [
      { path: "$[2]", type: "removed" },
      { path: "$[3]", type: "removed" },
    ],
    "multiple array elements removed"
  );

  // --- Nested diffs ---
  console.log("\nNested diffs:");
  assertDiffs(
    vj.deepCompare(
      { user: { name: "Alice", age: 30 } },
      { user: { name: "Bob", age: 30 } }
    ),
    [{ path: "$.user.name", type: "changed" }],
    "nested object value changed"
  );
  assertDiffs(
    vj.deepCompare(
      { items: [{ id: 1 }, { id: 2 }] },
      { items: [{ id: 1 }, { id: 3 }] }
    ),
    [{ path: "$.items[1].id", type: "changed" }],
    "nested array+object value changed"
  );

  // --- Multiple diffs ---
  console.log("\nMultiple diffs:");
  assertDiffs(
    vj.deepCompare(
      { a: 1, b: "hello", c: [1, 2] },
      { a: 2, b: "world", c: [1, 3] }
    ),
    [
      { path: "$.a", type: "changed" },
      { path: "$.b", type: "changed" },
      { path: "$.c[1]", type: "changed" },
    ],
    "multiple changes at different paths"
  );

  // --- Order-independent comparison (default) ---
  console.log("\nOrder-independent (default, like fast-deep-equal):");
  assertDiffs(
    vj.deepCompare({ a: 1, b: 2 }, { b: 2, a: 1 }),
    [],
    "{a:1, b:2} == {b:2, a:1} (unordered)"
  );
  assertDiffs(
    vj.deepCompare(
      { z: 3, a: 1, m: 2 },
      { a: 1, m: 2, z: 3 }
    ),
    [],
    "keys in different order are equal"
  );
  assertDiffs(
    vj.deepCompare({ a: 1, b: 2 }, { b: 99, a: 1 }),
    [{ path: "$.b", type: "changed" }],
    "different value detected regardless of key order"
  );

  // --- Ordered comparison (raw compare) ---
  console.log("\nOrdered comparison (property order matters):");
  const orderedDiffs = vj.deepCompare(
    { a: 1, b: 2 },
    { b: 2, a: 1 },
    { ordered: true }
  );
  assert(orderedDiffs.length > 0, "{a:1, b:2} != {b:2, a:1} in ordered mode");

  assertDiffs(
    vj.deepCompare({ a: 1, b: 2 }, { a: 1, b: 2 }, { ordered: true }),
    [],
    "same order is still equal"
  );

  // --- Uint8Array inputs (raw JSON) ---
  console.log("\nUint8Array inputs (raw JSON):");
  const enc = new TextEncoder();
  assertDiffs(
    vj.deepCompare(enc.encode('{"a":1}'), enc.encode('{"a":2}')),
    [{ path: "$.a", type: "changed" }],
    "Uint8Array inputs compared correctly"
  );
  assertDiffs(
    vj.deepCompare(enc.encode('{"a":1,"b":2}'), enc.encode('{"a":1,"b":2}')),
    [],
    "identical Uint8Array inputs"
  );

  // --- JS string inputs (compared as string values) ---
  console.log("\nJS string inputs:");
  assertDiffs(
    vj.deepCompare("hello", "hello"),
    [],
    "identical strings"
  );
  assertDiffs(
    vj.deepCompare("hello", "world"),
    [{ path: "$", type: "changed" }],
    "different strings"
  );

  // --- Root-level diffs ---
  console.log("\nRoot-level diffs:");
  assertDiffs(
    vj.deepCompare(1, 2),
    [{ path: "$", type: "changed" }],
    "root scalar changed"
  );
  assertDiffs(
    vj.deepCompare("hello", "world"),
    [{ path: "$", type: "changed" }],
    "root string changed"
  );
  assertDiffs(
    vj.deepCompare(1, "1"),
    [{ path: "$", type: "type_changed" }],
    "root type changed"
  );

  // --- Empty structures ---
  console.log("\nEmpty structures:");
  assertDiffs(vj.deepCompare({}, {}), [], "empty objects equal");
  assertDiffs(vj.deepCompare([], []), [], "empty arrays equal");
  assertDiffs(
    vj.deepCompare({}, { a: 1 }),
    [{ path: "$.a", type: "added" }],
    "empty → non-empty object"
  );
  assertDiffs(
    vj.deepCompare([], [1]),
    [{ path: "$[0]", type: "added" }],
    "empty → non-empty array"
  );

  // --- Summary ---
  console.log(`\n${"=".repeat(40)}`);
  console.log(`Results: ${pass} passed, ${fail} failed out of ${pass + fail}`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
