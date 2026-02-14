/**
 * Phase 3: Stringify tests
 * Verify vectorjson.stringify() matches JSON.stringify() behavior.
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

function assertEqual(actual, expected, msg) {
  if (actual === expected) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
  }
}

async function run() {
  const vj = await init();

  console.log("\n=== Phase 3: Stringify Tests ===\n");

  // --- Primitives ---
  console.log("Primitives:");
  assertEqual(vj.stringify(null), "null", "null");
  assertEqual(vj.stringify(true), "true", "true");
  assertEqual(vj.stringify(false), "false", "false");
  assertEqual(vj.stringify(0), "0", "zero");
  assertEqual(vj.stringify(1), "1", "positive integer");
  assertEqual(vj.stringify(-1), "-1", "negative integer");
  assertEqual(vj.stringify(42), "42", "integer");
  assertEqual(vj.stringify(3.14), JSON.stringify(3.14), "float 3.14");
  assertEqual(vj.stringify(1e10), JSON.stringify(1e10), "scientific notation");
  assertEqual(vj.stringify(1.5), JSON.stringify(1.5), "float 1.5");

  // --- Special numbers ---
  console.log("\nSpecial numbers:");
  assertEqual(vj.stringify(NaN), "null", "NaN → null");
  assertEqual(vj.stringify(Infinity), "null", "Infinity → null");
  assertEqual(vj.stringify(-Infinity), "null", "-Infinity → null");

  // --- Strings ---
  console.log("\nStrings:");
  assertEqual(vj.stringify("hello"), '"hello"', "simple string");
  assertEqual(vj.stringify(""), '""', "empty string");
  assertEqual(
    vj.stringify('he said "hi"'),
    '"he said \\"hi\\""',
    "string with quotes"
  );
  assertEqual(
    vj.stringify("back\\slash"),
    '"back\\\\slash"',
    "string with backslash"
  );
  assertEqual(
    vj.stringify("line\nbreak"),
    '"line\\nbreak"',
    "string with newline"
  );
  assertEqual(
    vj.stringify("tab\there"),
    '"tab\\there"',
    "string with tab"
  );
  assertEqual(
    vj.stringify("carriage\rreturn"),
    '"carriage\\rreturn"',
    "string with carriage return"
  );
  assertEqual(
    vj.stringify("null\0byte"),
    JSON.stringify("null\0byte"),
    "string with null byte"
  );

  // --- Arrays ---
  console.log("\nArrays:");
  assertEqual(vj.stringify([]), "[]", "empty array");
  assertEqual(vj.stringify([1, 2, 3]), "[1,2,3]", "number array");
  assertEqual(
    vj.stringify(["a", "b", "c"]),
    '["a","b","c"]',
    "string array"
  );
  assertEqual(
    vj.stringify([true, false, null]),
    "[true,false,null]",
    "mixed primitives"
  );
  assertEqual(
    vj.stringify([1, [2, [3]]]),
    "[1,[2,[3]]]",
    "nested arrays"
  );

  // --- Objects ---
  console.log("\nObjects:");
  assertEqual(vj.stringify({}), "{}", "empty object");
  assertEqual(
    vj.stringify({ a: 1 }),
    '{"a":1}',
    "single property"
  );
  assertEqual(
    vj.stringify({ a: 1, b: 2 }),
    '{"a":1,"b":2}',
    "two properties"
  );
  assertEqual(
    vj.stringify({ name: "test", value: true }),
    '{"name":"test","value":true}',
    "mixed property types"
  );
  assertEqual(
    vj.stringify({ a: { b: { c: 1 } } }),
    '{"a":{"b":{"c":1}}}',
    "nested objects"
  );

  // --- Mixed structures ---
  console.log("\nMixed structures:");
  assertEqual(
    vj.stringify({ items: [1, 2, 3], meta: { count: 3 } }),
    '{"items":[1,2,3],"meta":{"count":3}}',
    "object with array and nested object"
  );
  assertEqual(
    vj.stringify([{ a: 1 }, { b: 2 }]),
    '[{"a":1},{"b":2}]',
    "array of objects"
  );

  // --- JSON.stringify compatibility ---
  console.log("\nJSON.stringify compatibility:");

  // undefined values in objects are skipped
  assertEqual(
    vj.stringify({ a: 1, b: undefined, c: 3 }),
    '{"a":1,"c":3}',
    "undefined values skipped in objects"
  );

  // undefined in arrays becomes null
  assertEqual(
    vj.stringify([1, undefined, 3]),
    "[1,null,3]",
    "undefined in arrays → null"
  );

  // Functions skipped in objects
  assertEqual(
    vj.stringify({ a: 1, fn: () => {}, c: 3 }),
    '{"a":1,"c":3}',
    "functions skipped in objects"
  );

  // toJSON method
  const datelike = { toJSON: () => "2024-01-01" };
  assertEqual(
    vj.stringify(datelike),
    '"2024-01-01"',
    "toJSON method called"
  );

  // BigInt throws
  let bigintThrew = false;
  try {
    vj.stringify(BigInt(42));
  } catch (e) {
    bigintThrew = e instanceof TypeError;
  }
  assert(bigintThrew, "BigInt throws TypeError");

  // --- Round-trip tests ---
  console.log("\nRound-trip (stringify(parse(x)) === x):");

  const roundTripCases = [
    '{"hello":"world"}',
    "[1,2,3]",
    "null",
    "true",
    "false",
    "42",
    '"test"',
    '{"a":{"b":[1,2,{"c":true}]}}',
    '["nested",["arrays",[1,2,3]]]',
    '{"empty_obj":{},"empty_arr":[]}',
  ];

  for (const json of roundTripCases) {
    const parsed = vj.parse(json);
    const reserialized = vj.stringify(parsed);
    assertEqual(reserialized, json, `roundtrip: ${json}`);
  }

  // --- Large structure ---
  console.log("\nLarge structure:");
  const big = { items: [] };
  for (let i = 0; i < 1000; i++) {
    big.items.push({ id: i, name: `item_${i}`, active: i % 2 === 0 });
  }
  const bigJson = vj.stringify(big);
  const expected = JSON.stringify(big);
  assertEqual(bigJson, expected, "1000-element array of objects");

  // --- String with Unicode ---
  console.log("\nUnicode:");
  assertEqual(
    vj.stringify("Hello 世界"),
    '"Hello 世界"',
    "CJK characters"
  );
  assertEqual(
    vj.stringify("emoji 🎉"),
    '"emoji 🎉"',
    "emoji"
  );
  assertEqual(
    vj.stringify({ "кey": "значение" }),
    '{"кey":"значение"}',
    "Cyrillic key and value"
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
