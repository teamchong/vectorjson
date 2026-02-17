/**
 * ParseResult status tests — verifies the unified parse() API
 * returns correct status for complete, complete_early, incomplete, and invalid inputs.
 */
import { parse, materialize } from "../dist/index.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ❌ ${name}: ${err.message}`);
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

console.log("\n🧪 VectorJSON ParseResult Status Tests\n");

// ============================================================
// Status: "complete" — valid, self-contained JSON
// ============================================================
console.log("--- Status: complete ---");

test("complete: simple object", () => {
  const r = parse('{"a":1}');
  assertEqual(r.status, "complete");
  assertEqual(r.value, { a: 1 });
  assert(r.remaining === undefined, "no remaining for complete");
  assert(r.error === undefined, "no error for complete");
});

test("complete: scalar number", () => {
  const r = parse("42");
  assertEqual(r.status, "complete");
  assertEqual(r.value, 42);
});

test("complete: scalar true", () => {
  const r = parse("true");
  assertEqual(r.status, "complete");
  assertEqual(r.value, true);
});

test("complete: scalar false", () => {
  const r = parse("false");
  assertEqual(r.status, "complete");
  assertEqual(r.value, false);
});

test("complete: scalar null", () => {
  const r = parse("null");
  assertEqual(r.status, "complete");
  assertEqual(r.value, null);
});

test("complete: scalar string", () => {
  const r = parse('"hello"');
  assertEqual(r.status, "complete");
  assertEqual(r.value, "hello");
});

test("complete: array", () => {
  const r = parse("[1,2,3]");
  assertEqual(r.status, "complete");
  assertEqual(r.value, [1, 2, 3]);
});

test("complete: nested object", () => {
  const r = parse('{"a":{"b":1}}');
  assertEqual(r.status, "complete");
  assertEqual(r.value, { a: { b: 1 } });
});

test("complete: with trailing whitespace", () => {
  const r = parse('{"a":1}   \n\t');
  assertEqual(r.status, "complete");
  assertEqual(r.value, { a: 1 });
});

// ============================================================
// Status: "complete_early" — valid value with trailing non-whitespace
// ============================================================
console.log("\n--- Status: complete_early ---");

test("complete_early: two objects", () => {
  const r = parse('{"a":1}{"b":2}');
  assertEqual(r.status, "complete_early");
  assertEqual(r.value, { a: 1 });
  assert(r.remaining instanceof Uint8Array, "remaining is Uint8Array");
  const remainingStr = new TextDecoder().decode(r.remaining);
  assertEqual(remainingStr, '{"b":2}');
});

test("complete_early: number with trailing text", () => {
  const r = parse("42 abc");
  assertEqual(r.status, "complete_early");
  assertEqual(r.value, 42);
  const remainingStr = new TextDecoder().decode(r.remaining);
  assertEqual(remainingStr, " abc");
});

test("complete_early: array with trailing data", () => {
  const r = parse("[1,2,3]extra");
  assertEqual(r.status, "complete_early");
  assertEqual(r.value, [1, 2, 3]);
  const remainingStr = new TextDecoder().decode(r.remaining);
  assertEqual(remainingStr, "extra");
});

test("complete_early: NDJSON-style", () => {
  const r = parse('{"line":1}\n{"line":2}');
  assertEqual(r.status, "complete_early");
  assertEqual(r.value, { line: 1 });
  const remainingStr = new TextDecoder().decode(r.remaining);
  assert(remainingStr.includes('{"line":2}'), "remaining contains second line");
});

test("complete_early: string with trailing data", () => {
  const r = parse('"hello"world');
  assertEqual(r.status, "complete_early");
  assertEqual(r.value, "hello");
  const remainingStr = new TextDecoder().decode(r.remaining);
  assertEqual(remainingStr, "world");
});

// ============================================================
// Status: "incomplete" — structurally unfinished JSON
// ============================================================
console.log("\n--- Status: incomplete ---");

test("incomplete: unclosed array", () => {
  const r = parse("[1,2,3");
  assertEqual(r.status, "incomplete");
  // Autocompleted to [1,2,3]
  assertEqual(r.value, [1, 2, 3]);
});

test("incomplete: unclosed object with string value", () => {
  const r = parse('{"name":"bo');
  assertEqual(r.status, "incomplete");
  // Autocompleted: close string, close object → {"name":"bo"}
  assertEqual(r.value, { name: "bo" });
});

test("incomplete: nested incomplete", () => {
  const r = parse('[{"a":1},{"b":');
  assertEqual(r.status, "incomplete");
  // Autocompleted: after ':' → null, close object, close array
  assertEqual(r.value, [{ a: 1 }, { b: null }]);
});

test("incomplete: object with dangling colon", () => {
  const r = parse('{"a":');
  assertEqual(r.status, "incomplete");
  // Autocompleted: after ':' → null, close object
  assertEqual(r.value, { a: null });
});

test("incomplete: unclosed object brace", () => {
  const r = parse('{"x":1');
  assertEqual(r.status, "incomplete");
  assertEqual(r.value, { x: 1 });
});

test("incomplete: empty unclosed array", () => {
  const r = parse("[");
  assertEqual(r.status, "incomplete");
  assertEqual(r.value, []);
});

test("incomplete: empty unclosed object", () => {
  const r = parse("{");
  assertEqual(r.status, "incomplete");
  // Autocompleted: just close the brace → {}
  assertEqual(r.value, {});
});

test("incomplete: trailing comma in array", () => {
  const r = parse("[1,2,");
  assertEqual(r.status, "incomplete");
  // Autocompleted: after ',' in array → null, close array
  assertEqual(r.value, [1, 2, null]);
});

test("incomplete: trailing comma in object", () => {
  const r = parse('{"a":1,');
  assertEqual(r.status, "incomplete");
  // Autocompleted: after ',' in object → "":null, close object
  const materialized = materialize(r.value);
  assert("a" in materialized, "has key 'a'");
  assertEqual(materialized.a, 1);
});

test("incomplete: mid-string at root level", () => {
  const r = parse('"hello');
  assertEqual(r.status, "incomplete");
  // Autocompleted: close string → "hello"
  assertEqual(r.value, "hello");
});

test("incomplete: empty input", () => {
  const r = parse("");
  assertEqual(r.status, "incomplete");
  // No value can be produced from empty input
  assert(r.value === undefined, "no value for empty input");
});

// ============================================================
// Status: "invalid" — structurally impossible JSON
// ============================================================
console.log("\n--- Status: invalid ---");

test("invalid: unmatched closing brace", () => {
  const r = parse("}");
  assertEqual(r.status, "invalid");
  assert(r.error !== undefined, "has error message");
  assert(r.value === undefined, "no value for invalid");
});

test("invalid: unmatched closing bracket", () => {
  const r = parse("]");
  assertEqual(r.status, "invalid");
  assert(r.error !== undefined, "has error message");
});

test("invalid: closing before opening", () => {
  const r = parse("}{");
  assertEqual(r.status, "invalid");
  assert(r.error !== undefined, "has error message");
});

test("invalid: bracket mismatch closing first", () => {
  const r = parse("][");
  assertEqual(r.status, "invalid");
  assert(r.error !== undefined, "has error message");
});

// ============================================================
// Edge cases
// ============================================================
console.log("\n--- Edge cases ---");

test("Uint8Array input works with status", () => {
  const bytes = new TextEncoder().encode('{"binary":true}');
  const r = parse(bytes);
  assertEqual(r.status, "complete");
  assertEqual(r.value, { binary: true });
});

test("deeply nested incomplete", () => {
  const r = parse('{"a":{"b":{"c":[1,2');
  assertEqual(r.status, "incomplete");
  // Should autocomplete: close array, close objects
  assert(r.value !== undefined, "has value");
});

test("complete number with whitespace only after", () => {
  const r = parse("42   ");
  assertEqual(r.status, "complete");
  assertEqual(r.value, 42);
});

// ============================================================
// Complete — additional coverage
// ============================================================
console.log("\n--- Status: complete (additional) ---");

test("complete: negative number", () => {
  const r = parse("-7");
  assertEqual(r.status, "complete");
  assertEqual(r.value, -7);
});

test("complete: float", () => {
  const r = parse("3.14");
  assertEqual(r.status, "complete");
  assertEqual(r.value, 3.14);
});

test("complete: scientific notation", () => {
  const r = parse("1e10");
  assertEqual(r.status, "complete");
  assertEqual(r.value, 1e10);
});

test("complete: negative scientific notation", () => {
  const r = parse("-2.5e-3");
  assertEqual(r.status, "complete");
  assertEqual(r.value, -2.5e-3);
});

test("complete: zero", () => {
  const r = parse("0");
  assertEqual(r.status, "complete");
  assertEqual(r.value, 0);
});

test("complete: empty string", () => {
  const r = parse('""');
  assertEqual(r.status, "complete");
  assertEqual(r.value, "");
});

test("complete: string with escape sequences", () => {
  const r = parse('"hello\\nworld\\t!"');
  assertEqual(r.status, "complete");
  assertEqual(r.value, "hello\nworld\t!");
});

test("complete: string with escaped backslash", () => {
  const r = parse('"path\\\\to\\\\file"');
  assertEqual(r.status, "complete");
  assertEqual(r.value, "path\\to\\file");
});

test("complete: string with unicode escape", () => {
  const r = parse('"\\u0041\\u0042\\u0043"');
  assertEqual(r.status, "complete");
  assertEqual(r.value, "ABC");
});

test("complete: string with escaped quote", () => {
  const r = parse('"say \\"hello\\""');
  assertEqual(r.status, "complete");
  assertEqual(r.value, 'say "hello"');
});

test("complete: empty array", () => {
  const r = parse("[]");
  assertEqual(r.status, "complete");
  assertEqual(r.value, []);
});

test("complete: empty object", () => {
  const r = parse("{}");
  assertEqual(r.status, "complete");
  assertEqual(r.value, {});
});

test("complete: array of mixed types", () => {
  const r = parse('[1,"two",true,null,false]');
  assertEqual(r.status, "complete");
  assertEqual(r.value, [1, "two", true, null, false]);
});

test("complete: deeply nested containers", () => {
  const r = parse('{"a":[{"b":[{"c":1}]}]}');
  assertEqual(r.status, "complete");
  assertEqual(r.value, { a: [{ b: [{ c: 1 }] }] });
});

test("complete: object with all value types", () => {
  const r = parse('{"n":null,"b":true,"f":false,"i":42,"s":"hi","a":[1],"o":{}}');
  assertEqual(r.status, "complete");
  const v = materialize(r.value);
  assertEqual(v.n, null);
  assertEqual(v.b, true);
  assertEqual(v.f, false);
  assertEqual(v.i, 42);
  assertEqual(v.a, [1]);
  assertEqual(v.o, {});
});

test("complete: leading whitespace", () => {
  const r = parse("  \n\t  42");
  assertEqual(r.status, "complete");
  assertEqual(r.value, 42);
});

test("complete: leading and trailing whitespace", () => {
  const r = parse("  \n  [1,2]  \t  ");
  assertEqual(r.status, "complete");
  assertEqual(r.value, [1, 2]);
});

test("complete: whitespace-heavy object", () => {
  const r = parse(' { "a" : 1 , "b" : 2 } ');
  assertEqual(r.status, "complete");
  assertEqual(r.value, { a: 1, b: 2 });
});

// ============================================================
// Complete_early — additional coverage
// ============================================================
console.log("\n--- Status: complete_early (additional) ---");

test("complete_early: true followed by true", () => {
  const r = parse("true false");
  assertEqual(r.status, "complete_early");
  assertEqual(r.value, true);
  const rem = new TextDecoder().decode(r.remaining);
  assertEqual(rem, " false");
});

test("complete_early: null followed by number", () => {
  const r = parse("null 42");
  assertEqual(r.status, "complete_early");
  assertEqual(r.value, null);
});

test("complete_early: false with trailing text", () => {
  const r = parse("false,true");
  assertEqual(r.status, "complete_early");
  assertEqual(r.value, false);
  const rem = new TextDecoder().decode(r.remaining);
  assertEqual(rem, ",true");
});

test("complete_early: object then array", () => {
  const r = parse('{"x":1}[2,3]');
  assertEqual(r.status, "complete_early");
  assertEqual(r.value, { x: 1 });
  const rem = new TextDecoder().decode(r.remaining);
  assertEqual(rem, "[2,3]");
});

test("complete_early: string followed by string", () => {
  const r = parse('"first""second"');
  assertEqual(r.status, "complete_early");
  assertEqual(r.value, "first");
  const rem = new TextDecoder().decode(r.remaining);
  assertEqual(rem, '"second"');
});

test("complete_early: array then number", () => {
  const r = parse("[1] 2");
  assertEqual(r.status, "complete_early");
  assertEqual(r.value, [1]);
  const rem = new TextDecoder().decode(r.remaining);
  assertEqual(rem, " 2");
});

test("complete_early: remaining is independent copy (not WASM alias)", () => {
  const r1 = parse('1\n2\n3');
  assertEqual(r1.status, "complete_early");
  assertEqual(r1.value, 1);
  const rem1 = new TextDecoder().decode(r1.remaining);
  // Parse again — r1.remaining should not be corrupted by the second parse
  const r2 = parse('{"overwrite":"buffer"}');
  assertEqual(r2.status, "complete");
  const rem1After = new TextDecoder().decode(r1.remaining);
  assertEqual(rem1, rem1After, "remaining bytes survive subsequent parse");
});

test("complete_early: consecutive NDJSON parse loop", () => {
  let input = '{"a":1}\n{"b":2}\n{"c":3}\n';
  const values = [];
  while (input.length > 0) {
    const r = parse(input);
    if (r.status === "complete" || r.status === "complete_early") {
      values.push(materialize(r.value));
      if (r.remaining) {
        input = new TextDecoder().decode(r.remaining);
        // Skip leading whitespace
        input = input.replace(/^\s+/, "");
      } else {
        break;
      }
    } else {
      break;
    }
  }
  assertEqual(values.length, 3);
  assertEqual(values[0], { a: 1 });
  assertEqual(values[1], { b: 2 });
  assertEqual(values[2], { c: 3 });
});

// ============================================================
// Incomplete — additional coverage (autocomplete edge cases)
// ============================================================
console.log("\n--- Status: incomplete (additional) ---");

test("incomplete: string with escape at end", () => {
  // Ends with backslash — escape_next is true at EOF
  const r = parse('"hello\\');
  assertEqual(r.status, "incomplete");
  // autocomplete closes the string after the escape char
  assert(r.value !== undefined, "produces a value");
});

test("incomplete: string with unicode escape mid-sequence → incomplete", () => {
  // Partial unicode escape \u00 — autocomplete strips the incomplete escape
  // and closes the string, producing an empty string value
  const r = parse('"\\u00');
  assertEqual(r.status, "incomplete");
  assertEqual(r.toJSON(), "");
});

test("incomplete: nested arrays 3 deep", () => {
  const r = parse("[[[1,2");
  assertEqual(r.status, "incomplete");
  // Autocomplete: close inner array ]], close outer ]
  assertEqual(r.value, [[[1, 2]]]);
});

test("incomplete: array of objects, last object partial", () => {
  const r = parse('[{"id":1},{"id":2},{"id":');
  assertEqual(r.status, "incomplete");
  const v = materialize(r.value);
  assertEqual(v[0], { id: 1 });
  assertEqual(v[1], { id: 2 });
  assertEqual(v[2].id, null); // dangling colon → autocompleted null
});

test("incomplete: object with multiple keys, last has no value", () => {
  const r = parse('{"x":1,"y":2,"z":');
  assertEqual(r.status, "incomplete");
  const v = materialize(r.value);
  assertEqual(v.x, 1);
  assertEqual(v.y, 2);
  assertEqual(v.z, null);
});

test("incomplete: nested object within array, mid-key string", () => {
  const r = parse('[{"name":"ali');
  assertEqual(r.status, "incomplete");
  // Autocomplete closes the string, then the object, then the array
  const v = materialize(r.value);
  assertEqual(v[0].name, "ali");
});

test("incomplete: object where value is partial array", () => {
  const r = parse('{"items":[1,2,3');
  assertEqual(r.status, "incomplete");
  const v = materialize(r.value);
  assertEqual(v.items, [1, 2, 3]);
});

test("incomplete: deeply nested 4 levels", () => {
  const r = parse('{"a":{"b":{"c":{"d":');
  assertEqual(r.status, "incomplete");
  const v = materialize(r.value);
  assertEqual(v.a.b.c.d, null);
});

test("incomplete: array with nested empty object unclosed", () => {
  const r = parse("[1,{");
  assertEqual(r.status, "incomplete");
  const v = materialize(r.value);
  assertEqual(v[0], 1);
  assertEqual(v[1], {});
});

test("incomplete: object with boolean value truncated", () => {
  // "tru" is a partial keyword inside a container. autocomplete completes it to "true"
  // and closes the brace → incomplete with { flag: true }
  const r = parse('{"flag":tru');
  assertEqual(r.status, "incomplete");
  const v = r.toJSON();
  assertEqual(v.flag, true);
});

test("incomplete: only whitespace then partial token", () => {
  const r = parse("   [");
  assertEqual(r.status, "incomplete");
  assertEqual(r.value, []);
});

test("incomplete: object trailing comma then whitespace", () => {
  const r = parse('{"a":1,  ');
  assertEqual(r.status, "incomplete");
  // after_comma_in_obj → appends "":null then }
  const v = materialize(r.value);
  assertEqual(v.a, 1);
});

test("incomplete: array trailing comma then whitespace", () => {
  const r = parse("[1,2,  ");
  assertEqual(r.status, "incomplete");
  // after_comma_in_arr → appends null then ]
  assertEqual(r.value, [1, 2, null]);
});

test("incomplete: mixed object and array nesting", () => {
  const r = parse('[{"a":[1,{"b":');
  assertEqual(r.status, "incomplete");
  const v = materialize(r.value);
  assertEqual(v[0].a[0], 1);
  assertEqual(v[0].a[1].b, null);
});

test("incomplete: large partial JSON (AI SDK scenario)", () => {
  // Simulates tokens arriving from LLM output
  const partial = '{"response":{"model":"gpt-4","choices":[{"index":0,"message":{"role":"assistant","content":"Hello, I\'m here to';
  const r = parse(partial);
  assertEqual(r.status, "incomplete");
  const v = materialize(r.value);
  assertEqual(v.response.model, "gpt-4");
  assertEqual(v.response.choices[0].index, 0);
  assertEqual(v.response.choices[0].message.role, "assistant");
  // The content string was mid-stream; autocomplete closes it
  assert(typeof v.response.choices[0].message.content === "string", "content is a string");
  assert(v.response.choices[0].message.content.startsWith("Hello, I'm here to"), "content starts correctly");
});

test("incomplete: Uint8Array input", () => {
  const bytes = new TextEncoder().encode('[1,2,');
  const r = parse(bytes);
  assertEqual(r.status, "incomplete");
  assertEqual(r.value, [1, 2, null]);
});

// ============================================================
// Invalid — additional coverage
// ============================================================
console.log("\n--- Status: invalid (additional) ---");

test("invalid: extra closing bracket mid-stream", () => {
  const r = parse("[1]]");
  // After [1] closes at depth 0, next ] makes depth -1
  // Actually: classify sees [1] → complete, then ] → complete_early
  // doc_parse parses just [1], remaining is "]"
  assert(r.status === "complete_early" || r.status === "invalid", "extra bracket handled");
});

test("invalid: extra closing brace mid-stream", () => {
  const r = parse("{}}");
  assert(r.status === "complete_early" || r.status === "invalid", "extra brace handled");
});

test("invalid: lone closing bracket in array context", () => {
  const r = parse("]}}");
  assertEqual(r.status, "invalid");
  assert(r.error !== undefined, "has error");
});

test("invalid: multiple unmatched closers", () => {
  const r = parse("}}}");
  assertEqual(r.status, "invalid");
  assert(r.error !== undefined, "has error");
});

test("invalid: mismatched brackets", () => {
  // { opened, ] tries to close — structurally balanced depth but classifier
  // doesn't check bracket pairing, just depth. This will pass classify but
  // fail doc_parse → status "invalid"
  const r = parse("{]");
  assertEqual(r.status, "invalid");
});

test("invalid: structurally balanced but bad grammar — trailing comma", () => {
  // [1,] → classify says "complete" (balanced), doc_parse rejects → "invalid"
  const r = parse("[1,]");
  assertEqual(r.status, "invalid");
});

test("invalid: structurally balanced but bad grammar — leading comma", () => {
  const r = parse("[,1]");
  assertEqual(r.status, "invalid");
});

test("invalid: structurally balanced but bad grammar — double comma", () => {
  const r = parse("[1,,2]");
  assertEqual(r.status, "invalid");
});

test("invalid: structurally balanced but bad grammar — missing value after colon", () => {
  const r = parse('{"a":}');
  assertEqual(r.status, "invalid");
});

test("invalid: structurally balanced but bad grammar — missing colon", () => {
  const r = parse('{"a" 1}');
  assertEqual(r.status, "invalid");
});

test("invalid: structurally balanced but bad grammar — object trailing comma", () => {
  const r = parse('{"a":1,}');
  assertEqual(r.status, "invalid");
});

test("invalid: undefined literal", () => {
  const r = parse("undefined");
  // classify sees scalar start → complete. doc_parse fails → invalid.
  assertEqual(r.status, "invalid");
});

test("invalid: NaN literal", () => {
  const r = parse("NaN");
  assertEqual(r.status, "invalid");
});

test("invalid: Infinity literal", () => {
  const r = parse("Infinity");
  assertEqual(r.status, "invalid");
});

test("invalid: leading zeros in number", () => {
  const r = parse("007");
  // JSON spec forbids leading zeros. classify says "complete", doc_parse rejects.
  assertEqual(r.status, "invalid");
});

// ============================================================
// Idempotency & round-trip stability
// ============================================================
console.log("\n--- Round-trip stability ---");

test("complete → stringify → parse round-trip", () => {
  const inputs = [
    '{"hello":"world"}',
    "[1,2,3,4,5]",
    "true",
    "false",
    "null",
    "42",
    '""',
    '{"nested":{"deep":[1,2,3]}}',
  ];
  for (const input of inputs) {
    const r1 = parse(input);
    assertEqual(r1.status, "complete");
    const json = JSON.stringify(r1.value);
    const r2 = parse(json);
    assertEqual(r2.status, "complete");
    assertEqual(JSON.stringify(materialize(r2.value)), JSON.stringify(materialize(r1.value)));
  }
});

test("incomplete → autocomplete → re-parse produces complete", () => {
  // Parse incomplete JSON, stringify the autocompleted result, re-parse — now it's complete
  const r1 = parse('[1,2,{"a":');
  assertEqual(r1.status, "incomplete");
  const complete = JSON.stringify(r1.value);
  const r2 = parse(complete);
  assertEqual(r2.status, "complete");
  assertEqual(r2.value, [1, 2, { a: null }]);
});

test("repeated parses don't leak status between calls", () => {
  const r1 = parse("}");
  assertEqual(r1.status, "invalid");
  const r2 = parse("42");
  assertEqual(r2.status, "complete");
  assertEqual(r2.value, 42);
  const r3 = parse("[1,2");
  assertEqual(r3.status, "incomplete");
  const r4 = parse("true");
  assertEqual(r4.status, "complete");
  assertEqual(r4.value, true);
});

// ============================================================
// Proxy behavior on incomplete/complete_early values
// ============================================================
console.log("\n--- Proxy behavior ---");

test("incomplete value supports property access", () => {
  const r = parse('{"name":"alice","age":30,"items":[1,2');
  assertEqual(r.status, "incomplete");
  const v = r.value;
  assertEqual(v.age, 30);
  assertEqual(v.items[0], 1);
  assertEqual(v.items[1], 2);
});

test("incomplete value supports Object.keys", () => {
  const r = parse('{"x":1,"y":2');
  assertEqual(r.status, "incomplete");
  const keys = Object.keys(r.value);
  assert(keys.includes("x"), "has key x");
  assert(keys.includes("y"), "has key y");
});

test("incomplete value supports JSON.stringify", () => {
  const r = parse('[1,"hello",true');
  assertEqual(r.status, "incomplete");
  const json = JSON.stringify(r.value);
  assertEqual(json, '[1,"hello",true]');
});

test("incomplete value supports for..of on arrays", () => {
  const r = parse("[10,20,30");
  assertEqual(r.status, "incomplete");
  const collected = [];
  for (const item of r.value) {
    collected.push(item);
  }
  assertEqual(collected, [10, 20, 30]);
});

test("incomplete value supports spread", () => {
  const r = parse("[1,2,3");
  assertEqual(r.status, "incomplete");
  const copy = [...r.value];
  assertEqual(copy, [1, 2, 3]);
});

test("complete_early value supports full traversal", () => {
  const r = parse('{"users":[{"name":"alice"}]}{"more":true}');
  assertEqual(r.status, "complete_early");
  const v = r.value;
  assertEqual(v.users.length, 1);
  assertEqual(v.users[0].name, "alice");
});

test("complete value supports .free()", () => {
  const r = parse('{"a":1,"b":[2,3]}');
  assertEqual(r.status, "complete");
  // Access some values first
  assertEqual(r.value.a, 1);
  // Explicitly free the doc slot
  r.value.free();
  // Subsequent parse should work fine (slot reused)
  const r2 = parse('{"c":4}');
  assertEqual(r2.status, "complete");
  assertEqual(r2.value.c, 4);
});

// ============================================================
// Stress / boundary tests
// ============================================================
console.log("\n--- Stress / boundary ---");

test("many sequential incomplete parses don't exhaust slots", () => {
  for (let i = 0; i < 200; i++) {
    const r = parse(`[${i},`);
    assertEqual(r.status, "incomplete");
    assertEqual(r.value[0], i);
    r.value.free();
  }
});

test("alternating status types in rapid succession", () => {
  const cases = [
    { input: "42", expected: "complete" },
    { input: "[1,", expected: "incomplete" },
    { input: "}", expected: "invalid" },
    { input: "1 2", expected: "complete_early" },
    { input: '{"a":1}', expected: "complete" },
    { input: '{"a":', expected: "incomplete" },
    { input: "]", expected: "invalid" },
    { input: '"hi"bye', expected: "complete_early" },
  ];
  for (const { input, expected } of cases) {
    const r = parse(input);
    assertEqual(r.status, expected, `"${input}" → ${expected}, got ${r.status}`);
  }
});

test("large complete JSON", () => {
  const big = { items: Array.from({ length: 500 }, (_, i) => ({ id: i, v: "x".repeat(20) })) };
  const json = JSON.stringify(big);
  const r = parse(json);
  assertEqual(r.status, "complete");
  assertEqual(r.value.items.length, 500);
  assertEqual(r.value.items[499].id, 499);
});

test("large incomplete JSON (truncated mid-array)", () => {
  const big = { items: Array.from({ length: 100 }, (_, i) => ({ id: i })) };
  const json = JSON.stringify(big);
  // Truncate mid-stream
  const partial = json.slice(0, Math.floor(json.length * 0.6));
  const r = parse(partial);
  assertEqual(r.status, "incomplete");
  assert(r.value !== undefined, "produces partial value");
  // Some items should be accessible
  assert(r.value.items.length > 0, "has some items");
  assertEqual(r.value.items[0].id, 0);
});

// ============================================================
// Results
// ============================================================
console.log(`\n✨ ParseResult Tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
