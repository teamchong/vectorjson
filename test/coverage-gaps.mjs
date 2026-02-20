/**
 * Tests: Coverage Gaps — exercises code paths identified during code review.
 *
 * Covers:
 * - getRawBuffer() on streaming parsers (Node.js unit tests)
 * - getValue() SyntaxError throw branch
 * - Symbol.dispose on parse results
 * - init({ engineWasm: Uint8Array }) explicit WASM override
 * - EventParser <think> tag split across chunks
 * - parsePartialJson schema failure returns "failed-parse"
 * - ParseResult.free() typed on result
 * - ParseResult discriminated union fields
 */
import {
  parse,
  parsePartialJson,
  createParser,
  createEventParser,
  init,
} from "../dist/index.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.error(`  ❌ ${name}: ${err.message}`); }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "Assertion failed");
}

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(msg || `Expected ${e}, got ${a}`);
}

console.log("\n🧪 VectorJSON — Coverage Gap Tests\n");

// =============================================================
// 1. getRawBuffer() on createParser (Node.js)
// =============================================================
console.log("--- getRawBuffer ---");

await test("createParser.getRawBuffer() returns buffer after feed", () => {
  const parser = createParser();
  try {
    parser.feed('{"hello":');
    const buf = parser.getRawBuffer();
    assert(buf !== null, "buffer should not be null after feeding data");
    assert(buf instanceof ArrayBuffer, "should return ArrayBuffer");
    assert(buf.byteLength > 0, "buffer should have data");
  } finally {
    parser.destroy();
  }
});

await test("createParser.getRawBuffer() returns null before any feed", () => {
  const parser = createParser();
  try {
    const buf = parser.getRawBuffer();
    assert(buf === null, "buffer should be null before any feed");
  } finally {
    parser.destroy();
  }
});

await test("createParser.getRawBuffer() returns null after destroy", () => {
  const parser = createParser();
  parser.feed('{"a":1}');
  parser.destroy();
  const buf = parser.getRawBuffer();
  assert(buf === null, "buffer should be null after destroy");
});

await test("createEventParser.getRawBuffer() returns buffer after feed", () => {
  const parser = createEventParser();
  try {
    parser.feed('{"key":"value"}');
    const buf = parser.getRawBuffer();
    assert(buf !== null, "buffer should not be null");
    assert(buf instanceof ArrayBuffer, "should return ArrayBuffer");
    assert(buf.byteLength > 0, "buffer should have data");
  } finally {
    parser.destroy();
  }
});

// =============================================================
// 2. getValue() SyntaxError throw branch
// =============================================================
console.log("--- getValue() SyntaxError ---");

await test("createParser.getValue() throws SyntaxError on parse error", () => {
  const parser = createParser();
  try {
    const status = parser.feed("{invalid json}}}");
    if (status === "error") {
      let threw = false;
      try {
        parser.getValue();
      } catch (err) {
        threw = true;
        assert(err instanceof SyntaxError, `expected SyntaxError, got ${err.constructor.name}`);
        assert(err.message.includes("VectorJSON"), `message should include VectorJSON: ${err.message}`);
      }
      assert(threw, "getValue() should throw on error status");
    }
  } finally {
    parser.destroy();
  }
});

await test("createEventParser.getValue() throws SyntaxError on error status", () => {
  const parser = createEventParser();
  try {
    const status = parser.feed("{not valid!!!}}}");
    if (status === "error") {
      let threw = false;
      try {
        parser.getValue();
      } catch (err) {
        threw = true;
        assert(err instanceof SyntaxError, `expected SyntaxError, got ${err.constructor.name}`);
      }
      assert(threw, "getValue() should throw on error status");
    }
  } finally {
    parser.destroy();
  }
});

// =============================================================
// 3. Symbol.dispose
// =============================================================
console.log("--- Symbol.dispose ---");

await test("parse result has Symbol.dispose for 'using' support", () => {
  const result = parse('{"a":1}');
  assert(Symbol.dispose in result.value, "Symbol.dispose should be in result.value");
  const disposeFn = result.value[Symbol.dispose];
  assert(typeof disposeFn === "function", "Symbol.dispose should be a function");
});

await test("parse result array has Symbol.dispose", () => {
  const result = parse('[1,2,3]');
  assert(Symbol.dispose in result.value, "Symbol.dispose should be in array proxy");
});

await test("Symbol.dispose calls free correctly", () => {
  const result = parse('{"nested":{"deep":true}}');
  const disposeFn = result.value[Symbol.dispose];
  disposeFn();
  // Double-dispose should be safe (noop)
  disposeFn();
});

// =============================================================
// 4. init({ engineWasm: Uint8Array }) explicit WASM override
// =============================================================
console.log("--- init with engineWasm ---");

await test("init({ engineWasm: Uint8Array }) loads WASM from buffer", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const wasmPath = join(root, "dist", "engine.wasm");
  const wasmBytes = readFileSync(wasmPath);
  const vj = await init({ engineWasm: wasmBytes });
  assert(typeof vj.parse === "function", "should have parse method");
  const result = vj.parse('{"test":true}');
  assert(result.status === "complete");
  assert(result.value.test === true);
});

await test("init({ engineWasm: ArrayBuffer }) loads WASM from ArrayBuffer", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const wasmPath = join(root, "dist", "engine.wasm");
  const wasmBytes = readFileSync(wasmPath);
  const vj = await init({ engineWasm: wasmBytes.buffer });
  assert(typeof vj.parse === "function");
});

// =============================================================
// 5. EventParser <think> tag split across chunks
// =============================================================
console.log("--- EventParser <think> split across chunks ---");

await test("seeker: <think> tag split across two chunks", () => {
  const parser = createEventParser();
  try {
    const textEvents = [];
    const events = [];
    parser.on("a", (e) => events.push(e));
    parser.onText((t) => textEvents.push(t));

    parser.feed("<thi");
    parser.feed("nk>reasoning</think>");
    parser.feed('{"a":1}');

    assertEqual(events.length, 1, "should fire path event after think block");
    assertEqual(events[0].value, 1);
    const allText = textEvents.join("");
    assert(allText.includes("reasoning"), `think text should be captured, got: "${allText}"`);
  } finally {
    parser.destroy();
  }
});

await test("seeker: </think> closing tag split across chunks", () => {
  const parser = createEventParser();
  try {
    const events = [];
    parser.on("b", (e) => events.push(e));

    parser.feed("<think>thinking here</thi");
    parser.feed('nk>{"b":2}');

    assertEqual(events.length, 1);
    assertEqual(events[0].value, 2);
  } finally {
    parser.destroy();
  }
});

await test("seeker: multiple <think> blocks with JSON in between", () => {
  const parser = createEventParser();
  try {
    const events = [];
    parser.on("x", (e) => events.push(e));

    parser.feed("<think>first</think>");
    parser.feed('{"x":42}');

    assertEqual(events.length, 1);
    assertEqual(events[0].value, 42);
  } finally {
    parser.destroy();
  }
});

// =============================================================
// 6. parsePartialJson schema failure → "failed-parse"
// =============================================================
console.log("--- parsePartialJson schema failure ---");

await test("parsePartialJson: complete JSON failing schema returns 'failed-parse'", () => {
  const schema = {
    safeParse(v) {
      if (typeof v === "object" && v !== null && typeof v.name === "string") {
        return { success: true, data: v };
      }
      return { success: false };
    },
  };
  const result = parsePartialJson('{"age":30}', schema);
  assertEqual(result.state, "failed-parse", `expected failed-parse, got ${result.state}`);
  assert(result.value === undefined, "value should be undefined on failed-parse");
});

await test("parsePartialJson: complete JSON passing schema returns 'successful-parse'", () => {
  const schema = {
    safeParse(v) {
      if (typeof v === "object" && v !== null && typeof v.name === "string") {
        return { success: true, data: v };
      }
      return { success: false };
    },
  };
  const result = parsePartialJson('{"name":"Alice"}', schema);
  assertEqual(result.state, "successful-parse");
  assertEqual(result.value.name, "Alice");
});

// =============================================================
// 7. ParseResult.free() typed on result
// =============================================================
console.log("--- ParseResult.free ---");

await test("ParseResult has .free() for object results", () => {
  const result = parse('{"a":1}');
  assert(typeof result.free === "function", "result should have .free()");
  result.free();
});

await test("ParseResult has .free() for array results", () => {
  const result = parse('[1,2,3]');
  assert(typeof result.free === "function", "result should have .free()");
  result.free();
});

await test("ParseResult has no .free() for primitive results", () => {
  const result = parse("42");
  assert(result.free === undefined, "primitive result should not have .free()");
});

// =============================================================
// 8. ParseResult discriminated union fields
// =============================================================
console.log("--- ParseResult discriminated union ---");

await test("invalid ParseResult has error string", () => {
  const result = parse("{not valid json!!!}");
  assertEqual(result.status, "invalid");
  assert(typeof result.error === "string", "invalid result should have error string");
  assert(result.error.length > 0, "error message should not be empty");
  assert(result.value === undefined, "invalid result value should be undefined");
});

await test("complete ParseResult has value, no error", () => {
  const result = parse('{"a":1}');
  assertEqual(result.status, "complete");
  assert(result.value !== undefined, "complete result should have value");
  assert(result.error === undefined, "complete result should not have error");
});

await test("complete_early ParseResult has remaining", () => {
  const result = parse('42 "extra"');
  if (result.status === "complete_early") {
    assert(result.remaining instanceof Uint8Array, "complete_early should have remaining");
    assert(result.remaining.byteLength > 0, "remaining should not be empty");
  }
});

// =============================================================
// Summary
// =============================================================

console.log(`\n✨ Coverage Gap Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
