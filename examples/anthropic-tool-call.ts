/**
 * VectorJSON — Runnable Anthropic Tool Call Example
 *
 * Demonstrates streaming a tool call from the Anthropic Messages API
 * using VectorJSON's EventParser for field-level events and early abort.
 *
 * Usage:
 *   # Real API:
 *   ANTHROPIC_API_KEY=sk-ant-... bun examples/anthropic-tool-call.ts
 *
 *   # Mock mode (no API key needed):
 *   bun examples/anthropic-tool-call.ts --mock
 *   bun examples/anthropic-tool-call.ts          # auto-mocks when no key set
 *
 *   # Early abort demo:
 *   bun examples/anthropic-tool-call.ts --mock --wrong-tool
 *
 * What this shows:
 *   1. Raw fetch() to Anthropic Messages API with streaming + tool use
 *   2. SSE frame parsing to extract `input_json_delta` chunks
 *   3. VectorJSON EventParser for field-level callbacks as JSON streams in
 *   4. Early abort when the model picks an unexpected tool
 */

import { init, type EventParser, type FeedStatus } from "../dist/index.js";

// ─────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────

const API_KEY = process.env.ANTHROPIC_API_KEY;
const USE_MOCK =
  process.argv.includes("--mock") || !API_KEY;

if (USE_MOCK && !process.argv.includes("--mock")) {
  console.log(
    "ℹ️  No ANTHROPIC_API_KEY found — running in mock mode.\n" +
    "   Set ANTHROPIC_API_KEY or pass --mock explicitly.\n"
  );
}

const WRONG_TOOL_MODE = process.argv.includes("--wrong-tool");
const EXPECTED_TOOL = WRONG_TOOL_MODE ? "nonexistent_tool" : "str_replace_editor";
const MODEL = "claude-sonnet-4-20250514";

if (WRONG_TOOL_MODE) {
  console.log("⚡ --wrong-tool mode: expecting \"nonexistent_tool\" to trigger early abort\n");
}

// ─────────────────────────────────────────────────────────
// SSE types
// ─────────────────────────────────────────────────────────

interface SSEEvent {
  event: string;
  data: string;
}

// ─────────────────────────────────────────────────────────
// SSE parser — yields raw { event, data } from a stream
// ─────────────────────────────────────────────────────────

async function* readSSEEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let event = "message";
      const dataLines: string[] = [];

      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) {
          event = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          dataLines.push(line.slice(6));
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5));
        }
      }

      if (dataLines.length > 0) {
        yield { event, data: dataLines.join("\n") };
      }
    }
  }
}

// ─────────────────────────────────────────────────────────
// Mock SSE generator — simulates Anthropic tool call stream
// ─────────────────────────────────────────────────────────

const MOCK_FILE_TEXT = `import express from "express";

const app = express();
const PORT = 3000;

app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.get("/greet/:name", (req, res) => {
  res.json({ message: \`Hello, \${req.params.name}!\` });
});

app.listen(PORT, () => {
  console.log(\`Server running on http://localhost:\${PORT}\`);
});
`;

/**
 * Builds the full JSON tool input, then splits it into realistic
 * variable-size chunks — mimicking how the Anthropic API sends
 * `input_json_delta` fragments over SSE.
 */
function buildMockDeltas(): string[] {
  const fullJson = JSON.stringify({
    command: "create",
    path: "src/app.ts",
    file_text: MOCK_FILE_TEXT,
    explanation: "Create an Express server with health check and greeting endpoints.",
  });

  // Split into variable-size chunks (4–30 chars) to look realistic
  const deltas: string[] = [];
  let i = 0;
  while (i < fullJson.length) {
    const size = 4 + Math.floor(Math.random() * 27);
    deltas.push(fullJson.slice(i, i + size));
    i += size;
  }
  return deltas;
}

async function* mockSSEEvents(): AsyncGenerator<SSEEvent> {
  const deltas = buildMockDeltas();

  // content_block_start
  yield {
    event: "content_block_start",
    data: JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_mock_01",
        name: "str_replace_editor",
        input: {},
      },
    }),
  };

  // content_block_delta — one per JSON chunk
  for (const partial of deltas) {
    // Simulate network latency (5–25ms between chunks)
    await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));

    yield {
      event: "content_block_delta",
      data: JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: partial },
      }),
    };
  }

  // content_block_stop
  yield {
    event: "content_block_stop",
    data: JSON.stringify({ type: "content_block_stop", index: 0 }),
  };
}

// ─────────────────────────────────────────────────────────
// Timestamp helper
// ─────────────────────────────────────────────────────────

function makeTimer() {
  const start = performance.now();
  return () => `[${Math.round(performance.now() - start)}ms]`.padEnd(10);
}

// ─────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────

async function main() {
  const vj = await init();
  const elapsed = makeTimer();

  const abort = new AbortController();

  // ── Get SSE events (real API or mock) ───────────────────

  let sseSource: AsyncGenerator<SSEEvent>;

  if (USE_MOCK) {
    console.log("🧪 Running in mock mode (simulated Anthropic SSE stream)\n");
    sseSource = mockSSEEvents();
  } else {
    console.log("🚀 Sending request to Anthropic API...\n");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: abort.signal,
      headers: {
        "x-api-key": API_KEY!,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        stream: true,
        messages: [
          {
            role: "user",
            content:
              "Use the str_replace_editor tool to create a new file at src/app.ts with a simple Express server that has a health check endpoint and a greeting endpoint.",
          },
        ],
        tools: [
          {
            name: "str_replace_editor",
            description:
              "Create or edit files. Use command='create' to write a new file, or command='str_replace' to edit an existing file.",
            input_schema: {
              type: "object",
              properties: {
                command: {
                  type: "string",
                  enum: ["create", "str_replace"],
                  description: "The operation to perform.",
                },
                path: {
                  type: "string",
                  description: "Absolute path to the file.",
                },
                file_text: {
                  type: "string",
                  description: "The full content of the file to create.",
                },
                explanation: {
                  type: "string",
                  description: "Brief explanation of the change.",
                },
              },
              required: ["command", "path"],
            },
          },
        ],
        tool_choice: { type: "tool", name: "str_replace_editor" },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`❌ API error ${response.status}: ${err}`);
      process.exit(1);
    }

    sseSource = readSSEEvents(response.body!);
  }

  // ── Set up the EventParser ──────────────────────────────

  const parser: EventParser = vj.createEventParser();
  let totalBytes = 0;
  let totalChunks = 0;
  let toolName: string | null = null;

  // Fire when "command" field completes
  parser.on("command", (event) => {
    console.log(`${elapsed()} 🔧 Command: ${event.value}`);
  });

  // Fire when "path" field completes
  parser.on("path", (event) => {
    console.log(`${elapsed()} 📂 Path: ${event.value}`);
  });

  // Stream "file_text" character-by-character via delta events
  parser.onDelta("file_text", (event) => {
    process.stdout.write(event.value);
  });

  // Skip "explanation" — we don't need it, save processing time
  parser.skip("explanation");

  // ── Read SSE stream ─────────────────────────────────────

  let firstDelta = true;

  for await (const sse of sseSource) {
    // Anthropic SSE event types we care about:
    //   content_block_start  → has tool name + id
    //   content_block_delta  → has partial_json chunks
    //   content_block_stop   → block done

    if (sse.event === "content_block_start") {
      const block = JSON.parse(sse.data);
      if (block.content_block?.type === "tool_use") {
        toolName = block.content_block.name;
        console.log(`${elapsed()} 🔧 Tool: ${toolName}`);

        // Early abort: if it's the wrong tool, stop immediately
        if (toolName !== EXPECTED_TOOL) {
          console.log(`${elapsed()} ❌ Unexpected tool "${toolName}" — aborting!`);
          parser.destroy();
          abort.abort();
          return;
        }
      }
      continue;
    }

    if (sse.event === "content_block_delta") {
      const delta = JSON.parse(sse.data);
      if (delta.delta?.type === "input_json_delta") {
        const chunk = delta.delta.partial_json;
        totalBytes += chunk.length;
        totalChunks++;

        if (firstDelta) {
          console.log(`${elapsed()} 📝 Code streaming:`);
          firstDelta = false;
        }

        // Feed the raw JSON fragment to VectorJSON
        const status: FeedStatus = parser.feed(chunk);
        if (status === "complete" || status === "error") {
          break;
        }
      }
      continue;
    }

    if (sse.event === "content_block_stop") {
      break;
    }
  }

  // ── Summary ─────────────────────────────────────────────

  console.log(); // newline after streamed code
  console.log(
    `${elapsed()} ✅ Complete (${totalBytes} bytes, ${totalChunks} chunks)`
  );

  parser.destroy();
}

main().catch((err) => {
  if (err.name === "AbortError") {
    console.log("\n⛔ Request aborted.");
  } else {
    console.error(err);
    process.exit(1);
  }
});
