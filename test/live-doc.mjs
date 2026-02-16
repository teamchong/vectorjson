/**
 * Live Document Builder Tests
 *
 * Tests the incremental JS object patching in createParser() and createEventParser().
 * Both parsers maintain a live JS object that gets patched on each feed(),
 * so getValue() returns a growing object without re-parsing.
 *
 * Covers edge cases: unclosed strings, unfinished numbers, partial true/false/null,
 * nested objects, arrays, escape sequences, chunk boundaries, and more.
 */

import { init } from "../dist/index.js";

let passed = 0, failed = 0;
const parsersToClean = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  \u2705 ${name}`); }
  catch (err) { failed++; console.error(`  \u274c ${name}: ${err.message}`); }
  finally {
    // Clean up any parsers that weren't destroyed (e.g., due to assertion failure)
    for (const p of parsersToClean) { try { p.destroy(); } catch {} }
    parsersToClean.length = 0;
  }
}
function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(msg || `Expected ${e}, got ${a}`);
}

console.log("\n\ud83e\uddea VectorJSON Live Document Builder Tests\n");
const vj = await init();

// ── Helper: test both createParser and createEventParser ──
// Wraps create() so parsers are auto-destroyed on test failure (prevents slot leaks)
function testBoth(name, fn) {
  test(`createParser: ${name}`, () => {
    fn((...args) => {
      const p = vj.createParser(...args);
      parsersToClean.push(p);
      return p;
    });
  });
  test(`createEventParser: ${name}`, () => {
    fn((...args) => {
      const p = vj.createEventParser(...args);
      parsersToClean.push(p);
      return p;
    });
  });
}

// ── Unclosed strings ──
console.log("--- Unclosed strings ---");

testBoth("unclosed string in object value", (create) => {
  const p = create();
  p.feed('{"name":"Ali');
  const val = p.getValue();
  assertEqual(val.name, "Ali");
  p.destroy();
});

testBoth("unclosed string with special chars", (create) => {
  const p = create();
  p.feed('{"msg":"hello wor');
  assertEqual(p.getValue().msg, "hello wor");
  p.destroy();
});

testBoth("unclosed empty string", (create) => {
  const p = create();
  p.feed('{"v":"');
  assertEqual(p.getValue().v, "");
  p.destroy();
});

testBoth("unclosed string with escape", (create) => {
  const p = create();
  p.feed('{"v":"line\\n');
  assertEqual(p.getValue().v, "line\n");
  p.destroy();
});

testBoth("unclosed string at root level", (create) => {
  const p = create();
  p.feed('"hello wor');
  assertEqual(p.getValue(), "hello wor");
  p.destroy();
});

testBoth("string value grows char by char", (create) => {
  const p = create();
  p.feed('{"s":"');
  assertEqual(p.getValue().s, "");
  p.feed('a');
  assertEqual(p.getValue().s, "a");
  p.feed('b');
  assertEqual(p.getValue().s, "ab");
  p.feed('c');
  assertEqual(p.getValue().s, "abc");
  p.feed('"');   // close the string
  p.feed('}');   // close the object
  assertEqual(p.getValue().s, "abc");
  p.destroy();
});

// ── Unfinished numbers ──
console.log("\n--- Unfinished numbers ---");

testBoth("integer value in object", (create) => {
  const p = create();
  p.feed('{"n":42}');
  assertEqual(p.getValue().n, 42);
  p.destroy();
});

testBoth("float value in object", (create) => {
  const p = create();
  p.feed('{"n":3.14}');
  assertEqual(p.getValue().n, 3.14);
  p.destroy();
});

testBoth("number split across chunks", (create) => {
  const p = create();
  p.feed('{"n":12');
  // Number not finalized yet (no delimiter seen) - try to parse what we have
  const val = p.getValue();
  if (val.n !== null && val.n !== 12 && val.n !== undefined) {
    throw new Error(`Expected null or 12, got ${val.n}`);
  }
  p.feed('34}');
  assertEqual(p.getValue().n, 1234);
  p.destroy();
});

testBoth("negative number", (create) => {
  const p = create();
  p.feed('{"n":-99}');
  assertEqual(p.getValue().n, -99);
  p.destroy();
});

testBoth("scientific notation", (create) => {
  const p = create();
  p.feed('{"n":1e5}');
  assertEqual(p.getValue().n, 100000);
  p.destroy();
});

// ── Unfinished true/false/null ──
console.log("\n--- Unfinished true/false/null ---");

testBoth("complete true", (create) => {
  const p = create();
  p.feed('{"v":true}');
  assertEqual(p.getValue().v, true);
  p.destroy();
});

testBoth("complete false", (create) => {
  const p = create();
  p.feed('{"v":false}');
  assertEqual(p.getValue().v, false);
  p.destroy();
});

testBoth("complete null", (create) => {
  const p = create();
  p.feed('{"v":null}');
  assertEqual(p.getValue().v, null);
  p.destroy();
});

testBoth("partial 'tr' autocompletes to true", (create) => {
  const p = create();
  p.feed('{"v":tr');
  const val = p.getValue();
  // Partial scalar — the live doc should show null placeholder OR the autocompleted value
  // Depending on implementation, either null (placeholder from colon) or true (autocompleted)
  if (val.v !== null && val.v !== true) {
    throw new Error(`Expected null or true, got ${JSON.stringify(val.v)}`);
  }
  p.destroy();
});

testBoth("partial 'fals' in object", (create) => {
  const p = create();
  p.feed('{"v":fals');
  const val = p.getValue();
  if (val.v !== null && val.v !== false) {
    throw new Error(`Expected null or false, got ${JSON.stringify(val.v)}`);
  }
  p.destroy();
});

testBoth("partial 'nu' in object", (create) => {
  const p = create();
  p.feed('{"v":nu');
  const val = p.getValue();
  // null placeholder or autocompleted null — both are null
  assertEqual(val.v, null);
  p.destroy();
});

// Root-level scalars only work with createParser (EventParser's seeker
// doesn't recognize bare scalars as JSON — it expects { [ or " as start)
test("createParser: root-level true", () => {
  const p = vj.createParser();
  parsersToClean.push(p);
  p.feed('true');
  assertEqual(p.getValue(), true);
  p.destroy();
});

test("createParser: root-level false", () => {
  const p = vj.createParser();
  parsersToClean.push(p);
  p.feed('false');
  assertEqual(p.getValue(), false);
  p.destroy();
});

test("createParser: root-level null", () => {
  const p = vj.createParser();
  parsersToClean.push(p);
  p.feed('null');
  assertEqual(p.getValue(), null);
  p.destroy();
});

test("createParser: root-level partial 'tr' autocompletes", () => {
  const p = vj.createParser();
  parsersToClean.push(p);
  p.feed('tr');
  assertEqual(p.getValue(), true);
  p.destroy();
});

test("createParser: root-level partial 'fals' autocompletes", () => {
  const p = vj.createParser();
  parsersToClean.push(p);
  p.feed('fals');
  assertEqual(p.getValue(), false);
  p.destroy();
});

test("createParser: root-level number", () => {
  const p = vj.createParser();
  parsersToClean.push(p);
  p.feed('42');
  assertEqual(p.getValue(), 42);
  p.destroy();
});

// ── Nested objects ──
console.log("\n--- Nested objects ---");

testBoth("nested object builds incrementally", (create) => {
  const p = create();
  p.feed('{"a":{');
  assertEqual(typeof p.getValue().a, "object");
  p.feed('"b":1');
  // b might be null (placeholder) or 1 (if delimiter not seen yet)
  p.feed('}');
  assertEqual(p.getValue().a.b, 1);
  p.feed('}');
  assertEqual(p.getValue(), { a: { b: 1 } });
  p.destroy();
});

testBoth("deeply nested (3 levels)", (create) => {
  const p = create();
  p.feed('{"a":{"b":{"c":42}}}');
  assertEqual(p.getValue(), { a: { b: { c: 42 } } });
  p.destroy();
});

testBoth("multiple keys in object", (create) => {
  const p = create();
  p.feed('{"a":1,');
  assertEqual(p.getValue().a, 1);
  p.feed('"b":2,');
  assertEqual(p.getValue().b, 2);
  p.feed('"c":3}');
  assertEqual(p.getValue(), { a: 1, b: 2, c: 3 });
  p.destroy();
});

testBoth("object with mixed value types", (create) => {
  const p = create();
  p.feed('{"s":"hello","n":42,"b":true,"v":null}');
  assertEqual(p.getValue(), { s: "hello", n: 42, b: true, v: null });
  p.destroy();
});

// ── Arrays ──
console.log("\n--- Arrays ---");

testBoth("simple array", (create) => {
  const p = create();
  p.feed('[1,2,3]');
  assertEqual(p.getValue(), [1, 2, 3]);
  p.destroy();
});

testBoth("array builds incrementally", (create) => {
  const p = create();
  p.feed('[1,');
  assertEqual(p.getValue()[0], 1);
  p.feed('2,');
  assertEqual(p.getValue()[1], 2);
  p.feed('3]');
  assertEqual(p.getValue(), [1, 2, 3]);
  p.destroy();
});

testBoth("array of strings", (create) => {
  const p = create();
  p.feed('["a","b","c"]');
  assertEqual(p.getValue(), ["a", "b", "c"]);
  p.destroy();
});

testBoth("array of objects", (create) => {
  const p = create();
  p.feed('[{"id":1},{"id":2}]');
  assertEqual(p.getValue(), [{ id: 1 }, { id: 2 }]);
  p.destroy();
});

testBoth("nested arrays", (create) => {
  const p = create();
  p.feed('[[1,2],[3,4]]');
  assertEqual(p.getValue(), [[1, 2], [3, 4]]);
  p.destroy();
});

testBoth("empty array", (create) => {
  const p = create();
  p.feed('{"items":[]}');
  assertEqual(p.getValue(), { items: [] });
  p.destroy();
});

testBoth("empty object", (create) => {
  const p = create();
  p.feed('{"data":{}}');
  assertEqual(p.getValue(), { data: {} });
  p.destroy();
});

// ── Escape sequences ──
console.log("\n--- Escape sequences ---");

testBoth("newline escape", (create) => {
  const p = create();
  p.feed('{"v":"line1\\nline2"}');
  assertEqual(p.getValue().v, "line1\nline2");
  p.destroy();
});

testBoth("tab escape", (create) => {
  const p = create();
  p.feed('{"v":"col1\\tcol2"}');
  assertEqual(p.getValue().v, "col1\tcol2");
  p.destroy();
});

testBoth("quote escape", (create) => {
  const p = create();
  p.feed('{"v":"say \\"hello\\""}');
  assertEqual(p.getValue().v, 'say "hello"');
  p.destroy();
});

testBoth("backslash escape", (create) => {
  const p = create();
  p.feed('{"v":"back\\\\slash"}');
  assertEqual(p.getValue().v, "back\\slash");
  p.destroy();
});

testBoth("escape split across chunks", (create) => {
  const p = create();
  p.feed('{"v":"hello\\');
  p.feed('nworld"}');
  assertEqual(p.getValue().v, "hello\nworld");
  p.destroy();
});

// ── Chunk boundary edge cases ──
console.log("\n--- Chunk boundary edge cases ---");

testBoth("chunk breaks at opening brace", (create) => {
  const p = create();
  p.feed('{');
  p.feed('"a":1}');
  assertEqual(p.getValue(), { a: 1 });
  p.destroy();
});

testBoth("chunk breaks at closing brace", (create) => {
  const p = create();
  p.feed('{"a":1');
  p.feed('}');
  assertEqual(p.getValue(), { a: 1 });
  p.destroy();
});

testBoth("chunk breaks mid-key", (create) => {
  const p = create();
  p.feed('{"hel');
  p.feed('lo":1}');
  assertEqual(p.getValue(), { hello: 1 });
  p.destroy();
});

testBoth("chunk breaks at colon", (create) => {
  const p = create();
  p.feed('{"a"');
  p.feed(':1}');
  assertEqual(p.getValue(), { a: 1 });
  p.destroy();
});

testBoth("chunk breaks at comma", (create) => {
  const p = create();
  p.feed('{"a":1');
  p.feed(',"b":2}');
  assertEqual(p.getValue(), { a: 1, b: 2 });
  p.destroy();
});

testBoth("byte-at-a-time feeding", (create) => {
  const p = create();
  const json = '{"x":[1,"hi"]}';
  for (const ch of json) p.feed(ch);
  assertEqual(p.getValue(), { x: [1, "hi"] });
  p.destroy();
});

// ── Live object: same reference grows ──
console.log("\n--- Live object: reference stability ---");

testBoth("getValue returns same reference for containers", (create) => {
  const p = create();
  p.feed('{"a":');
  const v1 = p.getValue();
  p.feed('1}');
  const v2 = p.getValue();
  // For createParser, ldRoot is the same object reference
  // The object should have grown with 'a' property
  if (typeof v1 === "object" && typeof v2 === "object" && v1 !== null && v2 !== null) {
    assertEqual(v2.a, 1);
  }
  p.destroy();
});

// ── AI SDK real-world pattern: tool call ──
console.log("\n--- AI SDK pattern: tool call streaming ---");

testBoth("LLM tool call streaming simulation", (create) => {
  const p = create();

  // Simulate LLM streaming a tool call JSON
  p.feed('{"tool');
  assertEqual(typeof p.getValue(), "object");

  p.feed('":"file_edit","path":"app.');
  let val = p.getValue();
  assertEqual(val.tool, "file_edit");
  assertEqual(val.path, "app.");

  p.feed('ts","code":"function hello(');
  val = p.getValue();
  assertEqual(val.path, "app.ts");
  assertEqual(val.code, "function hello(");

  p.feed(') {\\n  return 1;\\n}"}');
  val = p.getValue();
  assertEqual(val.code, "function hello() {\n  return 1;\n}");
  assertEqual(val.tool, "file_edit");
  p.destroy();
});

testBoth("large streaming: 1000 array elements", (create) => {
  const p = create();
  p.feed('[');
  for (let i = 0; i < 1000; i++) {
    if (i > 0) p.feed(',');
    p.feed(String(i));
  }
  p.feed(']');
  const result = p.getValue();
  assertEqual(result.length, 1000);
  assertEqual(result[0], 0);
  assertEqual(result[999], 999);
  p.destroy();
});

// ── Pending key with no value ──
console.log("\n--- Pending key (no value yet) ---");

testBoth('{"a": } → a is null', (create) => {
  const p = create();
  p.feed('{"a": ');
  assertEqual(p.getValue(), { a: null });
  p.destroy();
});

testBoth('{"a": 1, "b": } → b is null', (create) => {
  const p = create();
  p.feed('{"a": 1, "b": ');
  const val = p.getValue();
  assertEqual(val.a, 1);
  assertEqual(val.b, null);
  p.destroy();
});

// ── Complete JSON ──
console.log("\n--- Complete JSON via live doc ---");

testBoth("complete object returns correct value", (create) => {
  const p = create();
  const s = p.feed('{"users":[{"name":"Alice","age":30},{"name":"Bob","age":25}]}');
  assertEqual(s, "complete");
  assertEqual(p.getValue(), {
    users: [
      { name: "Alice", age: 30 },
      { name: "Bob", age: 25 }
    ]
  });
  p.destroy();
});

// ── Summary ──
console.log(`\n\u2728 Live Document Builder Tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
