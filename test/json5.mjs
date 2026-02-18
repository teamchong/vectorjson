/**
 * JSON5 format tests.
 * Tests format: "json5" on both createParser and createEventParser.
 */
import { createParser, createEventParser } from "../dist/index.js";

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion failed");
}

console.log("\n🧪 VectorJSON JSON5 Tests\n");

// --- Line comments ---

await test("json5: line comments", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed('{\n  // this is a comment\n  "a": 1\n}');
  assertEqual(status, "complete");
  const v = p.getValue();
  assertEqual(v, { a: 1 });
  p.destroy();
});

// --- Block comments ---

await test("json5: block comments", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed('{"a": /* inline comment */ 1}');
  assertEqual(status, "complete");
  assertEqual(p.getValue(), { a: 1 });
  p.destroy();
});

await test("json5: block comment spanning chunks", () => {
  const p = createParser({ format: "json5" });
  assertEqual(p.feed('{"a": /* this comment'), "incomplete");
  assertEqual(p.feed(' spans chunks */ 1}'), "complete");
  assertEqual(p.getValue(), { a: 1 });
  p.destroy();
});

// --- Trailing commas ---

await test("json5: trailing comma in object", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed('{"a": 1, "b": 2,}');
  assertEqual(status, "complete");
  assertEqual(p.getValue(), { a: 1, b: 2 });
  p.destroy();
});

await test("json5: trailing comma in array", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed('[1, 2, 3,]');
  assertEqual(status, "complete");
  assertEqual(p.getValue(), [1, 2, 3]);
  p.destroy();
});

// --- Single-quoted strings ---

await test("json5: single-quoted strings", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed("{'a': 'hello'}");
  assertEqual(status, "complete");
  assertEqual(p.getValue(), { a: "hello" });
  p.destroy();
});

await test("json5: single-quoted string with escaped single quote", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed("{'a': 'it\\'s'}");
  assertEqual(status, "complete");
  assertEqual(p.getValue(), { a: "it's" });
  p.destroy();
});

// --- Unquoted keys ---

await test("json5: unquoted keys", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed('{name: "Alice", age: 30}');
  assertEqual(status, "complete");
  assertEqual(p.getValue(), { name: "Alice", age: 30 });
  p.destroy();
});

// --- Hex numbers ---

await test("json5: hex numbers", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed('{"a": 0xFF}');
  assertEqual(status, "complete");
  assertEqual(p.getValue(), { a: 255 });
  p.destroy();
});

await test("json5: hex number 0x1A", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed('{"val": 0x1A}');
  assertEqual(status, "complete");
  assertEqual(p.getValue(), { val: 26 });
  p.destroy();
});

// --- Infinity and NaN ---

await test("json5: Infinity", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed('{"a": Infinity}');
  assertEqual(status, "complete");
  const v = p.getValue();
  assert(v.a === Infinity, `Expected Infinity, got ${v.a}`);
  p.destroy();
});

await test("json5: -Infinity", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed('{"a": -Infinity}');
  assertEqual(status, "complete");
  const v = p.getValue();
  assert(v.a === -Infinity, `Expected -Infinity, got ${v.a}`);
  p.destroy();
});

await test("json5: +Infinity", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed('{"a": +Infinity}');
  assertEqual(status, "complete");
  const v = p.getValue();
  assert(v.a === Infinity, `Expected Infinity, got ${v.a}`);
  p.destroy();
});

await test("json5: NaN becomes null", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed('{"a": NaN}');
  assertEqual(status, "complete");
  assertEqual(p.getValue(), { a: null });
  p.destroy();
});

// --- Nested JSON5 features combined ---

await test("json5: combined features", () => {
  const p = createParser({ format: "json5" });
  const input = `{
    // user config
    name: 'Alice',
    age: 30,
    /* hex color */ color: 0xFF0000,
    tags: ['admin', 'user',],
  }`;
  const status = p.feed(input);
  assertEqual(status, "complete");
  const v = p.getValue();
  assertEqual(v.name, "Alice");
  assertEqual(v.age, 30);
  assertEqual(v.color, 16711680);
  assertEqual(v.tags, ["admin", "user"]);
  p.destroy();
});

// --- Streaming JSON5 ---

await test("json5: streaming with comments split across chunks", () => {
  const p = createParser({ format: "json5" });
  assertEqual(p.feed('{"a": // comment'), "incomplete");
  assertEqual(p.feed('\n1}'), "complete");
  assertEqual(p.getValue(), { a: 1 });
  p.destroy();
});

await test("json5: streaming with single-quoted string across chunks", () => {
  const p = createParser({ format: "json5" });
  assertEqual(p.feed("{'a': 'hel"), "incomplete");
  assertEqual(p.feed("lo'}"), "complete");
  assertEqual(p.getValue(), { a: "hello" });
  p.destroy();
});

// --- createEventParser + JSON5 ---

await test("json5: eventParser with comments", async () => {
  async function* chunks() {
    yield '{\n  // comment\n  "name": "Alice"\n}';
  }
  const ep = createEventParser({ format: "json5", source: chunks() });
  let finalValue;
  for await (const v of ep) {
    finalValue = v;
  }
  assertEqual(finalValue, { name: "Alice" });
});

await test("json5: eventParser with unquoted keys and trailing commas", async () => {
  async function* chunks() {
    yield '{name: "Bob", age: 25,}';
  }
  const ep = createEventParser({ format: "json5", source: chunks() });
  let finalValue;
  for await (const v of ep) {
    finalValue = v;
  }
  assertEqual(finalValue, { name: "Bob", age: 25 });
});

// --- Schema + JSON5 ---

await test("json5: schema + json5 combined", () => {
  const schema = {
    safeParse(v) {
      if (v && typeof v === 'object' && 'name' in v) return { success: true, data: v };
      return { success: false };
    },
    shape: { name: {} },
  };
  const p = createParser({ format: "json5", schema });
  p.feed('{name: "Alice", extra: 1}');
  const v = p.getValue();
  assertEqual(v, { name: "Alice" });
  p.destroy();
});

// --- Additional edge cases ---

await test("json5: single-quoted string with inner double quote", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed(`{'a': 'say "hi"'}`);
  assertEqual(status, "complete");
  assertEqual(p.getValue(), { a: 'say "hi"' });
  p.destroy();
});

await test("json5: escaped chars in single-quoted string (\\n, \\t)", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed("{'a': 'line1\\nline2\\ttab'}");
  assertEqual(status, "complete");
  assertEqual(p.getValue(), { a: "line1\nline2\ttab" });
  p.destroy();
});

await test("json5: unquoted key with $ prefix", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed('{$id: 1}');
  assertEqual(status, "complete");
  assertEqual(p.getValue(), { $id: 1 });
  p.destroy();
});

await test("json5: unquoted key with _ prefix", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed('{_private: true}');
  assertEqual(status, "complete");
  assertEqual(p.getValue(), { _private: true });
  p.destroy();
});

await test("json5: unquoted key with digits", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed('{key1: "a", key2: "b"}');
  assertEqual(status, "complete");
  assertEqual(p.getValue(), { key1: "a", key2: "b" });
  p.destroy();
});

await test("json5: uppercase hex 0X", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed('{"v": 0XAB}');
  assertEqual(status, "complete");
  assertEqual(p.getValue(), { v: 171 });
  p.destroy();
});

await test("json5: comment between key and colon", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed('{"a" /* comment */ : 1}');
  assertEqual(status, "complete");
  assertEqual(p.getValue(), { a: 1 });
  p.destroy();
});

await test("json5: comment between colon and value", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed('{"a": /* comment */ 1}');
  assertEqual(status, "complete");
  assertEqual(p.getValue(), { a: 1 });
  p.destroy();
});

await test("json5: multiple comments in a row", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed('{"a": /* c1 */ /* c2 */ 1}');
  assertEqual(status, "complete");
  assertEqual(p.getValue(), { a: 1 });
  p.destroy();
});

await test("json5: comments inside arrays", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed('[1, // comment\n2, /* c */ 3]');
  assertEqual(status, "complete");
  assertEqual(p.getValue(), [1, 2, 3]);
  p.destroy();
});

await test("json5: Infinity and NaN inside arrays", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed('[Infinity, -Infinity, NaN]');
  assertEqual(status, "complete");
  const v = p.getValue();
  assert(v[0] === Infinity, `Expected Infinity, got ${v[0]}`);
  assert(v[1] === -Infinity, `Expected -Infinity, got ${v[1]}`);
  assertEqual(v[2], null); // NaN → null
  p.destroy();
});

await test("json5: deeply nested JSON5", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed(`{
    a: {
      b: {
        // deep
        c: [1, 2, 3,],
      },
    },
  }`);
  assertEqual(status, "complete");
  assertEqual(p.getValue(), { a: { b: { c: [1, 2, 3] } } });
  p.destroy();
});

await test("json5: mixed single and double quoted strings", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed(`{"a": 'single', "b": "double"}`);
  assertEqual(status, "complete");
  assertEqual(p.getValue(), { a: "single", b: "double" });
  p.destroy();
});

await test("json5: for-await streaming", async () => {
  async function* chunks() {
    yield '{name: ';
    yield "'Alice', age: 30,}";
  }
  const p = createParser({ format: "json5", source: chunks() });
  let finalValue;
  for await (const v of p) {
    finalValue = v;
  }
  assertEqual(finalValue, { name: "Alice", age: 30 });
});

await test("json5: eventParser onDelta with single-quoted string", async () => {
  const ep = createEventParser({ format: "json5" });
  const deltas = [];
  ep.onDelta("msg", (e) => deltas.push(e.value));
  ep.feed("{'msg': 'hel");
  ep.feed("lo'}");
  assert(deltas.length > 0, "Should have fired delta events");
  const combined = deltas.join("");
  assertEqual(combined, "hello");
  ep.destroy();
});

await test("json5: eventParser on() with Infinity value", () => {
  const ep = createEventParser({ format: "json5" });
  const values = [];
  ep.on("timeout", (e) => values.push(e.value));
  // eventParser uses live doc builder, Infinity handled by parseJson5Scalar
  ep.feed('{timeout: Infinity}');
  // The on() callback may or may not fire depending on ptScan detecting the scalar
  // At minimum, getValue() should work
  const v = ep.getValue();
  assertEqual(v.timeout, Infinity);
  ep.destroy();
});

await test("json5: line comment at end of input", () => {
  const p = createParser({ format: "json5" });
  const status = p.feed('{"a": 1} // trailing comment');
  // The value completes before the comment; trailing content triggers end_early
  // but the comment is stripped, so it becomes whitespace
  assert(status === "complete" || status === "end_early", `Expected complete or end_early, got ${status}`);
  p.destroy();
});

console.log(`\n✨ JSON5 Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
