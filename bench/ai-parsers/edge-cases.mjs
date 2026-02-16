/**
 * Edge-case comparison: partial JSON parsing across AI SDK parsers
 *
 * Tests incomplete JSON fragments (as seen in LLM streaming) against:
 *   - Vercel AI SDK (parsePartialJson from 'ai')
 *   - TanStack/partial-json (parse from 'partial-json')
 *   - Anthropic SDK (partialParse, vendored parser)
 *   - VectorJSON parse() (status + value)
 *
 * Usage: bun bench/ai-parsers/edge-cases.mjs
 */

import { parsePartialJson as vercelParse } from "ai";
import { parse as partialJsonParse } from "partial-json";
import { partialParse as anthropicParse } from "@anthropic-ai/sdk/_vendor/partial-json-parser/parser.mjs";
import { init as vjInit } from "../../dist/index.js";

const vj = await vjInit();

// ── Test inputs ──────────────────────────────────────────

const testCases = [
  { label: '1.  object missing value',        input: '{"a": 1, "b": ' },
  { label: '2.  unterminated string',          input: '{"a": "hel' },
  { label: '3.  partial boolean',              input: '{"a": tr' },
  { label: '4.  partial number (trailing dot)',input: '{"a": 1.' },
  { label: '5.  unclosed array',               input: '[1, 2, 3' },
  { label: '6.  nested incomplete',            input: '{"a": [1, 2], "b": {"c": ' },
  { label: '7.  empty string (complete)',       input: '""' },
  { label: '8.  empty input',                  input: '' },
  { label: '9.  escaped quote',                input: '{"a": "hello\\""}' },
  { label: '10. escaped newline in string',    input: '{"a": "line1\\nline2' },
  { label: '11. null then incomplete',         input: '{"key": null, "other":' },
  { label: '12. array of objects, last incomplete', input: '[{"id": 1}, {"id": 2}, {"id":' },
];

// ── Helpers ──────────────────────────────────────────────

function trySync(fn) {
  try {
    const v = fn();
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function tryAsync(fn) {
  try {
    const v = await fn();
    return { ok: true, value: v };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function fmt(result) {
  if (!result.ok) return `THROW: ${result.error.slice(0, 70)}`;
  const v = result.value;
  if (v === undefined) return 'undefined';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function fmtVercel(result) {
  if (!result.ok) return `THROW: ${result.error.slice(0, 70)}`;
  const { value, state } = result.value;
  if (value === undefined) return `undefined  (state: ${state})`;
  try {
    return `${JSON.stringify(value)}  (state: ${state})`;
  } catch {
    return `${String(value)}  (state: ${state})`;
  }
}

function fmtVJ(result) {
  if (!result.ok) return `THROW: ${result.error.slice(0, 70)}`;
  const r = result.value;
  let valStr;
  try {
    // For proxied objects, use toJSON() or JSON.stringify
    valStr = r.value === undefined ? 'undefined' : JSON.stringify(r.value);
  } catch {
    valStr = String(r.value);
  }
  return `${valStr}  (status: ${r.status})`;
}

// ── Run tests ────────────────────────────────────────────

console.log("=".repeat(90));
console.log("  Partial JSON Edge-Case Comparison: AI SDK Parsers");
console.log("=".repeat(90));
console.log();

for (const tc of testCases) {
  const inputDisplay = tc.input === '' ? '(empty string)' : tc.input;
  console.log(`${"─".repeat(90)}`);
  console.log(`  ${tc.label}`);
  console.log(`  Input: ${inputDisplay}`);
  console.log(`${"─".repeat(90)}`);

  // Vercel AI SDK (async)
  const vercel = await tryAsync(() => vercelParse(tc.input));
  console.log(`  Vercel AI SDK:     ${fmtVercel(vercel)}`);

  // partial-json (TanStack uses this)
  const pj = trySync(() => partialJsonParse(tc.input));
  console.log(`  partial-json:      ${fmt(pj)}`);

  // Anthropic SDK
  const anthro = trySync(() => anthropicParse(tc.input));
  console.log(`  Anthropic SDK:     ${fmt(anthro)}`);

  // VectorJSON parse()
  const vjResult = trySync(() => vj.parse(tc.input));
  console.log(`  VectorJSON:        ${fmtVJ(vjResult)}`);

  console.log();
}

console.log("=".repeat(90));
console.log("  Legend:");
console.log("    THROW = parser threw an exception (error message follows)");
console.log("    state/status = parser's classification of the input");
console.log("=".repeat(90));
