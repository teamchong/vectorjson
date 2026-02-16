/**
 * Time-to-First-Action Benchmark
 *
 * Simulates an LLM streaming a tool_use content block (Anthropic API format)
 * and measures how soon each approach can deliver actionable fields.
 *
 * This is the metric that matters for agent UX: how fast can the agent
 * start acting on the response?
 *
 * Usage:
 *   bun --expose-gc bench/time-to-first-action.mjs
 */
import { init } from "../dist/index.js";
import { parse as partialParse } from "./ai-parsers/node_modules/partial-json/dist/index.js";

const vj = await init();

function formatTime(ms) {
  if (ms < 0.001) return (ms * 1e6).toFixed(0) + " ns";
  if (ms < 1) return (ms * 1e3).toFixed(1) + " µs";
  if (ms < 1000) return ms.toFixed(1) + " ms";
  return (ms / 1000).toFixed(2) + " s";
}

/**
 * Generate a realistic Anthropic tool_use content block.
 * Matches the shape Claude returns when using tools:
 *   { type, id, name, input: { command?, file_path?, content? } }
 */
function makeToolUseBlock(contentSize) {
  // Realistic code content that an agent would stream to an editor
  const lines = [];
  lines.push("import React, { useState, useEffect } from 'react';");
  lines.push("import { fetchUserData, updateProfile } from '../api/users';");
  lines.push("import { Button, Input, Card, Spinner } from '../components/ui';");
  lines.push("");
  lines.push("interface UserProfile {");
  lines.push("  id: string;");
  lines.push("  name: string;");
  lines.push("  email: string;");
  lines.push("  avatar: string;");
  lines.push("  bio: string;");
  lines.push("}");
  lines.push("");
  lines.push("export function ProfileEditor({ userId }: { userId: string }) {");
  lines.push("  const [profile, setProfile] = useState<UserProfile | null>(null);");
  lines.push("  const [loading, setLoading] = useState(true);");
  lines.push("  const [saving, setSaving] = useState(false);");
  lines.push("  const [error, setError] = useState<string | null>(null);");
  lines.push("");
  lines.push("  useEffect(() => {");
  lines.push("    fetchUserData(userId)");
  lines.push("      .then(data => { setProfile(data); setLoading(false); })");
  lines.push("      .catch(err => { setError(err.message); setLoading(false); });");
  lines.push("  }, [userId]);");
  lines.push("");

  // Pad to target size with realistic-looking code
  while (lines.join("\n").length < contentSize) {
    const i = lines.length;
    lines.push(`  const handleField${i} = (value: string) => {`);
    lines.push(`    setProfile(prev => prev ? { ...prev, field${i}: value } : null);`);
    lines.push(`    if (value.length > 100) setError('Field ${i} too long');`);
    lines.push(`  };`);
    lines.push("");
  }

  lines.push("  if (loading) return <Spinner />;");
  lines.push("  if (error) return <Card variant=\"error\">{error}</Card>;");
  lines.push("  return <div>{/* render form */}</div>;");
  lines.push("}");

  const content = lines.join("\n").slice(0, contentSize);

  // Anthropic tool_use content block format
  return JSON.stringify({
    type: "tool_use",
    id: "toolu_01A09q90qw90lq917835lq9",
    name: "str_replace_editor",
    input: {
      command: "create",
      path: "/src/components/ProfileEditor.tsx",
      file_text: content,
    },
  });
}

// Simulate LLM streaming: ~12 chars per chunk (typical token size)
function chunkify(text, chunkSize = 12) {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

console.log("\n╔═════════════════════════════════════════════════════════════════════════════╗");
console.log("║         Time-to-First-Action — When Can the Agent Start Acting?            ║");
console.log("║                                                                             ║");
console.log("║   Payload: Anthropic tool_use content block (str_replace_editor)            ║");
console.log("║   Chunks:  ~12 chars (typical LLM token)                                   ║");
console.log("╚═════════════════════════════════════════════════════════════════════════════╝\n");

// Default sizes; pass --large for 500KB+1MB (takes minutes for stock parser)
const large = process.argv.includes("--large");
const sizes = large ? [1, 10, 50, 100, 500, 1000] : [1, 10, 50, 100];

for (const sizeKB of sizes) {
  const payload = makeToolUseBlock(sizeKB * 1024);
  const chunks = chunkify(payload);
  const totalChunks = chunks.length;
  const sizeStr = (payload.length / 1024).toFixed(1);

  console.log(`  ─── ${sizeStr} KB payload, ${totalChunks} chunks ───`);

  // Field paths matching Anthropic tool_use format
  const nameField = "name";         // tool name: "str_replace_editor"
  const commandField = "input";     // first field of input object
  const contentField = "input";     // input.file_text (the big field)

  // --- Stock approach: buffer += chunk; parsePartialJson(buffer) ---
  {
    let buffer = "";
    let firstNameChunk = -1;
    let firstNameTime = 0;
    let firstInputChunk = -1;
    let firstInputTime = 0;
    let totalTime = 0;
    const t0 = performance.now();
    for (let i = 0; i < chunks.length; i++) {
      buffer += chunks[i];
      const result = partialParse(buffer);
      if (result && typeof result === "object") {
        if (firstNameChunk === -1 && result.name) {
          firstNameChunk = i + 1;
          firstNameTime = performance.now() - t0;
        }
        if (firstInputChunk === -1 && result.input && result.input.command) {
          firstInputChunk = i + 1;
          firstInputTime = performance.now() - t0;
        }
      }
    }
    totalTime = performance.now() - t0;
    console.log(
      `  Stock (parsePartialJson)     .name at chunk ${String(firstNameChunk).padStart(5)}/${totalChunks}` +
      `  after ${formatTime(firstNameTime).padStart(8)}` +
      `  total ${formatTime(totalTime).padStart(8)}`
    );
    if (firstInputChunk > 0) {
      console.log(
        `    └─ .input.command          at chunk ${String(firstInputChunk).padStart(5)}/${totalChunks}` +
        `  after ${formatTime(firstInputTime).padStart(8)}`
      );
    }
  }

  // --- VectorJSON createParser ---
  {
    const parser = vj.createParser();
    let firstNameChunk = -1;
    let firstNameTime = 0;
    let totalTime = 0;
    const t0 = performance.now();
    for (let i = 0; i < chunks.length; i++) {
      parser.feed(chunks[i]);
      const val = parser.getValue();
      if (firstNameChunk === -1 && val && typeof val === "object" && val.name) {
        firstNameChunk = i + 1;
        firstNameTime = performance.now() - t0;
      }
    }
    totalTime = performance.now() - t0;
    parser.destroy();
    console.log(
      `  VectorJSON (createParser)    .name at chunk ${String(firstNameChunk).padStart(5)}/${totalChunks}` +
      `  after ${formatTime(firstNameTime).padStart(8)}` +
      `  total ${formatTime(totalTime).padStart(8)}`
    );
  }

  // --- VectorJSON EventParser ---
  {
    const parser = vj.createEventParser();
    let firstNameChunk = -1;
    let firstNameTime = 0;
    let firstCommandChunk = -1;
    let firstCommandTime = 0;
    let firstDeltaChunk = -1;
    let firstDeltaTime = 0;
    let totalTime = 0;
    const t0 = performance.now();

    parser.on("name", () => {
      if (firstNameChunk === -1) {
        firstNameChunk = currentChunk;
        firstNameTime = performance.now() - t0;
      }
    });
    parser.on("input.command", () => {
      if (firstCommandChunk === -1) {
        firstCommandChunk = currentChunk;
        firstCommandTime = performance.now() - t0;
      }
    });
    parser.onDelta("input.file_text", () => {
      if (firstDeltaChunk === -1) {
        firstDeltaChunk = currentChunk;
        firstDeltaTime = performance.now() - t0;
      }
    });

    let currentChunk = 0;
    for (let i = 0; i < chunks.length; i++) {
      currentChunk = i + 1;
      parser.feed(chunks[i]);
    }
    totalTime = performance.now() - t0;
    parser.destroy();

    console.log(
      `  VectorJSON (EventParser)     .name at chunk ${String(firstNameChunk).padStart(5)}/${totalChunks}` +
      `  after ${formatTime(firstNameTime).padStart(8)}` +
      `  total ${formatTime(totalTime).padStart(8)}`
    );
    if (firstCommandChunk > 0) {
      console.log(
        `    └─ .input.command          at chunk ${String(firstCommandChunk).padStart(5)}/${totalChunks}` +
        `  after ${formatTime(firstCommandTime).padStart(8)}`
      );
    }
    if (firstDeltaChunk > 0) {
      console.log(
        `    └─ first file_text delta   at chunk ${String(firstDeltaChunk).padStart(5)}/${totalChunks}` +
        `  after ${formatTime(firstDeltaTime).padStart(8)}`
      );
    }
  }
  console.log();
}

// Summary
console.log("  The .name field arrives early for all approaches — the LLM hasn't");
console.log("  streamed much yet. But the total processing time reveals the cost:");
console.log("  stock parsers re-parse the entire growing buffer on every chunk,");
console.log("  blocking the main thread for seconds at 100KB. VectorJSON processes");
console.log("  all chunks in milliseconds — the agent's thread stays free to render");
console.log("  UI, stream code to the editor, and start running tools.");
console.log();
