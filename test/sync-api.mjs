/**
 * Tests: Sync API — verifies top-level await exports work without init().
 *
 * Covers: parse, parsePartialJson, deepCompare, createParser,
 * createEventParser, materialize all work as direct synchronous imports.
 * Also verifies backward compat: `await init()` still returns cached instance.
 */
import {
  parse,
  parsePartialJson,
  deepCompare,
  createParser,
  createEventParser,
  materialize,
  init,
} from "../dist/index.js";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.error(`  ❌ ${name}: ${err.message}`); }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "Assertion failed");
}

console.log("\n🧪 VectorJSON — Sync API Tests\n");

// --- parse() is synchronous ---
test("parse() returns ParseResult, not a Promise", () => {
  const result = parse('{"a":1}');
  // If parse returned a Promise, result.status would be undefined
  assert(result.status === "complete", `expected complete, got ${result.status}`);
  assert(result.value.a === 1, "value.a should be 1");
});

test("parse() handles primitives", () => {
  assert(parse("42").value === 42, "number");
  assert(parse('"hello"').value === "hello", "string");
  assert(parse("true").value === true, "boolean");
  assert(parse("null").value === null, "null");
});

test("parse() handles arrays", () => {
  const result = parse("[1,2,3]");
  assert(result.status === "complete");
  assert(result.value.length === 3);
  assert(result.value[2] === 3);
});

test("parse() handles incomplete JSON", () => {
  const result = parse('{"a": 1, "b": ');
  assert(result.status === "incomplete", `expected incomplete, got ${result.status}`);
});

// --- parsePartialJson() is synchronous ---
test("parsePartialJson() returns PartialJsonResult, not a Promise", () => {
  const result = parsePartialJson('{"a": 1, "b": ');
  assert(typeof result.state === "string", "should have state property");
  assert(result.state === "repaired-parse", `expected repaired-parse, got ${result.state}`);
  assert(result.value !== undefined, "should have a value");
});

test("parsePartialJson() successful parse", () => {
  const result = parsePartialJson('{"a":1}');
  assert(result.state === "successful-parse");
  assert(result.value.a === 1);
});

// --- deepCompare() is synchronous ---
test("deepCompare() works as sync export", () => {
  const a = parse('{"x":1,"y":2}');
  const b = parse('{"y":2,"x":1}');
  assert(deepCompare(a.value, b.value) === true, "should be equal regardless of key order");
});

test("deepCompare() detects differences", () => {
  const a = parse('{"x":1}');
  const b = parse('{"x":2}');
  assert(deepCompare(a.value, b.value) === false, "should detect difference");
});

// --- createParser() is synchronous ---
test("createParser() works as sync export", () => {
  const parser = createParser();
  assert(typeof parser.feed === "function", "should have feed method");
  const status = parser.feed('{"hello":"world"}');
  assert(status === "complete", `expected complete, got ${status}`);
  const value = parser.getValue();
  assert(value.hello === "world");
  parser.destroy();
});

// --- createEventParser() is synchronous ---
test("createEventParser() works as sync export", () => {
  const parser = createEventParser();
  assert(typeof parser.feed === "function", "should have feed method");
  assert(typeof parser.on === "function", "should have on method");
  let captured = null;
  parser.on("name", (e) => { captured = e.value; });
  parser.feed('{"name":"test"}');
  assert(captured === "test", `expected 'test', got ${captured}`);
  parser.destroy();
});

// --- materialize() is synchronous ---
test("materialize() works as sync export", () => {
  const result = parse('{"a":{"b":1}}');
  const plain = materialize(result.value);
  assert(JSON.stringify(plain) === '{"a":{"b":1}}');
});

// --- Backward compat: init() still works ---
test("await init() returns cached instance", async () => {
  const vj = await init();
  assert(typeof vj.parse === "function", "should have parse method");
  const result = vj.parse('{"z":99}');
  assert(result.value.z === 99);
});

console.log(`\n✨ Sync API Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
