/**
 * Large JSON stress tests.
 * Fetches real-world JSON from public APIs and verifies:
 *   1. parse() with string input matches JSON.parse()
 *   2. parse() with Uint8Array (ArrayBuffer) input matches JSON.parse()
 *   3. createParser() streaming in chunks matches JSON.parse()
 *   4. createEventParser() streaming produces correct getValue()
 *   5. parsePartialJson() on full input matches JSON.parse()
 *   6. Synthetically generated large payloads (100KB+) parse correctly
 */
import { init } from "../dist/index.js";

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  \u2705 ${name}`); }
  catch (err) { failed++; console.error(`  \u274C ${name}: ${err.message}`); }
}

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(msg || `Expected ${e.slice(0, 120)}..., got ${a.slice(0, 120)}...`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion failed");
}

console.log("\n\uD83E\uDDEA VectorJSON Large JSON Stress Tests\n");
const vj = await init();

// ============================================================
// Helper: fetch JSON from a URL, return { json, text, bytes }
// ============================================================
async function fetchJSON(url, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  const text = await res.text();
  const expected = JSON.parse(text);
  const bytes = new TextEncoder().encode(text);
  return { text, bytes, expected, size: bytes.length };
}

// ============================================================
// Helper: run all parser modes on a payload
// ============================================================
async function testPayload(label, text, bytes, expected) {
  const size = bytes.length;
  const sizeKB = (size / 1024).toFixed(1);

  // 1. parse() with string
  await test(`${label} (${sizeKB}KB): parse(string)`, () => {
    const r = vj.parse(text);
    assert(r.status === "complete", `status=${r.status}`);
    assertEqual(vj.materialize(r.value), expected);
  });

  // 2. parse() with Uint8Array
  await test(`${label} (${sizeKB}KB): parse(Uint8Array)`, () => {
    const r = vj.parse(bytes);
    assert(r.status === "complete", `status=${r.status}`);
    assertEqual(vj.materialize(r.value), expected);
  });

  // 3. createParser() streaming — 12-char chunks (typical LLM token size)
  await test(`${label} (${sizeKB}KB): createParser streaming (12-char chunks)`, () => {
    const parser = vj.createParser();
    let status;
    for (let i = 0; i < text.length; i += 12) {
      status = parser.feed(text.slice(i, i + 12));
    }
    assert(status === "complete", `final status=${status}`);
    const val = parser.getValue();
    assertEqual(JSON.parse(JSON.stringify(val)), expected);
    parser.destroy();
  });

  // 4. createParser() streaming — Uint8Array 256-byte chunks
  await test(`${label} (${sizeKB}KB): createParser streaming (256-byte ArrayBuffer chunks)`, () => {
    const parser = vj.createParser();
    let status;
    for (let i = 0; i < bytes.length; i += 256) {
      status = parser.feed(bytes.slice(i, i + 256));
    }
    assert(status === "complete", `final status=${status}`);
    const val = parser.getValue();
    assertEqual(JSON.parse(JSON.stringify(val)), expected);
    parser.destroy();
  });

  // 5. createEventParser() streaming
  await test(`${label} (${sizeKB}KB): createEventParser streaming`, () => {
    const parser = vj.createEventParser();
    let status;
    for (let i = 0; i < text.length; i += 64) {
      status = parser.feed(text.slice(i, i + 64));
    }
    assert(status === "complete", `final status=${status}`);
    const val = parser.getValue();
    assertEqual(JSON.parse(JSON.stringify(val)), expected);
    parser.destroy();
  });

  // 6. parsePartialJson() on complete input (skip for >10MB — materializes full object, heavy on memory)
  if (size <= 10 * 1024 * 1024) {
    await test(`${label} (${sizeKB}KB): parsePartialJson(complete)`, () => {
      const { value, state } = vj.parsePartialJson(text);
      assert(state === "successful-parse", `state=${state}`);
      assertEqual(value, expected);
    });
  }
}

// ============================================================
// Section 1: Public API payloads
// ============================================================
console.log("--- Public API payloads ---");

const apis = [
  {
    url: "https://jsonplaceholder.typicode.com/posts",
    label: "JSONPlaceholder /posts (100 items)",
  },
  {
    url: "https://jsonplaceholder.typicode.com/comments",
    label: "JSONPlaceholder /comments (500 items)",
  },
  {
    url: "https://jsonplaceholder.typicode.com/photos",
    label: "JSONPlaceholder /photos (5000 items)",
  },
];

for (const { url, label } of apis) {
  try {
    const { text, bytes, expected, size } = await fetchJSON(url, label);
    await testPayload(label, text, bytes, expected);
  } catch (err) {
    console.log(`  \u26A0\uFE0F  Skipped ${label}: ${err.message}`);
  }
}

// ============================================================
// Section 2: Synthetic large payloads
// ============================================================
console.log("\n--- Synthetic large payloads ---");

// 2a. 100KB+ nested object with string values
{
  const obj = {};
  for (let i = 0; i < 200; i++) {
    obj[`field_${i}`] = {
      id: i,
      name: `User ${i}`,
      email: `user${i}@example.com`,
      bio: "Lorem ipsum dolor sit amet, ".repeat(10) + `entry #${i}`,
      tags: Array.from({ length: 5 }, (_, j) => `tag-${i}-${j}`),
      active: i % 3 !== 0,
      score: Math.round(Math.random() * 10000) / 100,
    };
  }
  const text = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(text);
  await testPayload("Synthetic 200-field nested object", text, bytes, obj);
}

// 2b. 200KB+ array of objects (AI tool-call sized)
{
  const items = Array.from({ length: 1000 }, (_, i) => ({
    id: i,
    tool: "file_edit",
    path: `/src/components/Widget${i}.tsx`,
    code: `function Widget${i}() {\n  return <div>Widget ${i}: ${"x".repeat(100)}</div>;\n}`,
    explanation: `Refactored widget ${i} to improve performance and readability.`,
  }));
  const text = JSON.stringify(items);
  const bytes = new TextEncoder().encode(text);
  await testPayload("Synthetic 1000-item tool-call array", text, bytes, items);
}

// 2c. Deeply nested structure (10 levels)
{
  let obj = { value: "leaf", items: [1, 2, 3] };
  for (let i = 0; i < 10; i++) {
    obj = { level: i, data: obj, siblings: Array.from({ length: 5 }, (_, j) => ({ idx: j, name: `sibling-${i}-${j}` })) };
  }
  const text = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(text);
  await testPayload("Synthetic 10-level deep nesting", text, bytes, obj);
}

// 2d. Large array of primitives (10,000 numbers)
{
  const arr = Array.from({ length: 10000 }, (_, i) => i * 1.1);
  const text = JSON.stringify(arr);
  const bytes = new TextEncoder().encode(text);
  await testPayload("Synthetic 10K-number array", text, bytes, arr);
}

// 2e. String-heavy payload with escapes (simulates LLM code output)
{
  const codeLines = Array.from({ length: 500 }, (_, i) =>
    `  const x${i} = "value\\n\\twith\\rescapes\\\\and\\"quotes";\n`
  );
  const payload = { language: "typescript", code: codeLines.join(""), lineCount: 500 };
  const text = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(text);
  await testPayload("Synthetic escape-heavy code payload", text, bytes, payload);
}

// 2f. 500KB stress test
{
  const bigArr = Array.from({ length: 2000 }, (_, i) => ({
    id: i,
    uuid: `${i.toString(16).padStart(8, "0")}-abcd-efgh-ijkl-${(i * 7).toString(16).padStart(12, "0")}`,
    data: { x: i * 0.1, y: i * 0.2, z: i * 0.3 },
    tags: [`a${i}`, `b${i}`, `c${i}`],
    nested: { deep: { value: i % 100 === 0 ? null : i } },
  }));
  const text = JSON.stringify(bigArr);
  const bytes = new TextEncoder().encode(text);
  await testPayload("Synthetic 500KB stress payload", text, bytes, bigArr);
}

// 2g. ~10MB stress test
{
  const arr = [];
  for (let i = 0; i < 40000; i++)
    arr.push({ id: i, name: `user_${i}`, email: `u${i}@test.com`, bio: "x".repeat(150), score: i * 0.01 });
  const text = JSON.stringify(arr);
  const bytes = new TextEncoder().encode(text);
  await testPayload("Synthetic ~10MB payload", text, bytes, arr);
}

// 2h. ~100MB stress test — proves we handle large inputs end-to-end
{
  const arr = [];
  for (let i = 0; i < 200000; i++)
    arr.push({
      id: i,
      content: "The quick brown fox jumps over the lazy dog. ".repeat(8) + `Record #${i}`,
      values: [i, i + 1, i + 2, i + 3, i + 4],
    });
  const text = JSON.stringify(arr);
  const bytes = new TextEncoder().encode(text);
  await testPayload("Synthetic ~100MB payload", text, bytes, arr);
}

// ============================================================
// Section 3: Streaming partial access on large data
// ============================================================
console.log("\n--- Streaming partial access (getValue mid-stream) ---");

await test("getValue mid-stream returns growing partial object", () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ id: i, name: `item-${i}` }));
  const text = JSON.stringify(items);
  const parser = vj.createParser();
  const chunkSize = 32;
  let lastLen = 0;

  for (let i = 0; i < text.length; i += chunkSize) {
    parser.feed(text.slice(i, i + chunkSize));
    const val = parser.getValue();
    if (val && Array.isArray(val)) {
      assert(val.length >= lastLen, `array should grow: ${val.length} < ${lastLen}`);
      lastLen = val.length;
    }
  }

  const final = parser.getValue();
  assertEqual(JSON.parse(JSON.stringify(final)), items);
  parser.destroy();
});

await test("EventParser onDelta collects full string from large payload", () => {
  const longCode = "function hello() {\n" + "  console.log('line');\n".repeat(200) + "}\n";
  const payload = JSON.stringify({ tool: "edit", code: longCode });
  const parser = vj.createEventParser();
  let collected = "";
  parser.onDelta("code", (e) => { collected += e.value; });

  for (let i = 0; i < payload.length; i += 16) {
    parser.feed(payload.slice(i, i + 16));
  }

  assertEqual(collected, longCode);
  parser.destroy();
});

// ============================================================
// Results
// ============================================================
console.log(`\n\u2728 Large JSON Stress Tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
