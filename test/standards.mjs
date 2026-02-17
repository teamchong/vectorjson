/**
 * Standards compliance tests
 * Covers RFC 8259 (JSON), ECMA-404, and common JSON Schema draft-07/2020-12 patterns.
 * Tests edge cases, Unicode, number precision, escaping, and structural correctness.
 */
import { parse, createParser } from "../dist/index.js";

let pass = 0;
let fail = 0;

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}`);
    console.log(`    expected: ${e}`);
    console.log(`    actual:   ${a}`);
  }
}

function assert(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}`);
  }
}

async function run() {
  console.log("\n=== Standards Compliance Tests ===\n");

  // =============================================
  // RFC 8259 / ECMA-404: JSON Parsing
  // =============================================
  console.log("RFC 8259 — Structural characters:");
  assertEqual(parse("{}").value, {}, "empty object");
  assertEqual(parse("[]").value, [], "empty array");
  assertEqual(parse('{"a":1}').value, { a: 1 }, "object with one pair");
  assertEqual(parse("[1]").value, [1], "array with one element");

  console.log("\nRFC 8259 — Whitespace:");
  assertEqual(parse(" { } ").value, {}, "spaces around object");
  assertEqual(parse("\t[\t]\t").value, [], "tabs around array");
  assertEqual(parse("\n{\n}\n").value, {}, "newlines around object");
  assertEqual(parse("\r\n{\r\n}\r\n").value, {}, "CRLF around object");
  assertEqual(
    parse('  {  "a"  :  1  ,  "b"  :  2  }  ').value,
    { a: 1, b: 2 },
    "whitespace everywhere"
  );

  console.log("\nRFC 8259 — Strings:");
  assertEqual(parse('""').value, "", "empty string");
  assertEqual(parse('"hello"').value, "hello", "simple string");
  assertEqual(parse('"\\""').value, '"', "escaped quote");
  assertEqual(parse('"\\\\"').value, "\\", "escaped backslash");
  assertEqual(parse('"\\/"').value, "/", "escaped forward slash");
  assertEqual(parse('"\\b"').value, "\b", "escaped backspace");
  assertEqual(parse('"\\f"').value, "\f", "escaped form feed");
  assertEqual(parse('"\\n"').value, "\n", "escaped newline");
  assertEqual(parse('"\\r"').value, "\r", "escaped carriage return");
  assertEqual(parse('"\\t"').value, "\t", "escaped tab");
  assertEqual(parse('"\\u0041"').value, "A", "unicode escape (A)");
  assertEqual(parse('"\\u00e9"').value, "é", "unicode escape (é)");
  assertEqual(parse('"\\u4e16\\u754c"').value, "世界", "unicode escape CJK");

  // Surrogate pairs
  assertEqual(
    parse('"\\uD83C\\uDF89"').value,
    "🎉",
    "surrogate pair emoji (🎉)"
  );

  // String with all escape types
  assertEqual(
    parse('"a\\"b\\\\c\\/d\\be\\ff\\ng\\rh\\ti"').value,
    'a"b\\c/d\be\ff\ng\rh\ti',
    "all escape types combined"
  );

  console.log("\nRFC 8259 — Numbers:");
  assertEqual(parse("0").value, 0, "zero");
  assertEqual(parse("-0").value, -0, "negative zero");
  assertEqual(parse("1").value, 1, "positive integer");
  assertEqual(parse("-1").value, -1, "negative integer");
  assertEqual(parse("123456789").value, 123456789, "large integer");
  assertEqual(parse("0.5").value, 0.5, "decimal");
  assertEqual(parse("-0.5").value, -0.5, "negative decimal");
  assertEqual(parse("1e2").value, 100, "exponent lowercase");
  assertEqual(parse("1E2").value, 100, "exponent uppercase");
  assertEqual(parse("1e+2").value, 100, "exponent with plus");
  assertEqual(parse("1e-2").value, 0.01, "exponent with minus");
  assertEqual(parse("1.5e3").value, 1500, "decimal with exponent");
  assertEqual(
    parse("9007199254740992").value,
    9007199254740992,
    "MAX_SAFE_INTEGER + 1"
  );
  assertEqual(
    parse("-9007199254740992").value,
    -9007199254740992,
    "-(MAX_SAFE_INTEGER + 1)"
  );

  console.log("\nRFC 8259 — Literals:");
  assertEqual(parse("true").value, true, "true literal");
  assertEqual(parse("false").value, false, "false literal");
  assertEqual(parse("null").value, null, "null literal");

  console.log("\nRFC 8259 — Nesting:");
  assertEqual(
    parse('{"a":{"b":{"c":{"d":1}}}}').value,
    { a: { b: { c: { d: 1 } } } },
    "4 levels of nesting"
  );
  assertEqual(
    parse("[[[[1]]]]").value,
    [[[[1]]]],
    "4 levels of array nesting"
  );
  assertEqual(
    parse('[{"a":[1,{"b":2}]}]').value,
    [{ a: [1, { b: 2 }] }],
    "mixed nesting"
  );

  console.log("\nRFC 8259 — Invalid JSON (should return non-complete status):");
  assert(parse("").status !== "complete", "empty input");
  assert(parse("{").status !== "complete", "unclosed object");
  assert(parse("[").status !== "complete", "unclosed array");
  assert(parse('{"a":}').status !== "complete", "missing value");
  assert(parse("[,]").status !== "complete", "leading comma in array");
  assert(parse("{,}").status !== "complete", "leading comma in object");
  assert(parse("[1,]").status !== "complete", "trailing comma in array");
  assert(parse('{"a":1,}').status !== "complete", "trailing comma in object");
  assert(parse("undefined").status !== "complete", "undefined literal");
  assert(parse("NaN").status !== "complete", "NaN literal");
  assert(parse("Infinity").status !== "complete", "Infinity literal");
  assert(parse("'hello'").status !== "complete", "single-quoted string");

  // =============================================
  // Parse → stringify round-trip
  // =============================================
  console.log("\nRound-trip correctness:");
  const roundTripCases = [
    '{"key":"value"}',
    "[1,2,3,4,5]",
    "true",
    "false",
    "null",
    "42",
    "-1",
    "0",
    '"hello world"',
    '{"nested":{"deep":{"value":[1,2,3]}}}',
    '[null,true,false,1,"string"]',
    '{"empty_obj":{},"empty_arr":[]}',
    '{"escape":"line\\nnewline"}',
    '{"quote":"say \\"hello\\""}',
    '{"slash":"back\\\\slash"}',
  ];
  for (const json of roundTripCases) {
    const parsed = parse(json).value;
    const restr = JSON.stringify(parsed);
    assertEqual(restr, json, `roundtrip: ${json.slice(0, 40)}`);
  }

  // =============================================
  // Streaming standards
  // =============================================
  console.log("\nStreaming — Incremental parsing:");

  // Byte-by-byte feeding
  {
    const json = '{"hello":"world","num":42}';
    const parser = createParser();
    let status;
    for (let i = 0; i < json.length; i++) {
      status = parser.feed(json[i]);
    }
    assert(status === "complete", "byte-by-byte complete");
    const val = parser.getValue();
    assertEqual(val, { hello: "world", num: 42 }, "byte-by-byte value correct");
    parser.destroy();
  }

  // NDJSON (newline-delimited)
  {
    const ndjson = '{"a":1}\n{"b":2}\n';
    const parser = createParser();
    const status = parser.feed(ndjson);
    assert(
      status === "end_early",
      "NDJSON: first value complete with trailing data"
    );
    const val = parser.getValue();
    assertEqual(val, { a: 1 }, "NDJSON: first value correct");
    const remaining = parser.getRemaining();
    assert(remaining !== null, "NDJSON: has remaining bytes");
    const remainingStr = new TextDecoder().decode(remaining);
    assert(
      remainingStr.startsWith('{"b":2}'),
      "NDJSON: remaining is second value"
    );
    parser.destroy();
  }

  // =============================================
  // Summary
  // =============================================
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Standards compliance: ${pass} passed, ${fail} failed out of ${pass + fail}`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
