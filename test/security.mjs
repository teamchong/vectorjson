/**
 * Security tests — verify fixes for audit findings.
 * Covers: tape bounds checking, importTape validation, \uXXXX escapes,
 * UTF-8 multi-byte, stream overflow guard, parsePartialJson schema state.
 */
import { parse, createParser, createEventParser, importTape, parsePartialJson } from "../dist/index.js";

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  \u2705 ${name}`); }
  catch (err) { failed++; console.error(`  \u274C ${name}: ${err.message}`); }
}

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(msg || `Expected ${e}, got ${a}`);
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "Assertion failed");
}

console.log("\n\uD83D\uDD12 VectorJSON Security Tests\n");

// --- importTape validation ---

await test("importTape rejects buffer too small", async () => {
  try { importTape(new ArrayBuffer(4)); assert(false); } catch (e) {
    assert(e.message.includes("too small"), e.message);
  }
});

await test("importTape rejects zero tape_count", async () => {
  const buf = new ArrayBuffer(16);
  const v = new DataView(buf);
  v.setUint32(0, 0, true); // tape_count = 0
  v.setUint32(4, 0, true); // input_len = 0
  try { importTape(buf); assert(false); } catch (e) {
    assert(e.message.includes("invalid"), e.message);
  }
});

await test("importTape rejects tape_count = 1 (need at least 2)", async () => {
  const buf = new ArrayBuffer(16);
  const v = new DataView(buf);
  v.setUint32(0, 1, true); // tape_count = 1
  v.setUint32(4, 0, true); // input_len = 0
  try { importTape(buf); assert(false); } catch (e) {
    assert(e.message.includes("invalid"), e.message);
  }
});

await test("importTape rejects buffer with mismatched size", async () => {
  const buf = new ArrayBuffer(20); // too small for tape_count=2 + input
  const v = new DataView(buf);
  v.setUint32(0, 2, true); // tape_count = 2 → needs 8 + 16 = 24 bytes minimum
  v.setUint32(4, 0, true);
  try { importTape(buf); assert(false); } catch (e) {
    assert(e.message.includes("invalid"), e.message);
  }
});

await test("importTape rejects crafted tape with out-of-bounds string ptr", async () => {
  // Create a valid tape via round-trip, then corrupt string ptr
  const p = createParser();
  p.feed('{"key":"val"}');
  const tape = p.getTapeBuffer();
  p.destroy();
  assert(tape !== null);

  // Corrupt: set a string word's data.ptr to point past input
  const v = new DataView(tape);
  const tc = v.getUint32(0, true);
  const il = v.getUint32(4, true);
  // Find a string word (tag = 0x73 = 's')
  for (let i = 0; i < tc; i++) {
    const tag = v.getUint8(8 + i * 8);
    if (tag === 0x73) { // string tag
      // Set ptr to way past input_len
      v.setUint32(8 + i * 8 + 4, il + 1000, true); // data.ptr = out of bounds
      break;
    }
  }
  try { importTape(tape); assert(false, "should reject corrupted tape"); } catch (e) {
    assert(e.message.includes("invalid"), e.message);
  }
});

await test("importTape rejects crafted tape with out-of-bounds container close", async () => {
  const p = createParser();
  p.feed('{"a":1}');
  const tape = p.getTapeBuffer();
  p.destroy();
  assert(tape !== null);

  const v = new DataView(tape);
  const tc = v.getUint32(0, true);
  // Find object_opening (tag = 0x7b = '{')
  for (let i = 0; i < tc; i++) {
    const tag = v.getUint8(8 + i * 8);
    if (tag === 0x7b) {
      // Set close index to way past tape_count
      v.setUint32(8 + i * 8 + 4, tc + 100, true);
      break;
    }
  }
  try { importTape(tape); assert(false, "should reject corrupted tape"); } catch (e) {
    assert(e.message.includes("invalid"), e.message);
  }
});

await test("importTape rejects tape with invalid tag byte", async () => {
  const p = createParser();
  p.feed('{"a":1}');
  const tape = p.getTapeBuffer();
  p.destroy();
  assert(tape !== null);

  const v = new DataView(tape);
  // Corrupt word 2's tag to an invalid value
  v.setUint8(8 + 2 * 8, 0xFF);
  try { importTape(tape); assert(false, "should reject invalid tag"); } catch (e) {
    assert(e.message.includes("invalid"), e.message);
  }
});

// --- Valid tape round-trip still works ---

await test("importTape accepts valid tapes after rejecting bad ones", async () => {
  const p = createParser();
  p.feed('{"hello":"world","num":42}');
  const tape = p.getTapeBuffer();
  p.destroy();
  const obj = importTape(tape);
  assertEqual(obj.hello, "world");
  assertEqual(obj.num, 42);
  obj.free();
});

// --- Unicode escape \uXXXX in live doc / delta events ---

await test("createEventParser: \\uXXXX decoded correctly in delta events", async () => {
  const ep = createEventParser();
  const deltas = [];
  ep.onDelta("msg", (e) => deltas.push(e.value));
  ep.feed('{"msg":"hello \\u0041\\u0042\\u0043"}');
  // Deltas should contain decoded characters, not raw escape
  const combined = deltas.join('');
  assert(combined.includes('ABC'), `Expected ABC in deltas, got: ${JSON.stringify(combined)}`);
  assert(!combined.includes('u0041'), `Should not contain raw escape u0041, got: ${JSON.stringify(combined)}`);
  ep.destroy();
});

await test("createParser: \\uXXXX decoded correctly in live document", async () => {
  const p = createParser();
  p.feed('{"msg":"\\u0048\\u0065\\u006C\\u006C\\u006F"}');
  const val = p.getValue();
  assertEqual(val.msg, "Hello");
  p.destroy();
});

await test("createParser: \\uXXXX in object keys decoded correctly", async () => {
  const p = createParser();
  p.feed('{"\\u006B\\u0065\\u0079":"value"}');
  const val = p.getValue();
  assertEqual(val.key, "value");
  p.destroy();
});

await test("createParser: \\uXXXX surrogate pairs decoded correctly", async () => {
  const p = createParser();
  // Emoji 😀 is \uD83D\uDE00 in JSON surrogate pair encoding
  p.feed('{"emoji":"\\uD83D\\uDE00","text":"hi\\uD83D\\uDE80bye"}');
  const val = p.getValue();
  assertEqual(val.emoji, "\uD83D\uDE00"); // 😀
  assertEqual(val.text, "hi\uD83D\uDE80bye"); // hi🚀bye
  p.destroy();
});

await test("createEventParser: \\uXXXX surrogate pairs in deltas", async () => {
  const ep = createEventParser();
  const deltas = [];
  ep.onDelta("msg", (e) => deltas.push(e.value));
  ep.feed('{"msg":"\\uD83D\\uDE00"}');
  const combined = deltas.join('');
  assertEqual(combined, "\uD83D\uDE00"); // 😀
  ep.destroy();
});

// --- UTF-8 multi-byte in live doc ---

await test("createParser: UTF-8 multi-byte strings decoded correctly", async () => {
  const p = createParser();
  // Chinese characters (3-byte UTF-8) and emoji (4-byte UTF-8)
  const json = JSON.stringify({ greeting: "\u4F60\u597D", emoji: "\uD83D\uDE00" });
  p.feed(json);
  const val = p.getValue();
  assertEqual(val.greeting, "\u4F60\u597D");
  assertEqual(val.emoji, "\uD83D\uDE00");
  p.destroy();
});

await test("createParser: UTF-8 multi-byte in keys decoded correctly", async () => {
  const p = createParser();
  const json = JSON.stringify({ "\u00E9": "accent", "\u4E16\u754C": "world" });
  p.feed(json);
  const val = p.getValue();
  assertEqual(val["\u00E9"], "accent");
  assertEqual(val["\u4E16\u754C"], "world");
  p.destroy();
});

await test("createEventParser: UTF-8 delta events correct", async () => {
  const ep = createEventParser();
  const deltas = [];
  ep.onDelta("text", (e) => deltas.push(e.value));
  const json = JSON.stringify({ text: "caf\u00E9" });
  ep.feed(json);
  const combined = deltas.join('');
  assert(combined.includes("caf\u00E9"), `Expected "caf\u00E9" in deltas, got: ${JSON.stringify(combined)}`);
  ep.destroy();
});

// --- parsePartialJson schema failure state ---

await test("parsePartialJson: schema failure on complete JSON returns failed-parse", async () => {
  // Use a simple schema-like object with safeParse
  const schema = {
    safeParse(val) {
      if (val && typeof val.name === 'string' && typeof val.age === 'number')
        return { success: true, data: val };
      return { success: false };
    }
  };
  const result = parsePartialJson('{"name":"Alice"}', schema); // missing age
  assertEqual(result.state, "failed-parse");
  assertEqual(result.value, undefined);
});

await test("parsePartialJson: schema success on complete JSON returns successful-parse", async () => {
  const schema = {
    safeParse(val) {
      if (val && typeof val.name === 'string' && typeof val.age === 'number')
        return { success: true, data: val };
      return { success: false };
    }
  };
  const result = parsePartialJson('{"name":"Alice","age":30}', schema);
  assertEqual(result.state, "successful-parse");
  assertEqual(result.value, { name: "Alice", age: 30 });
});

// --- Tape bounds: doc_get_tag with out-of-bounds index returns -1, not crash ---

await test("parse: accessing freed doc does not crash", async () => {
  const result = parse('{"a":1}');
  const val = result.value;
  assertEqual(val.a, 1);
  val.free();
  // After free, accessing should not crash the WASM module
  // (may return undefined or throw, but not segfault)
  try { const _ = val.a; } catch { /* expected */ }
  // Verify the module still works after the above
  const result2 = parse('{"b":2}');
  assertEqual(result2.value.b, 2);
});

// --- Stream overflow guard (saturating add) ---

await test("createParser: feed empty string does not crash", async () => {
  const p = createParser();
  const status = p.feed('');
  assertEqual(status, "incomplete");
  p.feed('{"ok":true}');
  const val = p.getValue();
  assertEqual(val.ok, true);
  p.destroy();
});

// --- Key escape decoding in createParser live document ---

await test("createParser: escaped chars in object keys decoded correctly", async () => {
  const p = createParser();
  p.feed('{"key\\nname":"val1","key\\ttab":"val2"}');
  const val = p.getValue();
  assertEqual(val["key\nname"], "val1");
  assertEqual(val["key\ttab"], "val2");
  p.destroy();
});

await test("createParser: backslash-escaped chars in keys via live doc", async () => {
  const p = createParser();
  p.feed('{"a\\/b":"slash","c\\\\"d":"bs"}');
  // key is a/b (escaped slash) and c\ (escaped backslash) — but the second key
  // has invalid JSON. Use a valid case instead.
  p.destroy();

  const p2 = createParser();
  p2.feed('{"a\\/b":"slash","c\\\\d":"backslash"}');
  const val = p2.getValue();
  assertEqual(val["a/b"], "slash");
  assertEqual(val["c\\d"], "backslash");
  p2.destroy();
});

// --- Array method binding on lazy proxy arrays ---

await test("parse: lazy array .map() works correctly", async () => {
  const result = parse('[1, 2, 3, 4, 5]');
  const arr = result.value;
  const doubled = arr.map(x => x * 2);
  assertEqual(doubled, [2, 4, 6, 8, 10]);
  result.value.free();
});

await test("parse: lazy array .filter() works correctly", async () => {
  const result = parse('[1, 2, 3, 4, 5]');
  const arr = result.value;
  const evens = arr.filter(x => x % 2 === 0);
  assertEqual(evens, [2, 4]);
  result.value.free();
});

await test("parse: lazy array .find() works correctly", async () => {
  const result = parse('[{"id":1},{"id":2},{"id":3}]');
  const arr = result.value;
  const found = arr.find(x => x.id === 2);
  assertEqual(found.id, 2);
  result.value.free();
});

// --- isComplete on last container in document ---

await test("parse: isComplete on last nested container", async () => {
  // When the container is the last thing in the tape,
  // isComplete should still return true for complete parses
  const result = parse('{"a":{"b":{"c":1}}}');
  assert(result.isComplete(result.value) === true, "root should be complete");
  assert(result.isComplete(result.value.a) === true, "nested a should be complete");
  assert(result.isComplete(result.value.a.b) === true, "deeply nested a.b should be complete");
  result.value.free();
});

// --- Event parser: escaped chars in keys decoded in live doc ---

await test("createEventParser: escaped chars in keys appear correctly in getValue", async () => {
  const ep = createEventParser();
  ep.feed('{"key\\nname":"hello","key\\ttab":"world"}');
  const val = ep.getValue();
  assertEqual(val["key\nname"], "hello");
  assertEqual(val["key\ttab"], "world");
  ep.destroy();
});

// --- createParser with schema-driven pick fields ---

await test("createParser: schema pick fields filter correctly", async () => {
  const schema = { shape: { name: {}, age: {} }, safeParse: (v) => ({ success: true, data: v }) };
  const p = createParser(schema);
  p.feed('{"name":"Alice","city":"NYC","age":30,"extra":"x"}');
  const val = p.getValue();
  assertEqual(val.name, "Alice");
  assertEqual(val.age, 30);
  // city and extra should not be present since they're not in schema
  assertEqual(val.city, undefined);
  assertEqual(val.extra, undefined);
  p.destroy();
});

console.log(`\n\uD83D\uDD12 Security Tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
