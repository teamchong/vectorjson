/**
 * Schema + Async Iterator Tests
 *
 * Tests createParser and createEventParser with:
 * 1. Schema-driven field selection — only schema fields appear in getValue()
 * 2. Nested schema shapes — extracts nested paths
 * 3. Streaming partial with schema — chunked feed shows growing schema-filtered object
 * 4. Schema validation — safeParse on complete
 * 5. for-await with AsyncIterable source
 * 6. for-await with ReadableStream source
 * 7. for-await auto-destroy on completion and on break
 * 8. Array transparency — schema picks through arrays
 * 9. createEventParser schema + for-await
 */

import { createParser, createEventParser } from "../dist/index.js";

let passed = 0, failed = 0;
const parsersToClean = [];

function test(name, fn) {
  try { fn(); passed++; console.log(`  \u2705 ${name}`); }
  catch (err) { failed++; console.error(`  \u274c ${name}: ${err.message}`); }
  finally {
    for (const p of parsersToClean) { try { p.destroy(); } catch {} }
    parsersToClean.length = 0;
  }
}

async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  \u2705 ${name}`); }
  catch (err) { failed++; console.error(`  \u274c ${name}: ${err.message}`); }
  finally {
    for (const p of parsersToClean) { try { p.destroy(); } catch {} }
    parsersToClean.length = 0;
  }
}

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(msg || `Expected ${e}, got ${a}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion failed");
}

// Helper: create a schema with .shape and .safeParse
function makeSchema(shape, validate) {
  return {
    shape,
    safeParse: validate || ((v) => ({ success: true, data: v })),
  };
}

console.log("\n\ud83e\uddea VectorJSON Schema + Async Iterator Tests\n");

// ── 1. Schema-driven field selection ──

test("schema: only schema fields returned", () => {
  const p = createParser(makeSchema({ name: {}, age: {} }));
  parsersToClean.push(p);
  p.feed('{"name":"Alice","age":30,"email":"alice@example.com","city":"NYC"}');
  assertEqual(p.getValue(), { name: "Alice", age: 30 });
  p.destroy();
});

test("schema: single field", () => {
  const p = createParser(makeSchema({ x: {} }));
  parsersToClean.push(p);
  p.feed('{"x":1,"y":2,"z":3}');
  assertEqual(p.getValue(), { x: 1 });
  p.destroy();
});

test("schema: field not present returns empty object", () => {
  const p = createParser(makeSchema({ missing: {} }));
  parsersToClean.push(p);
  p.feed('{"a":1,"b":2}');
  assertEqual(p.getValue(), {});
  p.destroy();
});

// ── 2. Nested schema shapes ──

test("schema: nested shape extracts nested field", () => {
  const p = createParser(makeSchema({ user: { shape: { name: {} } } }));
  parsersToClean.push(p);
  p.feed('{"user":{"name":"Alice","email":"a@b.com"},"meta":{"v":1}}');
  assertEqual(p.getValue(), { user: { name: "Alice" } });
  p.destroy();
});

test("schema: multiple nested fields", () => {
  const p = createParser(makeSchema({ user: { shape: { name: {}, age: {} } } }));
  parsersToClean.push(p);
  p.feed('{"user":{"name":"Bob","age":25,"role":"admin"},"extra":"data"}');
  assertEqual(p.getValue(), { user: { name: "Bob", age: 25 } });
  p.destroy();
});

// ── 3. Streaming partial with schema ──

test("schema: chunked feed shows growing schema-filtered object", () => {
  const p = createParser(makeSchema({ name: {}, age: {} }));
  parsersToClean.push(p);

  p.feed('{"name":"Al');
  let val = p.getValue();
  assert(val.name !== undefined, "name should be partially available");

  p.feed('ice","email":"skip@me.com","age":');
  val = p.getValue();
  assertEqual(val.name, "Alice");
  assert(val.email === undefined, "email should not be present");

  p.feed('30}');
  val = p.getValue();
  assertEqual(val, { name: "Alice", age: 30 });
  p.destroy();
});

// ── 4. Schema validation ──

test("schema: validates on complete", () => {
  const schema = {
    shape: { name: {}, age: {} },
    safeParse(v) {
      if (v && typeof v.name === "string" && typeof v.age === "number")
        return { success: true, data: v };
      return { success: false };
    }
  };
  const p = createParser(schema);
  parsersToClean.push(p);
  p.feed('{"name":"Alice","age":30,"extra":"ignored"}');
  assertEqual(p.getValue(), { name: "Alice", age: 30 });
  p.destroy();
});

test("schema: rejects invalid returns undefined", () => {
  const schema = {
    shape: { name: {} },
    safeParse(v) {
      if (v && typeof v.name === "string" && typeof v.age === "number")
        return { success: true, data: v };
      return { success: false };
    }
  };
  const p = createParser(schema);
  parsersToClean.push(p);
  p.feed('{"name":"Alice","age":30}');
  // Schema shape only has "name", so age is not parsed — validation fails
  assertEqual(p.getValue(), undefined);
  p.destroy();
});

test("schema: without .shape does not filter fields", () => {
  const schema = { safeParse(v) { return { success: true, data: v }; } };
  const p = createParser(schema);
  parsersToClean.push(p);
  p.feed('{"a":1,"b":2,"c":3}');
  assertEqual(p.getValue(), { a: 1, b: 2, c: 3 });
  p.destroy();
});

// ── 5. for-await with AsyncIterable source ──

await testAsync("for-await with async iterable source", async () => {
  const chunks = ['{"na', 'me":"Al', 'ice","a', 'ge":30}'];
  async function* makeSource() { for (const c of chunks) yield c; }

  const p = createParser({ source: makeSource() });
  parsersToClean.push(p);
  const partials = [];
  for await (const partial of p) {
    partials.push(JSON.parse(JSON.stringify(partial)));
  }
  assert(partials.length > 0, "should yield at least one partial");
  assertEqual(partials[partials.length - 1], { name: "Alice", age: 30 });
});

await testAsync("for-await with async iterable yields growing partials", async () => {
  const chunks = ['{"x":', '1,"y":', '2}'];
  async function* makeSource() { for (const c of chunks) yield c; }

  const p = createParser({ source: makeSource() });
  parsersToClean.push(p);
  const partials = [];
  for await (const partial of p) {
    partials.push(JSON.parse(JSON.stringify(partial)));
  }
  assert(partials.length >= 2, `expected >= 2 partials, got ${partials.length}`);
  assertEqual(partials[partials.length - 1], { x: 1, y: 2 });
});

// ── 6. for-await with ReadableStream source ──

await testAsync("for-await with ReadableStream source", async () => {
  const encoder = new TextEncoder();
  const chunks = ['{"msg":', '"hello"}'];
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    }
  });

  const p = createParser({ source: stream });
  parsersToClean.push(p);
  const partials = [];
  for await (const partial of p) {
    partials.push(JSON.parse(JSON.stringify(partial)));
  }
  assert(partials.length > 0, "should yield at least one partial");
  assertEqual(partials[partials.length - 1], { msg: "hello" });
});

// ── 7. for-await auto-destroy ──

await testAsync("for-await auto-destroy on stream end", async () => {
  async function* makeSource() { yield '{"done":true}'; }
  const p = createParser({ source: makeSource() });
  for await (const _ of p) { /* consume */ }
  assertEqual(p.getStatus(), "error");
});

await testAsync("for-await auto-destroy on break", async () => {
  let i = 0;
  async function* makeSource() { while (true) yield `{"i":${i++}}`; }
  const p = createParser({ source: makeSource() });
  for await (const partial of p) { break; }
  assertEqual(p.getStatus(), "error");
});

test("no source: Symbol.asyncIterator throws", () => {
  const p = createParser();
  parsersToClean.push(p);
  try {
    p[Symbol.asyncIterator]();
    throw new Error("should have thrown");
  } catch (e) {
    assert(e.message.includes("No source"), `expected 'No source' error, got: ${e.message}`);
  }
  p.destroy();
});

// ── 8. Regression: no schema ──

test("regression: createParser() with no args works as before", () => {
  const p = createParser();
  parsersToClean.push(p);
  p.feed('{"a":1,"b":"hello"}');
  assertEqual(p.getValue(), { a: 1, b: "hello" });
  p.destroy();
});

test("regression: createParser(schema) with zod-like schema works", () => {
  const schema = {
    safeParse(v) {
      if (v && typeof v.a === "number") return { success: true, data: v };
      return { success: false };
    }
  };
  const p = createParser(schema);
  parsersToClean.push(p);
  p.feed('{"a":42}');
  assertEqual(p.getValue(), { a: 42 });
  p.destroy();
});

test("regression: createParser(schema) rejects invalid", () => {
  const schema = {
    safeParse(v) {
      if (v && typeof v.a === "number") return { success: true, data: v };
      return { success: false };
    }
  };
  const p = createParser(schema);
  parsersToClean.push(p);
  p.feed('{"a":"not a number"}');
  assertEqual(p.getValue(), undefined);
  p.destroy();
});

// ── 9. Array transparency ──

test("schema: array transparency on array-of-objects", () => {
  const p = createParser(makeSchema({ users: { shape: { name: {} } } }));
  parsersToClean.push(p);
  p.feed('{"users":[{"name":"Alice","role":"admin"},{"name":"Bob","role":"user"}]}');
  assertEqual(p.getValue(), { users: [{ name: "Alice" }, { name: "Bob" }] });
  p.destroy();
});

test("schema: deeply nested array transparency", () => {
  const p = createParser(makeSchema({ data: { shape: { items: { shape: { id: {} } } } } }));
  parsersToClean.push(p);
  p.feed('{"data":{"items":[{"id":1,"extra":"x"},{"id":2,"extra":"y"}],"meta":"skip"}}');
  assertEqual(p.getValue(), { data: { items: [{ id: 1 }, { id: 2 }] } });
  p.destroy();
});

test("schema: array values kept when field is an array", () => {
  const p = createParser(makeSchema({ tags: {} }));
  parsersToClean.push(p);
  p.feed('{"name":"Alice","tags":["js","ts"],"id":1}');
  assertEqual(p.getValue(), { tags: ["js", "ts"] });
  p.destroy();
});

// ── 10. Schema + source combined ──

await testAsync("schema + source: for-await only yields schema fields", async () => {
  const schema = makeSchema({ name: {}, age: {} }, (v) => {
    if (v && typeof v.name === "string" && typeof v.age === "number")
      return { success: true, data: v };
    return { success: false };
  });
  const chunks = ['{"name":"A', 'lice","age":30,', '"email":"skip","bio":"long"}'];
  async function* makeSource() { for (const c of chunks) yield c; }
  const p = createParser({ schema, source: makeSource() });
  parsersToClean.push(p);
  const partials = [];
  for await (const partial of p) {
    partials.push(JSON.parse(JSON.stringify(partial)));
  }
  const last = partials[partials.length - 1];
  assertEqual(last, { name: "Alice", age: 30 });
  assert(last.email === undefined, "email should not be present");
});

// ── 11. createEventParser for-await ──

await testAsync("createEventParser for-await with source", async () => {
  const chunks = ['{"na', 'me":"Al', 'ice","a', 'ge":30}'];
  async function* makeSource() { for (const c of chunks) yield c; }
  const p = createEventParser({ source: makeSource() });
  const partials = [];
  for await (const partial of p) {
    partials.push(JSON.parse(JSON.stringify(partial)));
  }
  assert(partials.length > 0, "should yield at least one partial");
  assertEqual(partials[partials.length - 1], { name: "Alice", age: 30 });
});

await testAsync("createEventParser for-await + break: early exit destroys parser", async () => {
  let i = 0;
  async function* makeSource() { while (true) yield `{"i":${i++}}`; }
  const p = createEventParser({ source: makeSource() });
  for await (const partial of p) { break; }
  assertEqual(p.getStatus(), "error");
});

await testAsync("createEventParser for-await with ReadableStream source", async () => {
  const encoder = new TextEncoder();
  const chunks = ['{"msg":', '"hello"}'];
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    }
  });
  const p = createEventParser({ source: stream });
  const partials = [];
  for await (const partial of p) {
    partials.push(JSON.parse(JSON.stringify(partial)));
  }
  assert(partials.length > 0, "should yield at least one partial");
  assertEqual(partials[partials.length - 1], { msg: "hello" });
});

await testAsync("createEventParser no source: asyncIterator throws", async () => {
  const p = createEventParser();
  try {
    p[Symbol.asyncIterator]();
    throw new Error("should have thrown");
  } catch (e) {
    assert(e.message.includes("No source"), `expected 'No source' error, got: ${e.message}`);
  }
  p.destroy();
});

// ── 12. createEventParser schema ──

test("createEventParser schema: only schema fields in getValue()", () => {
  const p = createEventParser({ schema: makeSchema({ name: {}, age: {} }) });
  parsersToClean.push(p);
  p.feed('{"name":"Alice","age":30,"email":"skip@me.com","bio":"long text"}');
  assertEqual(p.getValue(), { name: "Alice", age: 30 });
  p.destroy();
});

test("createEventParser schema: array transparency", () => {
  const p = createEventParser({ schema: makeSchema({ users: { shape: { name: {} } } }) });
  parsersToClean.push(p);
  p.feed('{"users":[{"name":"Alice","role":"admin"},{"name":"Bob","role":"user"}],"extra":"data"}');
  assertEqual(p.getValue(), { users: [{ name: "Alice" }, { name: "Bob" }] });
  p.destroy();
});

test("createEventParser schema: nested fields", () => {
  const p = createEventParser({ schema: makeSchema({ user: { shape: { name: {}, age: {} } } }) });
  parsersToClean.push(p);
  p.feed('{"user":{"name":"Bob","age":25,"role":"admin"},"meta":{"v":1}}');
  assertEqual(p.getValue(), { user: { name: "Bob", age: 25 } });
  p.destroy();
});

test("createEventParser schema: events still fire for schema fields", () => {
  const p = createEventParser({ schema: makeSchema({ name: {}, age: {} }) });
  parsersToClean.push(p);
  const values = [];
  p.on('name', (e) => values.push(e.value));
  p.feed('{"name":"Alice","age":30,"email":"skip"}');
  assertEqual(values, ["Alice"]);
  p.destroy();
});

await testAsync("createEventParser schema + source: for-await only yields schema fields", async () => {
  const chunks = ['{"name":"A', 'lice","age":30,', '"email":"skip","bio":"long"}'];
  async function* makeSource() { for (const c of chunks) yield c; }
  const p = createEventParser({ schema: makeSchema({ name: {}, age: {} }), source: makeSource() });
  parsersToClean.push(p);
  const partials = [];
  for await (const partial of p) {
    partials.push(JSON.parse(JSON.stringify(partial)));
  }
  const last = partials[partials.length - 1];
  assertEqual(last, { name: "Alice", age: 30 });
  assert(last.email === undefined, "email should not be present");
});

// ── 13. createEventParser schema validation ──

test("createEventParser schema: validates on complete, returns data", () => {
  const p = createEventParser({ schema: {
    shape: { name: {}, age: {} },
    safeParse(v) {
      if (v && typeof v.name === "string" && typeof v.age === "number")
        return { success: true, data: { ...v, validated: true } };
      return { success: false };
    }
  }});
  parsersToClean.push(p);
  p.feed('{"name":"Alice","age":30,"extra":"skip"}');
  const val = p.getValue();
  assertEqual(val.name, "Alice");
  assertEqual(val.age, 30);
  assertEqual(val.validated, true);
  p.destroy();
});

test("createEventParser schema: rejects invalid returns undefined", () => {
  const p = createEventParser({ schema: {
    shape: { name: {}, age: {} },
    safeParse(v) {
      if (v && typeof v.name === "string" && typeof v.age === "number")
        return { success: true, data: v };
      return { success: false };
    }
  }});
  parsersToClean.push(p);
  p.feed('{"name":"Alice","extra":"data"}');
  assertEqual(p.getValue(), undefined);
  p.destroy();
});

// ── Results ──
console.log(`\n\u2728 Schema + Async Iterator Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
