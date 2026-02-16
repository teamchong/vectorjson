/**
 * Tests for parsePartialJson() API and partial atom handling.
 * Covers the drop-in AI SDK replacement and all edge cases.
 */

import { init } from "../dist/index.js";

const vj = await init();
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2705 ${name}`);
    passed++;
  } catch (e) {
    console.log(`  \u274c ${name} \u2192 ${e.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || ""}Expected ${b}, got ${a}`);
}

console.log("\u{1f9ea} VectorJSON parsePartialJson + Partial Atom Tests\n");

// ── parsePartialJson API ──────────────────────────────────

console.log("--- parsePartialJson: state classification ---");

test("complete JSON → successful-parse", () => {
  const r = vj.parsePartialJson('{"a": 1}');
  assertEqual(r.state, "successful-parse");
  assertEqual(r.value, { a: 1 });
});

test("complete scalar → successful-parse", () => {
  assertEqual(vj.parsePartialJson("42").state, "successful-parse");
  assertEqual(vj.parsePartialJson("42").value, 42);
});

test("complete string → successful-parse", () => {
  assertEqual(vj.parsePartialJson('"hello"').state, "successful-parse");
  assertEqual(vj.parsePartialJson('"hello"').value, "hello");
});

test("complete boolean → successful-parse", () => {
  assertEqual(vj.parsePartialJson("true").state, "successful-parse");
  assertEqual(vj.parsePartialJson("true").value, true);
});

test("complete null → successful-parse", () => {
  assertEqual(vj.parsePartialJson("null").state, "successful-parse");
  assertEqual(vj.parsePartialJson("null").value, null);
});

test("complete_early → successful-parse", () => {
  const r = vj.parsePartialJson('{"a":1}{"b":2}');
  assertEqual(r.state, "successful-parse");
  assertEqual(r.value, { a: 1 });
});

test("incomplete JSON → repaired-parse", () => {
  const r = vj.parsePartialJson('{"a": 1, "b": ');
  assertEqual(r.state, "repaired-parse");
  assertEqual(r.value, { a: 1, b: null });
});

test("empty string → failed-parse", () => {
  assertEqual(vj.parsePartialJson("").state, "failed-parse");
  assertEqual(vj.parsePartialJson("").value, undefined);
});

test("whitespace only → failed-parse", () => {
  assertEqual(vj.parsePartialJson("   ").state, "failed-parse");
});

test("invalid JSON → failed-parse", () => {
  assertEqual(vj.parsePartialJson("}}}").state, "failed-parse");
});

// ── parsePartialJson: returns plain objects (not Proxy) ──

console.log("\n--- parsePartialJson: returns plain objects ---");

test("result is a plain object, not a Proxy", () => {
  const r = vj.parsePartialJson('{"a": [1, 2, 3]}');
  // Should be a plain object — JSON.parse-backed via toJSON()
  assertEqual(typeof r.value, "object");
  assertEqual(r.value.a.length, 3);
  assertEqual(r.value.a[0], 1);
});

test("incomplete result is a plain object", () => {
  const r = vj.parsePartialJson('{"a": [1, 2');
  assertEqual(r.state, "repaired-parse");
  assertEqual(Array.isArray(r.value.a), true);
  assertEqual(r.value.a[0], 1);
  assertEqual(r.value.a[1], 2);
});

// ── Partial atom completion (booleans, null, numbers) ──

console.log("\n--- Partial atoms: booleans ---");

test("partial 't' → true", () => {
  const r = vj.parse('{"a": t');
  assertEqual(r.status, "incomplete");
  assertEqual(r.toJSON(), { a: true });
});

test("partial 'tr' → true", () => {
  const r = vj.parse('{"a": tr');
  assertEqual(r.status, "incomplete");
  assertEqual(r.toJSON(), { a: true });
});

test("partial 'tru' → true", () => {
  const r = vj.parse('{"a": tru');
  assertEqual(r.status, "incomplete");
  assertEqual(r.toJSON(), { a: true });
});

test("complete 'true' stays true", () => {
  const r = vj.parse('{"a": true}');
  assertEqual(r.status, "complete");
  assertEqual(r.toJSON(), { a: true });
});

test("partial 'f' → false", () => {
  const r = vj.parse('{"a": f');
  assertEqual(r.status, "incomplete");
  assertEqual(r.toJSON(), { a: false });
});

test("partial 'fa' → false", () => {
  const r = vj.parse('{"a": fa');
  assertEqual(r.status, "incomplete");
  assertEqual(r.toJSON(), { a: false });
});

test("partial 'fal' → false", () => {
  const r = vj.parse('{"a": fal');
  assertEqual(r.status, "incomplete");
  assertEqual(r.toJSON(), { a: false });
});

test("partial 'fals' → false", () => {
  const r = vj.parse('{"a": fals');
  assertEqual(r.status, "incomplete");
  assertEqual(r.toJSON(), { a: false });
});

console.log("\n--- Partial atoms: null ---");

test("partial 'n' → null", () => {
  const r = vj.parse('{"a": n');
  assertEqual(r.status, "incomplete");
  assertEqual(r.toJSON(), { a: null });
});

test("partial 'nu' → null", () => {
  const r = vj.parse('{"a": nu');
  assertEqual(r.status, "incomplete");
  assertEqual(r.toJSON(), { a: null });
});

test("partial 'nul' → null", () => {
  const r = vj.parse('{"a": nul');
  assertEqual(r.status, "incomplete");
  assertEqual(r.toJSON(), { a: null });
});

console.log("\n--- Partial atoms: numbers ---");

test("trailing dot stripped: '1.' → 1", () => {
  const r = vj.parse('{"a": 1.');
  assertEqual(r.status, "incomplete");
  assertEqual(r.toJSON(), { a: 1 });
});

test("trailing 'e' stripped: '1e' → 1", () => {
  const r = vj.parse('{"a": 1e');
  assertEqual(r.status, "incomplete");
  assertEqual(r.toJSON(), { a: 1 });
});

test("trailing 'E' stripped: '1E' → 1", () => {
  const r = vj.parse('{"a": 1E');
  assertEqual(r.status, "incomplete");
  assertEqual(r.toJSON(), { a: 1 });
});

test("standalone minus → invalid (not a real LLM streaming scenario)", () => {
  // A standalone "-" without digits isn't valid partial JSON.
  // LLMs emit "-1" not just "-". Vercel AI SDK also fails on this.
  const r = vj.parse('{"a": -');
  assertEqual(r.status, "invalid");
});

test("trailing 'e-' stripped iteratively: '1.23e-' → 1.23", () => {
  const r = vj.parse('{"a": 1.23e-');
  assertEqual(r.status, "incomplete");
  assertEqual(r.toJSON(), { a: 1.23 });
});

test("trailing 'e+' stripped iteratively: '1e+' → 1", () => {
  const r = vj.parse('{"a": 1e+');
  assertEqual(r.status, "incomplete");
  assertEqual(r.toJSON(), { a: 1 });
});

test("trailing 'e-' in array: [1, 2.5e-", () => {
  const r = vj.parse("[1, 2.5e-");
  assertEqual(r.status, "incomplete");
  assertEqual(r.toJSON(), [1, 2.5]);
});

test("valid number not modified: 42", () => {
  const r = vj.parse('{"a": 42');
  assertEqual(r.status, "incomplete");
  assertEqual(r.toJSON(), { a: 42 });
});

test("valid float not modified: 3.14", () => {
  const r = vj.parse('{"a": 3.14');
  assertEqual(r.status, "incomplete");
  assertEqual(r.toJSON(), { a: 3.14 });
});

test("valid sci notation not modified: 1e5", () => {
  const r = vj.parse('{"a": 1e5');
  assertEqual(r.status, "incomplete");
  assertEqual(r.toJSON(), { a: 100000 });
});

console.log("\n--- Partial atoms: root level ---");

test("root partial 'tr' → incomplete", () => {
  const r = vj.parse("tr");
  assertEqual(r.status, "incomplete");
});

test("root partial 'nul' → incomplete", () => {
  const r = vj.parse("nul");
  assertEqual(r.status, "incomplete");
});

test("root partial 'fals' → incomplete", () => {
  const r = vj.parse("fals");
  assertEqual(r.status, "incomplete");
});

test("root '1.' → incomplete (trailing dot)", () => {
  const r = vj.parse("1.");
  assertEqual(r.status, "incomplete");
});

test("root '-' → invalid (not meaningful partial JSON)", () => {
  const r = vj.parse("-");
  assertEqual(r.status, "invalid");
});

// ── Partial atoms in arrays ──

console.log("\n--- Partial atoms: in arrays ---");

test("array with partial boolean: [1, tr", () => {
  const r = vj.parse("[1, tr");
  assertEqual(r.status, "incomplete");
  assertEqual(r.toJSON(), [1, true]);
});

test("array with partial null: [1, nul", () => {
  const r = vj.parse("[1, nul");
  assertEqual(r.status, "incomplete");
  assertEqual(r.toJSON(), [1, null]);
});

test("array with trailing dot: [1, 2.", () => {
  const r = vj.parse("[1, 2.");
  assertEqual(r.status, "incomplete");
  assertEqual(r.toJSON(), [1, 2]);
});

// ── parsePartialJson via Vercel-compatible API ──

console.log("\n--- parsePartialJson: AI SDK compatibility ---");

test("partial boolean via parsePartialJson", () => {
  const r = vj.parsePartialJson('{"flag": tr');
  assertEqual(r.state, "repaired-parse");
  assertEqual(r.value, { flag: true });
});

test("partial null via parsePartialJson", () => {
  const r = vj.parsePartialJson('{"v": nul');
  assertEqual(r.state, "repaired-parse");
  assertEqual(r.value, { v: null });
});

test("trailing dot via parsePartialJson", () => {
  const r = vj.parsePartialJson('{"n": 3.');
  assertEqual(r.state, "repaired-parse");
  assertEqual(r.value, { n: 3 });
});

test("unclosed string via parsePartialJson", () => {
  const r = vj.parsePartialJson('{"name": "hel');
  assertEqual(r.state, "repaired-parse");
  assertEqual(r.value, { name: "hel" });
});

test("partial unicode escape \\u → strips escape", () => {
  const r = vj.parsePartialJson('{"v": "hello\\u00');
  assertEqual(r.state, "repaired-parse");
  assertEqual(r.value, { v: "hello" });
});

test("partial unicode escape \\u0 → strips escape", () => {
  const r = vj.parsePartialJson('{"v": "ab\\u0');
  assertEqual(r.state, "repaired-parse");
  assertEqual(r.value, { v: "ab" });
});

test("complete unicode escape preserved", () => {
  const r = vj.parsePartialJson('{"v": "\\u0041"}');
  assertEqual(r.state, "successful-parse");
  assertEqual(r.value, { v: "A" });
});

test("nested incomplete via parsePartialJson", () => {
  const r = vj.parsePartialJson('{"a": [1, 2], "b": {"c": ');
  assertEqual(r.state, "repaired-parse");
  assertEqual(r.value.a[0], 1);
  assertEqual(r.value.a[1], 2);
  assertEqual(r.value.b.c, null);
});

test("large streaming scenario", () => {
  // Simulate what an AI SDK does: parse accumulated JSON on every chunk
  const full = '{"items": [{"id": 1, "name": "first"}, {"id": 2, "name": "second"}]}';
  for (let i = 10; i < full.length; i += 5) {
    const prefix = full.slice(0, i);
    const r = vj.parsePartialJson(prefix);
    // Should never throw, should return valid state
    if (r.state !== "repaired-parse" && r.state !== "successful-parse" && r.state !== "failed-parse") {
      throw new Error(`Unexpected state ${r.state} at offset ${i}`);
    }
  }
  // Final complete parse
  const r = vj.parsePartialJson(full);
  assertEqual(r.state, "successful-parse");
  assertEqual(r.value.items.length, 2);
});

// ── Streaming parser tests ──

console.log("\n--- Streaming parser (createParser) ---");

test("basic streaming: feed complete JSON in chunks", () => {
  const parser = vj.createParser();
  const json = '{"hello": "world", "n": 42}';
  let status;
  for (let i = 0; i < json.length; i += 5) {
    status = parser.feed(json.slice(i, i + 5));
    if (status === "complete" || status === "end_early") break;
  }
  assertEqual(status, "complete");
  const val = parser.getValue();
  assertEqual(vj.materialize(val), { hello: "world", n: 42 });
  parser.destroy();
});

test("streaming: single chunk complete", () => {
  const parser = vj.createParser();
  const status = parser.feed('{"a": 1}');
  assertEqual(status, "complete");
  const val = parser.getValue();
  assertEqual(vj.materialize(val), { a: 1 });
  parser.destroy();
});

test("streaming: byte-at-a-time", () => {
  const parser = vj.createParser();
  const json = "[1, 2]";
  let status = "incomplete";
  for (const ch of json) {
    status = parser.feed(ch);
    if (status === "complete") break;
  }
  assertEqual(status, "complete");
  assertEqual(vj.materialize(parser.getValue()), [1, 2]);
  parser.destroy();
});

test("streaming: Uint8Array input", () => {
  const parser = vj.createParser();
  const encoder = new TextEncoder();
  const status = parser.feed(encoder.encode('{"x": true}'));
  assertEqual(status, "complete");
  assertEqual(vj.materialize(parser.getValue()), { x: true });
  parser.destroy();
});

test("streaming: NDJSON (end_early) — getRemaining before getValue", () => {
  const parser = vj.createParser();
  const status = parser.feed('{"a":1}\n{"b":2}');
  assertEqual(status, "end_early");
  const remaining = parser.getRemaining();
  if (!remaining) throw new Error("Expected remaining bytes");
  const remainStr = new TextDecoder().decode(remaining);
  if (!remainStr.includes('{"b":2}')) {
    throw new Error(`Remaining should contain second object, got: ${remainStr}`);
  }
  assertEqual(vj.materialize(parser.getValue()), { a: 1 });
  parser.destroy();
});

test("streaming: NDJSON (end_early) — getValue before getRemaining", () => {
  const parser = vj.createParser();
  const status = parser.feed('{"x":1}\n{"y":2}');
  assertEqual(status, "end_early");
  // getValue() first — SIMD padding used to overwrite remaining bytes
  assertEqual(vj.materialize(parser.getValue()), { x: 1 });
  const remaining = parser.getRemaining();
  if (!remaining) throw new Error("Expected remaining bytes after getValue");
  const remainStr = new TextDecoder().decode(remaining);
  if (!remainStr.includes('{"y":2}')) {
    throw new Error(`Remaining should contain second object, got: ${remainStr}`);
  }
  parser.destroy();
});

test("streaming: getValue returns undefined on incomplete", () => {
  const parser = vj.createParser();
  parser.feed('{"a": ');
  assertEqual(parser.getValue(), undefined);
  parser.destroy();
});

test("streaming: getStatus reflects state", () => {
  const parser = vj.createParser();
  assertEqual(parser.getStatus(), "incomplete");
  parser.feed("[1]");
  assertEqual(parser.getStatus(), "complete");
  parser.destroy();
});

test("streaming: empty feed returns current status", () => {
  const parser = vj.createParser();
  assertEqual(parser.feed(""), "incomplete");
  parser.feed("[1]");
  assertEqual(parser.feed(""), "complete");
  parser.destroy();
});

test("streaming: destroy prevents further use", () => {
  const parser = vj.createParser();
  parser.destroy();
  let threw = false;
  try { parser.feed("{}"); } catch { threw = true; }
  assertEqual(threw, true);
});

test("streaming: multiple concurrent parsers", () => {
  const p1 = vj.createParser();
  const p2 = vj.createParser();
  p1.feed('{"x":');
  p2.feed("[1,");
  p1.feed("1}");
  p2.feed("2]");
  assertEqual(vj.materialize(p1.getValue()), { x: 1 });
  assertEqual(vj.materialize(p2.getValue()), [1, 2]);
  p1.destroy();
  p2.destroy();
});

// ── parsePartialJson with schema validation ──

console.log("\n--- parsePartialJson: schema validation ---");

// Mock schema that accepts objects with { name: string, age: number }
const userSchema = {
  safeParse(v) {
    if (v && typeof v === 'object' && typeof v.name === 'string' && typeof v.age === 'number') {
      return { success: true, data: v };
    }
    return { success: false };
  }
};

// Transforming schema — uppercases name
const transformSchema = {
  safeParse(v) {
    if (v && typeof v === 'object' && typeof v.name === 'string') {
      return { success: true, data: { ...v, name: v.name.toUpperCase() } };
    }
    return { success: false };
  }
};

test("schema: complete valid JSON passes validation", () => {
  const r = vj.parsePartialJson('{"name":"Alice","age":30}', userSchema);
  assertEqual(r.state, "successful-parse");
  assertEqual(r.value, { name: "Alice", age: 30 });
});

test("schema: complete JSON fails validation → value undefined, state preserved", () => {
  const r = vj.parsePartialJson('{"name":"Alice"}', userSchema); // missing age
  assertEqual(r.state, "successful-parse");
  assertEqual(r.value, undefined);
});

test("schema: incomplete JSON passes validation", () => {
  const r = vj.parsePartialJson('{"name":"Alice","age":30, "extra":', userSchema);
  assertEqual(r.state, "repaired-parse");
  assertEqual(r.value, { name: "Alice", age: 30, extra: null });
});

test("schema: incomplete JSON fails validation → keeps raw value (DeepPartial)", () => {
  const r = vj.parsePartialJson('{"name":"Alice","extra":', userSchema); // missing age
  assertEqual(r.state, "repaired-parse");
  // Partial JSON: safeParse fails (missing age), but raw value is kept — it's partial, that's expected
  assertEqual(r.value, { name: "Alice", extra: null });
});

test("schema: failed parse stays failed regardless of schema", () => {
  const r = vj.parsePartialJson("}}}", userSchema);
  assertEqual(r.state, "failed-parse");
  assertEqual(r.value, undefined);
});

test("schema: empty string stays failed regardless of schema", () => {
  const r = vj.parsePartialJson("", userSchema);
  assertEqual(r.state, "failed-parse");
  assertEqual(r.value, undefined);
});

test("schema: transformation applied (data differs from raw parse)", () => {
  const r = vj.parsePartialJson('{"name":"alice"}', transformSchema);
  assertEqual(r.state, "successful-parse");
  assertEqual(r.value, { name: "ALICE" });
});

test("schema: complete_early JSON fails validation → value undefined", () => {
  const r = vj.parsePartialJson('{"name":"Alice"}{"b":2}', userSchema); // complete_early, missing age
  assertEqual(r.state, "successful-parse");
  assertEqual(r.value, undefined);
});

test("schema: no schema → backward compatible (unknown)", () => {
  const r = vj.parsePartialJson('{"a":1}');
  assertEqual(r.state, "successful-parse");
  assertEqual(r.value, { a: 1 });
});

// ── Summary ──

console.log(`\n\u2728 parsePartialJson Tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
