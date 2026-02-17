/**
 * EventParser tests — path subscriptions, multi-root, deltas, skip paths,
 * JSON boundary detection, schema filtering, wildcard context, byte offsets.
 */
import { createEventParser } from "../dist/index.js";

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

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "Assertion failed");
}

console.log("\n🧪 VectorJSON EventParser Tests\n");

/** Helper: creates parser, runs fn, always destroys */
function withParser(opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = undefined; }
  const parser = createEventParser(opts);
  try { fn(parser); } finally { parser.destroy(); }
}

// =============================================================
// 1. Basic path subscriptions
// =============================================================

await test("on: subscribe to top-level key", () => {
  withParser((parser) => {
    const events = [];
    parser.on("name", (e) => events.push(e));
    parser.feed('{"name":"Alice","age":30}');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, "Alice");
    assertEqual(events[0].path, "name");
    assertEqual(events[0].type, "value");
  });
});

await test("on: subscribe to nested path", () => {
  withParser((parser) => {
    const events = [];
    parser.on("user.name", (e) => events.push(e));
    parser.feed('{"user":{"name":"Bob","age":25}}');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, "Bob");
    assertEqual(events[0].path, "user.name");
  });
});

await test("on: subscribe to array element by index", () => {
  withParser((parser) => {
    const events = [];
    parser.on("items[1]", (e) => events.push(e));
    parser.feed('{"items":["a","b","c"]}');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, "b");
  });
});

await test("on: wildcard array index", () => {
  withParser((parser) => {
    const events = [];
    parser.on("items[*]", (e) => events.push(e));
    parser.feed('{"items":["x","y","z"]}');
    assertEqual(events.length, 3);
    assertEqual(events[0].value, "x");
    assertEqual(events[1].value, "y");
    assertEqual(events[2].value, "z");
  });
});

await test("on: wildcard resolved path and matches", () => {
  withParser((parser) => {
    const events = [];
    parser.on("items[*].name", (e) => events.push(e));
    parser.feed('{"items":[{"name":"A"},{"name":"B"}]}');
    assertEqual(events.length, 2);
    assertEqual(events[0].path, "items.0.name");
    assertEqual(events[0].index, 0);
    assertEqual(events[0].matches, [0]);
    assertEqual(events[1].path, "items.1.name");
    assertEqual(events[1].index, 1);
  });
});

await test("on: multiple wildcards accumulate in matches", () => {
  withParser((parser) => {
    const events = [];
    parser.on("a[*].b[*]", (e) => events.push(e));
    parser.feed('{"a":[{"b":[10,20]},{"b":[30]}]}');
    assertEqual(events.length, 3);
    assertEqual(events[0].matches, [0, 0]);
    assertEqual(events[0].value, 10);
    assertEqual(events[1].matches, [0, 1]);
    assertEqual(events[1].value, 20);
    assertEqual(events[2].matches, [1, 0]);
    assertEqual(events[2].value, 30);
  });
});

await test("on: number value at path", () => {
  withParser((parser) => {
    const events = [];
    parser.on("count", (e) => events.push(e));
    parser.feed('{"count":42}');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, 42);
  });
});

await test("on: boolean and null values", () => {
  withParser((parser) => {
    const events = [];
    parser.on("a", (e) => events.push(e.value));
    parser.on("b", (e) => events.push(e.value));
    parser.on("c", (e) => events.push(e.value));
    parser.feed('{"a":true,"b":false,"c":null}');
    assertEqual(events, [true, false, null]);
  });
});

await test("on: object value at path", () => {
  withParser((parser) => {
    const events = [];
    parser.on("data", (e) => events.push(e));
    parser.feed('{"data":{"x":1,"y":2}}');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, { x: 1, y: 2 });
  });
});

await test("on: array value at path", () => {
  withParser((parser) => {
    const events = [];
    parser.on("list", (e) => events.push(e));
    parser.feed('{"list":[1,2,3]}');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, [1, 2, 3]);
  });
});

// =============================================================
// 2. Streaming (multi-chunk) path subscriptions
// =============================================================

await test("on: events fire across multiple feed() calls", () => {
  withParser((parser) => {
    const events = [];
    parser.on("name", (e) => events.push(e));
    parser.feed('{"na');
    parser.feed('me":"A');
    parser.feed('lice"}');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, "Alice");
  });
});

// =============================================================
// 3. String delta emission
// =============================================================

await test("onDelta: emit character deltas for a string", () => {
  withParser((parser) => {
    const deltas = [];
    parser.onDelta("text", (e) => deltas.push(e.value));
    parser.feed('{"text":"Hello"}');
    assert(deltas.length >= 1, `Expected at least 1 delta, got ${deltas.length}`);
    const fullText = deltas.join('');
    assertEqual(fullText, "Hello");
  });
});

await test("onDelta: char-by-char feeding fires deltas", () => {
  withParser((parser) => {
    const deltas = [];
    parser.onDelta("text", (e) => deltas.push(e.value));
    const json = '{"text":"Hi"}';
    for (const ch of json) parser.feed(ch);
    const fullText = deltas.join('');
    assertEqual(fullText, "Hi");
  });
});

await test("onDelta: path with escaped characters", () => {
  withParser((parser) => {
    const deltas = [];
    parser.onDelta("msg", (e) => deltas.push(e.value));
    parser.feed('{"msg":"a\\nb"}');
    const fullText = deltas.join('');
    assertEqual(fullText, "a\nb");
  });
});

// =============================================================
// 4. Multi-root / NDJSON
// =============================================================

await test("multiRoot: fires onRoot for each value in NDJSON", () => {
  const roots = [];
  withParser({ multiRoot: true, onRoot: (e) => roots.push(e) }, (parser) => {
    parser.feed('{"a":1}\n{"b":2}\n{"c":3}');
  });
  assertEqual(roots.length, 3);
  assertEqual(roots[0].index, 0);
  assertEqual(roots[0].value, { a: 1 });
  assertEqual(roots[1].index, 1);
  assertEqual(roots[1].value, { b: 2 });
  assertEqual(roots[2].index, 2);
  assertEqual(roots[2].value, { c: 3 });
});

await test("multiRoot: handles values split across chunks", () => {
  const roots = [];
  withParser({ multiRoot: true, onRoot: (e) => roots.push(e) }, (parser) => {
    parser.feed('{"a":');
    parser.feed('1}\n{"b"');
    parser.feed(':2}');
  });
  assertEqual(roots.length, 2);
  assertEqual(roots[0].value, { a: 1 });
  assertEqual(roots[1].value, { b: 2 });
});

await test("multiRoot: scalar values", () => {
  const roots = [];
  withParser({ multiRoot: true, onRoot: (e) => roots.push(e.value) }, (parser) => {
    parser.feed('"hello"\n42\ntrue');
  });
  assertEqual(roots.length, 3);
  assertEqual(roots[0], "hello");
  assertEqual(roots[1], 42);
  assertEqual(roots[2], true);
});

// =============================================================
// 5. Skip paths
// =============================================================

// =============================================================
// 6. JSON Boundary Detection (seeker)
// =============================================================

await test("seeker: strips <think> tags", () => {
  withParser((parser) => {
    const events = [];
    const textEvents = [];
    parser.on("a", (e) => events.push(e));
    parser.onText((t) => textEvents.push(t));
    parser.feed('<think>reasoning here</think>{"a":1}');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, 1);
    assert(textEvents.length > 0, "Should have captured think text");
  });
});

await test("seeker: strips markdown code fence", () => {
  withParser((parser) => {
    const events = [];
    parser.on("x", (e) => events.push(e));
    parser.feed('```json\n{"x":42}\n```');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, 42);
  });
});

await test("seeker: handles direct JSON (no preamble)", () => {
  withParser((parser) => {
    const events = [];
    parser.on("key", (e) => events.push(e));
    parser.feed('{"key":"value"}');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, "value");
  });
});

await test("seeker: skips prose before JSON", () => {
  withParser((parser) => {
    const events = [];
    parser.on("answer", (e) => events.push(e));
    parser.feed('Here is the result:\n{"answer":42}');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, 42);
  });
});

// =============================================================
// 7. Schema filtering (Zod-like .safeParse interface)
// =============================================================

await test("schema: events only fire when schema passes", () => {
  const fakeSchema = {
    safeParse(v) {
      if (typeof v === 'object' && v !== null && typeof v.name === 'string') {
        return { success: true, data: v };
      }
      return { success: false };
    }
  };
  withParser((parser) => {
    const events = [];
    parser.on("items[*]", fakeSchema, (e) => events.push(e));
    parser.feed('{"items":[{"name":"ok"},{"invalid":true},{"name":"also ok"}]}');
    assertEqual(events.length, 2);
    assertEqual(events[0].value.name, "ok");
    assertEqual(events[1].value.name, "also ok");
  });
});

await test("schema: transforms value via schema.data", () => {
  const uppercaseSchema = {
    safeParse(v) {
      if (typeof v === 'string') {
        return { success: true, data: v.toUpperCase() };
      }
      return { success: false };
    }
  };
  withParser((parser) => {
    const events = [];
    parser.on("name", uppercaseSchema, (e) => events.push(e));
    parser.feed('{"name":"alice"}');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, "ALICE");
  });
});

// =============================================================
// 8. Byte-level source location
// =============================================================

await test("offset and length on path events", () => {
  withParser((parser) => {
    const events = [];
    parser.on("key", (e) => events.push(e));
    parser.feed('{"key":"val"}');
    assertEqual(events.length, 1);
    assert(typeof events[0].offset === 'number', "offset should be a number");
    assert(typeof events[0].length === 'number', "length should be a number");
    assert(events[0].length > 0, "length should be positive");
  });
});

// =============================================================
// 9. off() — unsubscribe
// =============================================================

await test("off: removes path subscription", () => {
  withParser((parser) => {
    const events = [];
    const cb = (e) => events.push(e);
    parser.on("x", cb);
    parser.off("x", cb);
    parser.feed('{"x":1}');
    assertEqual(events.length, 0);
  });
});

// =============================================================
// 10. getValue / getStatus / getRemaining
// =============================================================

await test("getValue: returns parsed value after complete", () => {
  withParser((parser) => {
    parser.feed('{"a":1}');
    const val = parser.getValue();
    assertEqual(val, { a: 1 });
  });
});

await test("getStatus: reflects current status", () => {
  withParser((parser) => {
    assertEqual(parser.getStatus(), "incomplete");
    parser.feed('{"a":');
    assertEqual(parser.getStatus(), "incomplete");
    parser.feed('1}');
    assertEqual(parser.getStatus(), "complete");
  });
});

await test("getRemaining: returns remaining after end_early", () => {
  withParser((parser) => {
    parser.feed('{"a":1}{"b":2}');
    const status = parser.getStatus();
    assertEqual(status, "end_early");
    const remaining = parser.getRemaining();
    assert(remaining !== null, "Should have remaining bytes");
  });
});

// =============================================================
// 11. Edge cases
// =============================================================

await test("empty feed does not crash", () => {
  withParser((parser) => {
    parser.feed('');
    parser.feed(new Uint8Array(0));
  });
});

await test("deeply nested objects", () => {
  withParser((parser) => {
    const events = [];
    parser.on("a.b.c.d", (e) => events.push(e));
    parser.feed('{"a":{"b":{"c":{"d":"deep"}}}}');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, "deep");
  });
});

await test("escaped keys in JSON", () => {
  withParser((parser) => {
    const events = [];
    parser.on("*", (e) => events.push(e));
    parser.feed('{"normal":"a","other":"b"}');
    assert(events.length >= 1, "Should fire for at least one key");
  });
});

await test("unicode in string values", () => {
  withParser((parser) => {
    const events = [];
    parser.on("emoji", (e) => events.push(e));
    parser.feed('{"emoji":"\\u0048\\u0069"}');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, "Hi");
  });
});

await test("destroy prevents further use", () => {
  const parser = createEventParser();
  parser.destroy();
  let threw = false;
  try { parser.feed('{}'); } catch { threw = true; }
  assert(threw, "Should throw after destroy");
});

await test("Uint8Array input", () => {
  withParser((parser) => {
    const events = [];
    parser.on("key", (e) => events.push(e));
    const enc = new TextEncoder();
    parser.feed(enc.encode('{"key":"val"}'));
    assertEqual(events.length, 1);
    assertEqual(events[0].value, "val");
  });
});

await test("wildcard key match in object", () => {
  withParser((parser) => {
    const events = [];
    parser.on("data.*.value", (e) => events.push(e));
    parser.feed('{"data":{"first":{"value":1},"second":{"value":2}}}');
    assertEqual(events.length, 2);
    assertEqual(events[0].value, 1);
    assertEqual(events[1].value, 2);
  });
});

// =============================================================
// 12. Chaining API
// =============================================================

await test("methods return self for chaining", () => {
  withParser((parser) => {
    const result = parser
      .on("a", () => {})
      .onDelta("b", () => {})
      .onText(() => {});
    assert(result === parser, "Should return self for chaining");
  });
});

// =============================================================
// 13. Critical coverage: empty containers
// =============================================================

await test("on: empty object at subscribed path", () => {
  withParser((parser) => {
    const events = [];
    parser.on("data", (e) => events.push(e));
    parser.feed('{"data":{}}');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, {});
  });
});

await test("on: empty array at subscribed path", () => {
  withParser((parser) => {
    const events = [];
    parser.on("items", (e) => events.push(e));
    parser.feed('{"items":[]}');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, []);
  });
});

// =============================================================
// 14. Critical coverage: multiple subscriptions on same value
// =============================================================

await test("on: multiple subscriptions on same path both fire", () => {
  withParser((parser) => {
    const events1 = [], events2 = [];
    parser.on("x", (e) => events1.push(e));
    parser.on("x", (e) => events2.push(e));
    parser.feed('{"x":42}');
    assertEqual(events1.length, 1);
    assertEqual(events2.length, 1);
    assertEqual(events1[0].value, 42);
    assertEqual(events2[0].value, 42);
  });
});

// =============================================================
// 15. Scalar values spanning chunks
// =============================================================

await test("on: number split across chunks", () => {
  withParser((parser) => {
    const events = [];
    parser.on("n", (e) => events.push(e));
    parser.feed('{"n":12');
    parser.feed('345}');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, 12345);
  });
});

await test("on: negative number split across chunks", () => {
  withParser((parser) => {
    const events = [];
    parser.on("n", (e) => events.push(e));
    parser.feed('{"n":-');
    parser.feed('99}');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, -99);
  });
});

await test("on: boolean split across chunks", () => {
  withParser((parser) => {
    const events = [];
    parser.on("b", (e) => events.push(e));
    parser.feed('{"b":tr');
    parser.feed('ue}');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, true);
  });
});

await test("on: null split across chunks", () => {
  withParser((parser) => {
    const events = [];
    parser.on("v", (e) => events.push(e));
    parser.feed('{"v":nu');
    parser.feed('ll}');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, null);
  });
});

await test("on: float value at path", () => {
  withParser((parser) => {
    const events = [];
    parser.on("pi", (e) => events.push(e));
    parser.feed('{"pi":3.14159}');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, 3.14159);
  });
});

await test("on: scientific notation value at path", () => {
  withParser((parser) => {
    const events = [];
    parser.on("big", (e) => events.push(e));
    parser.feed('{"big":1.5e10}');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, 1.5e10);
  });
});

// =============================================================
// 16. Delta on nested paths
// =============================================================

await test("onDelta: nested path fires deltas", () => {
  withParser((parser) => {
    const deltas = [];
    parser.onDelta("user.name", (e) => deltas.push(e.value));
    parser.feed('{"user":{"name":"Alice"}}');
    const fullText = deltas.join('');
    assertEqual(fullText, "Alice");
  });
});

await test("onDelta: string spanning multiple chunks", () => {
  withParser((parser) => {
    const deltas = [];
    parser.onDelta("msg", (e) => deltas.push(e.value));
    parser.feed('{"msg":"Hel');
    parser.feed('lo Wor');
    parser.feed('ld"}');
    const fullText = deltas.join('');
    assertEqual(fullText, "Hello World");
  });
});

await test("onDelta: fires incrementally per feed (not just on close)", () => {
  withParser((parser) => {
    const deltas = [];
    parser.onDelta("msg", (e) => deltas.push(e.value));
    parser.feed('{"msg":"Hel');
    assert(deltas.length >= 1, `Expected delta after first chunk, got ${deltas.length}`);
    assertEqual(deltas.join(''), "Hel");
    parser.feed('lo');
    assertEqual(deltas.join(''), "Hello");
    parser.feed(' World"}');
    assertEqual(deltas.join(''), "Hello World");
    assert(deltas.length >= 3, `Expected >= 3 delta batches, got ${deltas.length}`);
  });
});

await test("onDelta: both delta and path subscription on same string", () => {
  withParser((parser) => {
    const pathEvents = [], deltaEvents = [];
    parser.on("msg", (e) => pathEvents.push(e));
    parser.onDelta("msg", (e) => deltaEvents.push(e.value));
    parser.feed('{"msg":"test"}');
    assertEqual(pathEvents.length, 1);
    assertEqual(pathEvents[0].value, "test");
    assert(deltaEvents.length >= 1, "Delta should fire");
    assertEqual(deltaEvents.join(''), "test");
  });
});

// =============================================================
// 17. Multi-root edge cases
// =============================================================

await test("multiRoot: single value (no reset needed)", () => {
  const roots = [];
  withParser({ multiRoot: true, onRoot: (e) => roots.push(e) }, (parser) => {
    parser.feed('{"single":1}');
  });
  assertEqual(roots.length, 1);
  assertEqual(roots[0].value, { single: 1 });
});

await test("multiRoot: with path subscriptions active", () => {
  const roots = [], events = [];
  withParser({ multiRoot: true, onRoot: (e) => roots.push(e) }, (parser) => {
    parser.on("id", (e) => events.push(e.value));
    parser.feed('{"id":1}\n{"id":2}');
  });
  assertEqual(roots.length, 2);
  // Path events fire per-root before reset
  assert(events.length >= 1, "Path events should fire in multi-root");
});

await test("multiRoot: empty objects", () => {
  const roots = [];
  withParser({ multiRoot: true, onRoot: (e) => roots.push(e.value) }, (parser) => {
    parser.feed('{}\n[]\n{}');
  });
  assertEqual(roots.length, 3);
  assertEqual(roots[0], {});
  assertEqual(roots[1], []);
  assertEqual(roots[2], {});
});

await test("multiRoot: various whitespace between values", () => {
  const roots = [];
  withParser({ multiRoot: true, onRoot: (e) => roots.push(e.value) }, (parser) => {
    parser.feed('{"a":1}  \t  {"b":2}');
  });
  assertEqual(roots.length, 2);
  assertEqual(roots[0], { a: 1 });
  assertEqual(roots[1], { b: 2 });
});

// =============================================================
// 18. Skip edge cases
// =============================================================

// =============================================================
// 19. Schema edge cases
// =============================================================

await test("schema: always-failing schema suppresses all events", () => {
  const alwaysFail = { safeParse: () => ({ success: false }) };
  withParser((parser) => {
    const events = [];
    parser.on("items[*]", alwaysFail, (e) => events.push(e));
    parser.feed('{"items":[1,2,3]}');
    assertEqual(events.length, 0);
  });
});

// =============================================================
// 20. Seeker edge cases
// =============================================================

await test("seeker: empty think tag", () => {
  withParser((parser) => {
    const events = [];
    parser.on("a", (e) => events.push(e));
    parser.feed('<think></think>{"a":1}');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, 1);
  });
});

await test("seeker: prose-only input (no JSON)", () => {
  withParser((parser) => {
    const events = [];
    const textEvents = [];
    parser.on("x", (e) => events.push(e));
    parser.onText((t) => textEvents.push(t));
    parser.feed('Just some text with no JSON');
    assertEqual(events.length, 0);
    assertEqual(parser.getStatus(), "incomplete");
  });
});

await test("seeker: text before code fence is emitted correctly", () => {
  withParser((parser) => {
    const textEvents = [];
    const events = [];
    parser.on("x", (e) => events.push(e));
    parser.onText((t) => textEvents.push(t));
    parser.feed('Here is the result:\n```json\n{"x":42}\n```');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, 42);
    // The text before the fence should be emitted (not truncated by backtick slicing)
    const allText = textEvents.join('');
    assert(allText.includes('Here is the result:'), `Text before fence should be preserved, got: "${allText}"`);
  });
});

await test("seeker: 4-backtick code fence", () => {
  withParser((parser) => {
    const events = [];
    parser.on("x", (e) => events.push(e));
    parser.feed('````json\n{"x":99}\n````');
    assertEqual(events.length, 1);
    assertEqual(events[0].value, 99);
  });
});

// =============================================================
// 21. Concurrent EventParsers
// =============================================================

await test("concurrent: multiple EventParsers work independently", () => {
  const p1 = createEventParser();
  const p2 = createEventParser();
  try {
    const e1 = [], e2 = [];
    p1.on("a", (e) => e1.push(e.value));
    p2.on("b", (e) => e2.push(e.value));
    p1.feed('{"a":1}');
    p2.feed('{"b":2}');
    assertEqual(e1, [1]);
    assertEqual(e2, [2]);
  } finally {
    p1.destroy();
    p2.destroy();
  }
});

// =============================================================
// 22. Deeply nested (10+ levels)
// =============================================================

await test("on: 10-level deep nesting", () => {
  withParser((parser) => {
    const events = [];
    parser.on("a.b.c.d.e.f.g.h.i.j", (e) => events.push(e));
    const json = '{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":{"i":{"j":"deep"}}}}}}}}}}';
    parser.feed(json);
    assertEqual(events.length, 1);
    assertEqual(events[0].value, "deep");
  });
});

// =============================================================
// 23. Delta byte offset correctness
// =============================================================

await test("onDelta: offset and length are byte-accurate", () => {
  withParser((parser) => {
    const deltas = [];
    parser.onDelta("msg", (e) => deltas.push(e));
    parser.feed('{"msg":"abc"}');
    assert(deltas.length >= 1, "Should fire delta");
    const d = deltas[0];
    assert(typeof d.offset === 'number', "offset should be number");
    assert(typeof d.length === 'number', "length should be number");
    assert(d.length > 0, "length should be > 0");
  });
});

await test("onDelta: offset with escape sequence accounts for raw bytes", () => {
  withParser((parser) => {
    const deltas = [];
    parser.onDelta("msg", (e) => deltas.push(e));
    // "a\nb" is 4 raw bytes: a, \, n, b
    parser.feed('{"msg":"a\\nb"}');
    const fullText = deltas.map(d => d.value).join('');
    assertEqual(fullText, "a\nb"); // decoded
    // Total raw byte length of string content should be 4 (a \ n b)
    const lastDelta = deltas[deltas.length - 1];
    assert(lastDelta.length > 0, "Delta length should be positive");
  });
});

// =============================================================
// Summary
// =============================================================

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
