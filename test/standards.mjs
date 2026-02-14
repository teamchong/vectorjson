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

function assertThrows(fn, msg) {
  try {
    fn();
    fail++;
    console.log(`  ✗ ${msg} (did not throw)`);
  } catch {
    pass++;
    console.log(`  ✓ ${msg}`);
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
  assertEqual(vj.parse("{}"), {}, "empty object");
  assertEqual(vj.parse("[]"), [], "empty array");
  assertEqual(vj.parse('{"a":1}'), { a: 1 }, "object with one pair");
  assertEqual(vj.parse("[1]"), [1], "array with one element");

  console.log("\nRFC 8259 — Whitespace:");
  assertEqual(vj.parse(" { } "), {}, "spaces around object");
  assertEqual(vj.parse("\t[\t]\t"), [], "tabs around array");
  assertEqual(vj.parse("\n{\n}\n"), {}, "newlines around object");
  assertEqual(vj.parse("\r\n{\r\n}\r\n"), {}, "CRLF around object");
  assertEqual(
    vj.parse('  {  "a"  :  1  ,  "b"  :  2  }  '),
    { a: 1, b: 2 },
    "whitespace everywhere"
  );

  console.log("\nRFC 8259 — Strings:");
  assertEqual(vj.parse('""'), "", "empty string");
  assertEqual(vj.parse('"hello"'), "hello", "simple string");
  assertEqual(vj.parse('"\\""'), '"', "escaped quote");
  assertEqual(vj.parse('"\\\\"'), "\\", "escaped backslash");
  assertEqual(vj.parse('"\\/"'), "/", "escaped forward slash");
  assertEqual(vj.parse('"\\b"'), "\b", "escaped backspace");
  assertEqual(vj.parse('"\\f"'), "\f", "escaped form feed");
  assertEqual(vj.parse('"\\n"'), "\n", "escaped newline");
  assertEqual(vj.parse('"\\r"'), "\r", "escaped carriage return");
  assertEqual(vj.parse('"\\t"'), "\t", "escaped tab");
  assertEqual(vj.parse('"\\u0041"'), "A", "unicode escape (A)");
  assertEqual(vj.parse('"\\u00e9"'), "é", "unicode escape (é)");
  assertEqual(vj.parse('"\\u4e16\\u754c"'), "世界", "unicode escape CJK");

  // Surrogate pairs
  assertEqual(
    vj.parse('"\\uD83C\\uDF89"'),
    "🎉",
    "surrogate pair emoji (🎉)"
  );

  // String with all escape types
  assertEqual(
    vj.parse('"a\\"b\\\\c\\/d\\be\\ff\\ng\\rh\\ti"'),
    'a"b\\c/d\be\ff\ng\rh\ti',
    "all escape types combined"
  );

  console.log("\nRFC 8259 — Numbers:");
  assertEqual(vj.parse("0"), 0, "zero");
  assertEqual(vj.parse("-0"), -0, "negative zero");
  assertEqual(vj.parse("1"), 1, "positive integer");
  assertEqual(vj.parse("-1"), -1, "negative integer");
  assertEqual(vj.parse("123456789"), 123456789, "large integer");
  assertEqual(vj.parse("0.5"), 0.5, "decimal");
  assertEqual(vj.parse("-0.5"), -0.5, "negative decimal");
  assertEqual(vj.parse("1e2"), 100, "exponent lowercase");
  assertEqual(vj.parse("1E2"), 100, "exponent uppercase");
  assertEqual(vj.parse("1e+2"), 100, "exponent with plus");
  assertEqual(vj.parse("1e-2"), 0.01, "exponent with minus");
  assertEqual(vj.parse("1.5e3"), 1500, "decimal with exponent");
  assertEqual(
    vj.parse("9007199254740992"),
    9007199254740992,
    "MAX_SAFE_INTEGER + 1"
  );
  assertEqual(
    vj.parse("-9007199254740992"),
    -9007199254740992,
    "-(MAX_SAFE_INTEGER + 1)"
  );

  console.log("\nRFC 8259 — Literals:");
  assertEqual(vj.parse("true"), true, "true literal");
  assertEqual(vj.parse("false"), false, "false literal");
  assertEqual(vj.parse("null"), null, "null literal");

  console.log("\nRFC 8259 — Nesting:");
  assertEqual(
    vj.parse('{"a":{"b":{"c":{"d":1}}}}'),
    { a: { b: { c: { d: 1 } } } },
    "4 levels of nesting"
  );
  assertEqual(
    vj.parse("[[[[1]]]]"),
    [[[[1]]]],
    "4 levels of array nesting"
  );
  assertEqual(
    vj.parse('[{"a":[1,{"b":2}]}]'),
    [{ a: [1, { b: 2 }] }],
    "mixed nesting"
  );

  console.log("\nRFC 8259 — Invalid JSON (should throw):");
  assertThrows(() => vj.parse(""), "empty input");
  assertThrows(() => vj.parse("{"), "unclosed object");
  assertThrows(() => vj.parse("["), "unclosed array");
  assertThrows(() => vj.parse('{"a":}'), "missing value");
  assertThrows(() => vj.parse("[,]"), "leading comma in array");
  assertThrows(() => vj.parse("{,}"), "leading comma in object");
  assertThrows(() => vj.parse("[1,]"), "trailing comma in array");
  assertThrows(() => vj.parse('{"a":1,}'), "trailing comma in object");
  assertThrows(() => vj.parse("undefined"), "undefined literal");
  assertThrows(() => vj.parse("NaN"), "NaN literal");
  assertThrows(() => vj.parse("Infinity"), "Infinity literal");
  assertThrows(() => vj.parse("'hello'"), "single-quoted string");

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
    const parsed = vj.parse(json);
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
  // Deep Compare standards
  // =============================================
  console.log("\nDeep Compare — Structural equality:");

  // Order independence
  assertEqual(
    vj.deepCompare({ a: 1, b: 2 }, { b: 2, a: 1 }).length,
    0,
    "key order independent"
  );

  // Deep nested equality
  assertEqual(
    vj.deepCompare(
      { a: { b: { c: [1, 2, { d: true }] } } },
      { a: { b: { c: [1, 2, { d: true }] } } }
    ).length,
    0,
    "deep nested equality"
  );

  // Type sensitivity
  {
    const diffs = vj.deepCompare({ a: 1 }, { a: "1" });
    assert(diffs.length === 1, "type difference detected");
    assert(diffs[0].type === "type_changed", "type_changed diff type");
    assert(diffs[0].path === "$.a", "correct diff path");
  }

  // Array order matters
  {
    const diffs = vj.deepCompare([1, 2, 3], [3, 2, 1]);
    assert(diffs.length > 0, "array order matters");
  }

  // =============================================
  // Validation — JSON Schema standards
  // =============================================
  console.log("\nValidation — JSON Schema patterns:");

  // Nullable type pattern
  {
    const schema = { type: ["string", "null"] };
    assert(
      vj.validate("hello", schema).valid,
      "nullable: string accepted"
    );
    assert(
      vj.validate(null, schema).valid,
      "nullable: null accepted"
    );
    assert(
      !vj.validate(42, schema).valid,
      "nullable: number rejected"
    );
  }

  // Array of typed objects pattern
  {
    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1 },
          tags: {
            type: "array",
            items: { type: "string", minLength: 1 },
          },
        },
        required: ["id"],
      },
      minItems: 1,
    };

    assert(
      vj.validate(
        [
          { id: 1, tags: ["a", "b"] },
          { id: 2, tags: ["c"] },
        ],
        schema
      ).valid,
      "typed array of objects valid"
    );

    assert(
      !vj.validate([], schema).valid,
      "empty array fails minItems"
    );

    assert(
      !vj.validate([{ id: 1, tags: ["a", ""] }], schema).valid,
      "empty tag string fails minLength"
    );
  }

  // Config validation pattern
  {
    const configSchema = {
      type: "object",
      properties: {
        host: { type: "string", minLength: 1 },
        port: { type: "integer", minimum: 1, maximum: 65535 },
        debug: { type: "boolean" },
        maxRetries: { type: "integer", minimum: 0, maximum: 100 },
        logLevel: { enum: ["error", "warn", "info", "debug"] },
      },
      required: ["host", "port"],
      additionalProperties: false,
    };

    assert(
      vj.validate(
        { host: "localhost", port: 8080, debug: false, logLevel: "info" },
        configSchema
      ).valid,
      "valid config"
    );

    assert(
      !vj.validate({ host: "localhost" }, configSchema).valid,
      "missing required port"
    );

    assert(
      !vj.validate(
        { host: "localhost", port: 8080, unknown: true },
        configSchema
      ).valid,
      "additional property rejected"
    );

    assert(
      !vj.validate(
        { host: "localhost", port: 70000 },
        configSchema
      ).valid,
      "port out of range"
    );

    assert(
      !vj.validate(
        { host: "localhost", port: 8080, logLevel: "verbose" },
        configSchema
      ).valid,
      "invalid logLevel enum"
    );
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
