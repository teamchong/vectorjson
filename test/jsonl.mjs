/**
 * JSONL (newline-delimited JSON) tests.
 * Tests format: "jsonl" on both createParser and createEventParser.
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

console.log("\n🧪 VectorJSON JSONL Tests\n");

// --- createParser + JSONL ---

await test("jsonl: push-based feed + resetForNext", () => {
  const p = createParser({ format: "jsonl" });
  const status = p.feed('{"a":1}\n{"b":2}');
  assertEqual(status, "end_early");
  assertEqual(p.getValue(), { a: 1 });
  p.resetForNext();
  assertEqual(p.getStatus(), "complete");
  assertEqual(p.getValue(), { b: 2 });
  p.destroy();
});

await test("jsonl: multiple values separated by newlines", () => {
  const p = createParser({ format: "jsonl" });
  p.feed('{"a":1}\n{"b":2}\n{"c":3}');
  assertEqual(p.getValue(), { a: 1 });
  p.resetForNext();
  assertEqual(p.getValue(), { b: 2 });
  p.resetForNext();
  assertEqual(p.getValue(), { c: 3 });
  p.destroy();
});

await test("jsonl: empty lines between values", () => {
  const p = createParser({ format: "jsonl" });
  p.feed('{"a":1}\n\n\n{"b":2}');
  assertEqual(p.getValue(), { a: 1 });
  p.resetForNext();
  assertEqual(p.getValue(), { b: 2 });
  p.destroy();
});

await test("jsonl: CRLF line endings", () => {
  const p = createParser({ format: "jsonl" });
  p.feed('{"a":1}\r\n{"b":2}');
  assertEqual(p.getValue(), { a: 1 });
  p.resetForNext();
  assertEqual(p.getValue(), { b: 2 });
  p.destroy();
});

await test("jsonl: trailing newline", () => {
  const p = createParser({ format: "jsonl" });
  const status = p.feed('{"a":1}\n');
  assertEqual(status, "complete");
  assertEqual(p.getValue(), { a: 1 });
  p.destroy();
});

await test("jsonl: mixed value types", () => {
  const p = createParser({ format: "jsonl" });
  p.feed('42\n"hello"\n[1,2,3]\nnull\ntrue');
  assertEqual(p.getValue(), 42);
  p.resetForNext();
  assertEqual(p.getValue(), "hello");
  p.resetForNext();
  assertEqual(p.getValue(), [1, 2, 3]);
  p.resetForNext();
  assertEqual(p.getValue(), null);
  p.resetForNext();
  assertEqual(p.getValue(), true);
  p.destroy();
});

await test("jsonl: values split across chunks", () => {
  const p = createParser({ format: "jsonl" });
  assertEqual(p.feed('{"a":'), "incomplete");
  assertEqual(p.feed('1}\n{"b":2}'), "end_early");
  assertEqual(p.getValue(), { a: 1 });
  p.resetForNext();
  assertEqual(p.getValue(), { b: 2 });
  p.destroy();
});

await test("jsonl: for-await yields each value", async () => {
  async function* chunks() {
    yield '{"a":1}\n{"b":2}\n';
    yield '{"c":3}\n';
  }
  const values = [];
  const p = createParser({ format: "jsonl", source: chunks() });
  for await (const v of p) {
    values.push(JSON.parse(JSON.stringify(v)));
  }
  assertEqual(values, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

await test("jsonl: for-await with values split across chunks", async () => {
  async function* chunks() {
    yield '{"a":';
    yield '1}\n{"b":2}';
  }
  const values = [];
  const p = createParser({ format: "jsonl", source: chunks() });
  for await (const v of p) {
    if (v !== undefined) values.push(JSON.parse(JSON.stringify(v)));
  }
  // Should get {a:1} from first complete value, {b:2} from second
  assert(values.some(v => v.a === 1), "Should contain {a:1}");
  assert(values.some(v => v.b === 2), "Should contain {b:2}");
});

await test("jsonl: schema + jsonl combined", () => {
  const schema = {
    safeParse(v) {
      if (v && typeof v === 'object' && 'name' in v) return { success: true, data: v };
      return { success: false };
    },
    shape: { name: {} },
  };
  const p = createParser({ format: "jsonl", schema });
  p.feed('{"name":"Alice","extra":1}\n{"name":"Bob","extra":2}');
  const v1 = p.getValue();
  assertEqual(v1, { name: "Alice" });
  p.resetForNext();
  const v2 = p.getValue();
  assertEqual(v2, { name: "Bob" });
  p.destroy();
});

// --- createEventParser + JSONL ---

await test("jsonl: eventParser for-await yields each value", async () => {
  async function* chunks() {
    yield '{"a":1}\n{"b":2}\n{"c":3}\n';
  }
  const values = [];
  const ep = createEventParser({ format: "jsonl", source: chunks() });
  for await (const v of ep) {
    if (v !== undefined) values.push(JSON.parse(JSON.stringify(v)));
  }
  assertEqual(values, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

await test("jsonl: eventParser push-based with on() callbacks", () => {
  const ep = createEventParser({ format: "jsonl" });
  const names = [];
  ep.on("name", (e) => names.push(e.value));
  ep.feed('{"name":"Alice"}\n{"name":"Bob"}');
  assert(names.includes("Alice"), "Should fire callback for Alice");
  ep.destroy();
});

// --- Edge cases ---

await test("jsonl: single value (degenerates to normal JSON)", () => {
  const p = createParser({ format: "jsonl" });
  const status = p.feed('42');
  assertEqual(status, "complete");
  assertEqual(p.getValue(), 42);
  p.destroy();
});

await test("jsonl: resetForNext when incomplete returns 0", () => {
  const p = createParser({ format: "jsonl" });
  p.feed('{"a":');
  const remain = p.resetForNext();
  assertEqual(remain, 0);
  assertEqual(p.getStatus(), "incomplete");
  p.destroy();
});

await test("jsonl: incomplete then complete with second value in same chunk", () => {
  const p = createParser({ format: "jsonl" });
  assertEqual(p.feed('{"a":'), "incomplete");
  assertEqual(p.feed('1}\n{"b":'), "end_early");
  assertEqual(p.getValue(), { a: 1 });
  p.resetForNext();
  // {"b": is incomplete
  assertEqual(p.getStatus(), "incomplete");
  assertEqual(p.feed('2}'), "complete");
  assertEqual(p.getValue(), { b: 2 });
  p.destroy();
});

await test("jsonl: deeply nested objects", () => {
  const p = createParser({ format: "jsonl" });
  p.feed('{"a":{"b":{"c":1}}}\n{"d":{"e":{"f":2}}}');
  assertEqual(p.getValue(), { a: { b: { c: 1 } } });
  p.resetForNext();
  assertEqual(p.getValue(), { d: { e: { f: 2 } } });
  p.destroy();
});

await test("jsonl: tabs and spaces between values", () => {
  const p = createParser({ format: "jsonl" });
  p.feed('{"a":1}\t \n  \t\n{"b":2}');
  assertEqual(p.getValue(), { a: 1 });
  p.resetForNext();
  assertEqual(p.getValue(), { b: 2 });
  p.destroy();
});

await test("jsonl: for-await with many values across many chunks", async () => {
  async function* chunks() {
    for (let i = 0; i < 20; i++) {
      yield JSON.stringify({ i }) + "\n";
    }
  }
  const values = [];
  const p = createParser({ format: "jsonl", source: chunks() });
  for await (const v of p) {
    if (v !== undefined) values.push(JSON.parse(JSON.stringify(v)));
  }
  assertEqual(values.length, 20);
  assertEqual(values[0], { i: 0 });
  assertEqual(values[19], { i: 19 });
});

await test("jsonl: eventParser for-await with values split across chunks", async () => {
  async function* chunks() {
    yield '{"x":';
    yield '1}\n{"y":2}\n';
  }
  const values = [];
  const ep = createEventParser({ format: "jsonl", source: chunks() });
  for await (const v of ep) {
    if (v !== undefined) values.push(JSON.parse(JSON.stringify(v)));
  }
  assert(values.some(v => v.x === 1), "Should contain {x:1}");
  assert(values.some(v => v.y === 2), "Should contain {y:2}");
});

await test("jsonl: eventParser on() fires for each value", () => {
  const ep = createEventParser({ format: "jsonl" });
  const vals = [];
  ep.on("v", (e) => vals.push(e.value));
  ep.feed('{"v":1}\n{"v":2}\n{"v":3}');
  assert(vals.includes(1), "Should fire for v=1");
  ep.destroy();
});

await test("jsonl: boolean and null values", () => {
  const p = createParser({ format: "jsonl" });
  p.feed('true\nfalse\nnull');
  assertEqual(p.getValue(), true);
  p.resetForNext();
  assertEqual(p.getValue(), false);
  p.resetForNext();
  assertEqual(p.getValue(), null);
  p.destroy();
});

await test("jsonl: string values with newlines inside", () => {
  const p = createParser({ format: "jsonl" });
  // The \n inside the string is escaped, so it's not a line break
  p.feed('{"msg":"line1\\nline2"}\n{"msg":"ok"}');
  assertEqual(p.getValue(), { msg: "line1\nline2" });
  p.resetForNext();
  assertEqual(p.getValue(), { msg: "ok" });
  p.destroy();
});

console.log(`\n✨ JSONL Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
