/**
 * Standards compliance tests
 * Covers RFC 8259 (JSON), ECMA-404, and common JSON Schema draft-07/2020-12 patterns.
 * Tests edge cases, Unicode, number precision, escaping, and structural correctness.
 */
import { init } from "../dist/index.js";

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
  const vj = await init();

  console.log("\n=== Standards Compliance Tests ===\n");

  // =============================================
  // RFC 8259 / ECMA-404: JSON Parsing
  // =============================================
  console.log("RFC 8259 — Structural characters:");
  assertEqual(vj.parse("{}").value, {}, "empty object");
  assertEqual(vj.parse("[]").value, [], "empty array");
  assertEqual(vj.parse('{"a":1}').value, { a: 1 }, "object with one pair");
  assertEqual(vj.parse("[1]").value, [1], "array with one element");

  console.log("\nRFC 8259 — Whitespace:");
  assertEqual(vj.parse(" { } ").value, {}, "spaces around object");
  assertEqual(vj.parse("\t[\t]\t").value, [], "tabs around array");
  assertEqual(vj.parse("\n{\n}\n").value, {}, "newlines around object");
  assertEqual(vj.parse("\r\n{\r\n}\r\n").value, {}, "CRLF around object");
  assertEqual(
    vj.parse('  {  "a"  :  1  ,  "b"  :  2  }  ').value,
    { a: 1, b: 2 },
    "whitespace everywhere"
  );

  console.log("\nRFC 8259 — Strings:");
  assertEqual(vj.parse('""').value, "", "empty string");
  assertEqual(vj.parse('"hello"').value, "hello", "simple string");
  assertEqual(vj.parse('"\\""').value, '"', "escaped quote");
  assertEqual(vj.parse('"\\\\"').value, "\\", "escaped backslash");
  assertEqual(vj.parse('"\\/"').value, "/", "escaped forward slash");
  assertEqual(vj.parse('"\\b"').value, "\b", "escaped backspace");
  assertEqual(vj.parse('"\\f"').value, "\f", "escaped form feed");
  assertEqual(vj.parse('"\\n"').value, "\n", "escaped newline");
  assertEqual(vj.parse('"\\r"').value, "\r", "escaped carriage return");
  assertEqual(vj.parse('"\\t"').value, "\t", "escaped tab");
  assertEqual(vj.parse('"\\u0041"').value, "A", "unicode escape (A)");
  assertEqual(vj.parse('"\\u00e9"').value, "é", "unicode escape (é)");
  assertEqual(vj.parse('"\\u4e16\\u754c"').value, "世界", "unicode escape CJK");

  // Surrogate pairs
  assertEqual(
    vj.parse('"\\uD83C\\uDF89"').value,
    "🎉",
    "surrogate pair emoji (🎉)"
  );

  // String with all escape types
  assertEqual(
    vj.parse('"a\\"b\\\\c\\/d\\be\\ff\\ng\\rh\\ti"').value,
    'a"b\\c/d\be\ff\ng\rh\ti',
    "all escape types combined"
  );

  console.log("\nRFC 8259 — Numbers:");
  assertEqual(vj.parse("0").value, 0, "zero");
  assertEqual(vj.parse("-0").value, -0, "negative zero");
  assertEqual(vj.parse("1").value, 1, "positive integer");
  assertEqual(vj.parse("-1").value, -1, "negative integer");
  assertEqual(vj.parse("123456789").value, 123456789, "large integer");
  assertEqual(vj.parse("0.5").value, 0.5, "decimal");
  assertEqual(vj.parse("-0.5").value, -0.5, "negative decimal");
  assertEqual(vj.parse("1e2").value, 100, "exponent lowercase");
  assertEqual(vj.parse("1E2").value, 100, "exponent uppercase");
  assertEqual(vj.parse("1e+2").value, 100, "exponent with plus");
  assertEqual(vj.parse("1e-2").value, 0.01, "exponent with minus");
  assertEqual(vj.parse("1.5e3").value, 1500, "decimal with exponent");
  assertEqual(
    vj.parse("9007199254740992").value,
    9007199254740992,
    "MAX_SAFE_INTEGER + 1"
  );
  assertEqual(
    vj.parse("-9007199254740992").value,
    -9007199254740992,
    "-(MAX_SAFE_INTEGER + 1)"
  );

  console.log("\nRFC 8259 — Literals:");
  assertEqual(vj.parse("true").value, true, "true literal");
  assertEqual(vj.parse("false").value, false, "false literal");
  assertEqual(vj.parse("null").value, null, "null literal");

  console.log("\nRFC 8259 — Nesting:");
  assertEqual(
    vj.parse('{"a":{"b":{"c":{"d":1}}}}').value,
    { a: { b: { c: { d: 1 } } } },
    "4 levels of nesting"
  );
  assertEqual(
    vj.parse("[[[[1]]]]").value,
    [[[[1]]]],
    "4 levels of array nesting"
  );
  assertEqual(
    vj.parse('[{"a":[1,{"b":2}]}]').value,
    [{ a: [1, { b: 2 }] }],
    "mixed nesting"
  );

  console.log("\nRFC 8259 — Invalid JSON (should return non-complete status):");
  assert(vj.parse("").status !== "complete", "empty input");
  assert(vj.parse("{").status !== "complete", "unclosed object");
  assert(vj.parse("[").status !== "complete", "unclosed array");
  assert(vj.parse('{"a":}').status !== "complete", "missing value");
  assert(vj.parse("[,]").status !== "complete", "leading comma in array");
  assert(vj.parse("{,}").status !== "complete", "leading comma in object");
  assert(vj.parse("[1,]").status !== "complete", "trailing comma in array");
  assert(vj.parse('{"a":1,}').status !== "complete", "trailing comma in object");
  assert(vj.parse("undefined").status !== "complete", "undefined literal");
  assert(vj.parse("NaN").status !== "complete", "NaN literal");
  assert(vj.parse("Infinity").status !== "complete", "Infinity literal");
  assert(vj.parse("'hello'").status !== "complete", "single-quoted string");

  // =============================================
  // Stringify standards compliance
  // =============================================
  console.log("\nStringify — RFC 8259 compliance:");
  assertEqual(vj.stringify(null), "null", "null");
  assertEqual(vj.stringify(true), "true", "true");
  assertEqual(vj.stringify(false), "false", "false");
  assertEqual(vj.stringify(0), "0", "zero");
  assertEqual(vj.stringify(-0), "0", "-0 → 0");
  assertEqual(vj.stringify(1), "1", "integer");
  assertEqual(vj.stringify(-1), "-1", "negative integer");
  assertEqual(vj.stringify(""), '""', "empty string");
  assertEqual(vj.stringify([]), "[]", "empty array");
  assertEqual(vj.stringify({}), "{}", "empty object");

  console.log("\nStringify — Escape sequences:");
  assertEqual(vj.stringify('"'), '"\\""', "quote");
  assertEqual(vj.stringify("\\"), '"\\\\"', "backslash");
  assertEqual(vj.stringify("\n"), '"\\n"', "newline");
  assertEqual(vj.stringify("\r"), '"\\r"', "carriage return");
  assertEqual(vj.stringify("\t"), '"\\t"', "tab");
  assertEqual(vj.stringify("\b"), '"\\b"', "backspace");
  assertEqual(vj.stringify("\f"), '"\\f"', "form feed");
  assertEqual(
    vj.stringify("\x00"),
    JSON.stringify("\x00"),
    "null byte escaped"
  );
  assertEqual(
    vj.stringify("\x1F"),
    JSON.stringify("\x1F"),
    "control char 0x1F escaped"
  );

  console.log("\nStringify — Special values:");
  assertEqual(vj.stringify(NaN), "null", "NaN → null");
  assertEqual(vj.stringify(Infinity), "null", "Infinity → null");
  assertEqual(vj.stringify(-Infinity), "null", "-Infinity → null");
  assertEqual(
    vj.stringify({ a: undefined }),
    "{}",
    "undefined property omitted"
  );
  assertEqual(
    vj.stringify([undefined]),
    "[null]",
    "undefined in array → null"
  );

  console.log("\nStringify — Round-trip correctness:");
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
    const parsed = vj.parse(json).value;
    const restr = vj.stringify(parsed);
    assertEqual(restr, json, `roundtrip: ${json.slice(0, 40)}`);
  }

  // =============================================
  // Streaming standards
  // =============================================
  console.log("\nStreaming — Incremental parsing:");

  // Byte-by-byte feeding
  {
    const json = '{"hello":"world","num":42}';
    const parser = vj.createParser();
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
    const parser = vj.createParser();
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
