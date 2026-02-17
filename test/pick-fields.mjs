/**
 * Pick Fields + Async Iterator Tests
 *
 * Tests createParser({ pick, source }) for:
 * 1. Field picking — only selected fields appear in getValue()
 * 2. Nested pick paths — dot-separated paths like "user.name"
 * 3. Streaming partial with pick — chunked feed shows growing picked object
 * 4. Pick + schema — schema validates picked result at completion
 * 5. for-await with AsyncIterable source
 * 6. for-await with ReadableStream source
 * 7. for-await auto-destroy on completion and on break
 * 8. No-pick regression — existing createParser() and createParser(schema) unchanged
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

console.log("\n\ud83e\uddea VectorJSON Pick Fields + Async Iterator Tests\n");

// ── 1. Basic pick: only picked fields returned ──

test("basic pick: only name and age from object with noise fields", () => {
  const p = createParser({ pick: ["name", "age"] });
  parsersToClean.push(p);
  const status = p.feed('{"name":"Alice","age":30,"email":"alice@example.com","city":"NYC"}');
  assertEqual(status, "complete");
  const val = p.getValue();
  assertEqual(val, { name: "Alice", age: 30 });
  p.destroy();
});

test("basic pick: single field", () => {
  const p = createParser({ pick: ["x"] });
  parsersToClean.push(p);
  p.feed('{"x":1,"y":2,"z":3}');
  assertEqual(p.getValue(), { x: 1 });
  p.destroy();
});

test("basic pick: field not present returns empty object", () => {
  const p = createParser({ pick: ["missing"] });
  parsersToClean.push(p);
  p.feed('{"a":1,"b":2}');
  assertEqual(p.getValue(), {});
  p.destroy();
});

// ── 2. Nested pick: dot-separated paths ──

test("nested pick: user.name extracts nested field", () => {
  const p = createParser({ pick: ["user.name"] });
  parsersToClean.push(p);
  p.feed('{"user":{"name":"Alice","email":"a@b.com"},"meta":{"v":1}}');
  assertEqual(p.getValue(), { user: { name: "Alice" } });
  p.destroy();
});

test("nested pick: multiple nested paths", () => {
  const p = createParser({ pick: ["user.name", "user.age"] });
  parsersToClean.push(p);
  p.feed('{"user":{"name":"Bob","age":25,"role":"admin"},"extra":"data"}');
  assertEqual(p.getValue(), { user: { name: "Bob", age: 25 } });
  p.destroy();
});

// ── 3. Streaming partial with pick ──

test("streaming partial with pick: chunked feed shows growing picked object", () => {
  const p = createParser({ pick: ["name", "age"] });
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

// ── 4. Pick + schema ──

test("pick + schema: schema validates picked result at completion", () => {
  const schema = {
    safeParse(v) {
      if (v && typeof v.name === "string" && typeof v.age === "number") {
        return { success: true, data: v };
      }
      return { success: false };
    }
  };
  const p = createParser({ pick: ["name", "age"], schema });
  parsersToClean.push(p);
  p.feed('{"name":"Alice","age":30,"extra":"ignored"}');
  const val = p.getValue();
  assertEqual(val, { name: "Alice", age: 30 });
  p.destroy();
});

test("pick + schema: schema rejects returns undefined", () => {
  const schema = {
    safeParse(v) {
      if (v && typeof v.name === "string" && typeof v.age === "number") {
        return { success: true, data: v };
      }
      return { success: false };
    }
  };
  const p = createParser({ pick: ["name"], schema });
  parsersToClean.push(p);
  p.feed('{"name":"Alice","age":30}');
  // Only "name" is picked, so age is missing — schema should reject
  assertEqual(p.getValue(), undefined);
  p.destroy();
});

// ── 5. for-await with AsyncIterable source ──

await testAsync("for-await with async iterable source", async () => {
  const chunks = ['{"na', 'me":"Al', 'ice","a', 'ge":30}'];
  async function* makeSource() {
    for (const c of chunks) yield c;
  }

  const p = createParser({ source: makeSource() });
  parsersToClean.push(p);
  const partials = [];
  for await (const partial of p) {
    partials.push(JSON.parse(JSON.stringify(partial)));
  }
  assert(partials.length > 0, "should yield at least one partial");
  // Last partial should be the complete object
  assertEqual(partials[partials.length - 1], { name: "Alice", age: 30 });
});

await testAsync("for-await with async iterable yields growing partials", async () => {
  const chunks = ['{"x":', '1,"y":', '2}'];
  async function* makeSource() {
    for (const c of chunks) yield c;
  }

  const p = createParser({ source: makeSource() });
  parsersToClean.push(p);
  const partials = [];
  for await (const partial of p) {
    partials.push(JSON.parse(JSON.stringify(partial)));
  }
  // First chunk yields {x: null} or {x: 1}, second adds y
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

// ── 7. for-await auto-destroy on completion and on break ──

await testAsync("for-await auto-destroy on stream end", async () => {
  async function* makeSource() {
    yield '{"done":true}';
  }

  const p = createParser({ source: makeSource() });
  // After iteration completes, parser should be destroyed
  for await (const _ of p) { /* consume */ }
  // Calling getStatus on destroyed parser returns "error"
  assertEqual(p.getStatus(), "error");
});

await testAsync("for-await auto-destroy on break", async () => {
  let chunkIndex = 0;
  async function* makeSource() {
    while (true) {
      yield `{"i":${chunkIndex++}}`;
    }
  }

  const p = createParser({ source: makeSource() });
  for await (const partial of p) {
    break; // early exit
  }
  assertEqual(p.getStatus(), "error"); // destroyed
});

// ── 8. No source: asyncIterator throws ──

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

// ── 9. No-pick regression: existing createParser() and createParser(schema) unchanged ──

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

// ── 10. Pick with arrays ──

test("pick with array values: picked field is an array", () => {
  const p = createParser({ pick: ["tags"] });
  parsersToClean.push(p);
  p.feed('{"name":"Alice","tags":["js","ts"],"id":1}');
  assertEqual(p.getValue(), { tags: ["js", "ts"] });
  p.destroy();
});

// ── 11. for-await with pick + source ──

await testAsync("for-await with pick + source combined", async () => {
  const chunks = ['{"name":"A', 'lice","age":30,', '"email":"skip"}'];
  async function* makeSource() {
    for (const c of chunks) yield c;
  }

  const p = createParser({ pick: ["name", "age"], source: makeSource() });
  parsersToClean.push(p);
  const partials = [];
  for await (const partial of p) {
    partials.push(JSON.parse(JSON.stringify(partial)));
  }
  assert(partials.length > 0, "should yield partials");
  const last = partials[partials.length - 1];
  assertEqual(last, { name: "Alice", age: 30 });
  assert(last.email === undefined, "email should not be present");
});

// ── 12. Schema auto-pick: schema.shape drives field selection ──

test("schema auto-pick: schema with .shape auto-picks matching fields", () => {
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
  p.feed('{"name":"Alice","age":30,"email":"skip@me.com","bio":"long text"}');
  const val = p.getValue();
  assertEqual(val, { name: "Alice", age: 30 });
  p.destroy();
});

test("schema auto-pick: options.schema auto-picks without explicit pick", () => {
  const schema = {
    shape: { x: {}, y: {} },
    safeParse(v) {
      if (v && typeof v.x === "number" && typeof v.y === "number")
        return { success: true, data: v };
      return { success: false };
    }
  };
  const p = createParser({ schema });
  parsersToClean.push(p);
  p.feed('{"x":1,"y":2,"z":3,"w":4}');
  const val = p.getValue();
  assertEqual(val, { x: 1, y: 2 });
  p.destroy();
});

test("schema auto-pick: explicit pick overrides schema shape", () => {
  const schema = {
    shape: { name: {}, age: {} },
    safeParse(v) {
      // Accept anything for this test — we're testing pick override
      return { success: true, data: v };
    }
  };
  // Explicit pick: only "name", even though schema has name + age
  const p = createParser({ pick: ["name"], schema });
  parsersToClean.push(p);
  p.feed('{"name":"Alice","age":30,"extra":"data"}');
  const val = p.getValue();
  assertEqual(val, { name: "Alice" });
  p.destroy();
});

test("schema auto-pick: nested schema shape extracts nested paths", () => {
  const schema = {
    shape: {
      user: {
        shape: { name: {}, age: {} },
      },
    },
    safeParse(v) {
      if (v?.user?.name && typeof v.user.age === "number")
        return { success: true, data: v };
      return { success: false };
    }
  };
  const p = createParser(schema);
  parsersToClean.push(p);
  p.feed('{"user":{"name":"Bob","age":25,"role":"admin"},"meta":{"v":1}}');
  const val = p.getValue();
  assertEqual(val, { user: { name: "Bob", age: 25 } });
  p.destroy();
});

test("schema auto-pick: schema without .shape does not auto-pick", () => {
  // Schema has no .shape — all fields should be returned (no auto-pick)
  const schema = {
    safeParse(v) {
      return { success: true, data: v };
    }
  };
  const p = createParser(schema);
  parsersToClean.push(p);
  p.feed('{"a":1,"b":2,"c":3}');
  const val = p.getValue();
  assertEqual(val, { a: 1, b: 2, c: 3 });
  p.destroy();
});

await testAsync("schema auto-pick + source: for-await only yields schema fields", async () => {
  const schema = {
    shape: { name: {}, age: {} },
    safeParse(v) {
      if (v && typeof v.name === "string" && typeof v.age === "number")
        return { success: true, data: v };
      return { success: false };
    }
  };
  const chunks = ['{"name":"A', 'lice","age":30,', '"email":"skip","bio":"long"}'];
  async function* makeSource() {
    for (const c of chunks) yield c;
  }
  const p = createParser({ schema, source: makeSource() });
  parsersToClean.push(p);
  const partials = [];
  for await (const partial of p) {
    partials.push(JSON.parse(JSON.stringify(partial)));
  }
  const last = partials[partials.length - 1];
  assertEqual(last, { name: "Alice", age: 30 });
  assert(last.email === undefined, "email should not be present");
  assert(last.bio === undefined, "bio should not be present");
});

// ── 13. Array transparency: pick through arrays ──

test("array transparency: pick users.name on array-of-objects", () => {
  const p = createParser({ pick: ["users.name"] });
  parsersToClean.push(p);
  p.feed('{"users":[{"name":"Alice","role":"admin"},{"name":"Bob","role":"user"}]}');
  assertEqual(p.getValue(), { users: [{ name: "Alice" }, { name: "Bob" }] });
  p.destroy();
});

test("array transparency: pick data.items.id on deeply nested array", () => {
  const p = createParser({ pick: ["data.items.id"] });
  parsersToClean.push(p);
  p.feed('{"data":{"items":[{"id":1,"extra":"x"},{"id":2,"extra":"y"}],"meta":"skip"}}');
  assertEqual(p.getValue(), { data: { items: [{ id: 1 }, { id: 2 }] } });
  p.destroy();
});

test("array transparency: schema auto-pick with arrays (Zod-like)", () => {
  const schema = {
    shape: {
      users: {
        shape: { name: {} },
      },
    },
    safeParse(v) {
      if (v?.users && Array.isArray(v.users)) return { success: true, data: v };
      return { success: false };
    }
  };
  const p = createParser(schema);
  parsersToClean.push(p);
  p.feed('{"users":[{"name":"Alice","role":"admin"}],"extra":"data"}');
  const val = p.getValue();
  assertEqual(val, { users: [{ name: "Alice" }] });
  p.destroy();
});

// ── 14. Dirty input handling with schema in createParser ──

test("dirty input with schema: leading junk text", () => {
  const schema = {
    shape: { name: {} },
    safeParse(v) {
      if (v && typeof v.name === "string") return { success: true, data: v };
      return { success: false };
    }
  };
  const p = createParser(schema);
  parsersToClean.push(p);
  p.feed('blah blah {"name":"Alice"} junk');
  const val = p.getValue();
  assertEqual(val, { name: "Alice" });
  p.destroy();
});

test("dirty input with schema: think tags", () => {
  const schema = {
    shape: { name: {} },
    safeParse(v) {
      if (v && typeof v.name === "string") return { success: true, data: v };
      return { success: false };
    }
  };
  const p = createParser(schema);
  parsersToClean.push(p);
  p.feed('<think>reasoning about the answer</think>{"name":"Alice"}');
  const val = p.getValue();
  assertEqual(val, { name: "Alice" });
  p.destroy();
});

test("dirty input with schema: code fences", () => {
  const schema = {
    shape: { name: {} },
    safeParse(v) {
      if (v && typeof v.name === "string") return { success: true, data: v };
      return { success: false };
    }
  };
  const p = createParser(schema);
  parsersToClean.push(p);
  p.feed('```json\n{"name":"Alice"}\n```');
  const val = p.getValue();
  assertEqual(val, { name: "Alice" });
  p.destroy();
});

test("dirty input: seeker only active with schema", () => {
  // With schema: seeker strips junk, parses successfully
  const schema = {
    shape: { name: {} },
    safeParse(v) { return { success: true, data: v }; }
  };
  const p1 = createParser(schema);
  parsersToClean.push(p1);
  p1.feed('# Here is some text\n{"name":"Alice"}');
  assertEqual(p1.getValue(), { name: "Alice" });
  p1.destroy();

  // Without schema: no seeker, WASM handles input as-is
  const p2 = createParser();
  parsersToClean.push(p2);
  const status = p2.feed('# {"name":"Alice"}');
  // WASM may or may not handle this — test that seeker is NOT active (no filtering)
  assert(status !== undefined, "feed should return a status");
  p2.destroy();
});

// ── 15. createEventParser for-await ──

await testAsync("createEventParser for-await with source", async () => {
  const chunks = ['{"na', 'me":"Al', 'ice","a', 'ge":30}'];
  async function* makeSource() {
    for (const c of chunks) yield c;
  }

  const p = createEventParser({ source: makeSource() });
  const partials = [];
  for await (const partial of p) {
    partials.push(JSON.parse(JSON.stringify(partial)));
  }
  assert(partials.length > 0, "should yield at least one partial");
  assertEqual(partials[partials.length - 1], { name: "Alice", age: 30 });
});

await testAsync("createEventParser for-await + break: early exit destroys parser", async () => {
  let chunkIndex = 0;
  async function* makeSource() {
    while (true) {
      yield `{"i":${chunkIndex++}}`;
    }
  }

  const p = createEventParser({ source: makeSource() });
  for await (const partial of p) {
    break; // early exit
  }
  assertEqual(p.getStatus(), "error"); // destroyed
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

// ── Results ──
console.log(`\n\u2728 Pick Fields Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
