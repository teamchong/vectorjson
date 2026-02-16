/**
 * VectorJSON — Runnable OpenAI Function Call Example
 *
 * Demonstrates streaming a function call from the OpenAI Chat Completions API
 * using VectorJSON's EventParser for field-level events and early abort.
 *
 * Usage:
 *   # Real API:
 *   OPENAI_API_KEY=sk-... bun examples/openai-function-call.ts
 *
 *   # Mock mode (no API key needed):
 *   bun examples/openai-function-call.ts --mock
 *   bun examples/openai-function-call.ts          # auto-mocks when no key set
 *
 *   # Early abort demo:
 *   bun examples/openai-function-call.ts --mock --wrong-tool
 *
 * What this shows:
 *   1. Raw fetch() to OpenAI Chat Completions with streaming + function calling
 *   2. SSE frame parsing to extract `arguments` delta chunks
 *   3. VectorJSON EventParser for field-level callbacks as JSON streams in
 *   4. Early abort when the model picks an unexpected function
 */

import { init, type EventParser, type FeedStatus } from "../dist/index.js";

// ─────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────

const API_KEY = process.env.OPENAI_API_KEY;
const USE_MOCK = process.argv.includes("--mock") || !API_KEY;
const WRONG_TOOL_MODE = process.argv.includes("--wrong-tool");
const EXPECTED_FUNCTION = WRONG_TOOL_MODE ? "nonexistent_function" : "create_file";
const MODEL = "gpt-4o";

if (USE_MOCK && !process.argv.includes("--mock")) {
  console.log(
    "ℹ️  No OPENAI_API_KEY found — running in mock mode.\n" +
    "   Set OPENAI_API_KEY or pass --mock explicitly.\n"
  );
}

if (WRONG_TOOL_MODE) {
  console.log('⚡ --wrong-tool mode: expecting "nonexistent_function" to trigger early abort\n');
}

// ─────────────────────────────────────────────────────────
// SSE types & parser
// ─────────────────────────────────────────────────────────

interface SSEEvent {
  event: string;
  data: string;
}

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
// Mock SSE generator — simulates OpenAI function call stream
// ─────────────────────────────────────────────────────────

const MOCK_FILE_CONTENT = `import { createServer } from "http";

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
    return;
  }

  const match = req.url?.match(/^\\/greet\\/(.+)/);
  if (match) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: \`Hello, \${decodeURIComponent(match[1])}!\` }));
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
`;

function buildMockDeltas(): string[] {
  const fullJson = JSON.stringify({
    path: "src/server.ts",
    content: MOCK_FILE_CONTENT,
    description: "Create an HTTP server with health check and greeting endpoints.",
  });

  const deltas: string[] = [];
  let i = 0;
  while (i < fullJson.length) {
    const size = 4 + Math.floor(Math.random() * 27);
    deltas.push(fullJson.slice(i, i + size));
    i += size;
  }
  return deltas;
}

/**
 * OpenAI streaming format for function calls:
 *   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_...","type":"function","function":{"name":"create_file","arguments":""}}]}}]}
 *   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"pa"}}]}}]}
 *   ...
 *   data: [DONE]
 */
async function* mockSSEEvents(): AsyncGenerator<SSEEvent> {
  const deltas = buildMockDeltas();

  // First chunk: function name + empty arguments
  yield {
    event: "message",
    data: JSON.stringify({
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_mock_01",
            type: "function",
            function: { name: "create_file", arguments: "" },
          }],
        },
      }],
    }),
  };

  // Subsequent chunks: argument deltas
  for (const partial of deltas) {
    await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));

    yield {
      event: "message",
      data: JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: partial },
            }],
          },
        }],
      }),
    };
  }

  // [DONE]
  yield { event: "message", data: "[DONE]" };
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
    console.log("🧪 Running in mock mode (simulated OpenAI SSE stream)\n");
    sseSource = mockSSEEvents();
  } else {
    console.log("🚀 Sending request to OpenAI API...\n");

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: abort.signal,
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        messages: [
          {
            role: "user",
            content:
              "Use the create_file function to create a new file at src/server.ts with a simple Node.js HTTP server that has a health check endpoint and a greeting endpoint.",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "create_file",
              description: "Create a new file with the given content.",
              parameters: {
                type: "object",
                properties: {
                  path: {
                    type: "string",
                    description: "File path to create.",
                  },
                  content: {
                    type: "string",
                    description: "The full content of the file.",
                  },
                  description: {
                    type: "string",
                    description: "Brief explanation of what the file does.",
                  },
                },
                required: ["path", "content"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "create_file" } },
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
  let functionName: string | null = null;

  // Fire when "path" field completes
  parser.on("path", (event) => {
    console.log(`${elapsed()} 📂 Path: ${event.value}`);
  });

  // Stream "content" character-by-character via delta events
  parser.onDelta("content", (event) => {
    process.stdout.write(event.value);
  });

  // Skip "description" — we don't need it
  parser.skip("description");

  // ── Read SSE stream ─────────────────────────────────────

  let firstDelta = true;

  for await (const sse of sseSource) {
    if (sse.data === "[DONE]") break;

    let chunk: any;
    try {
      chunk = JSON.parse(sse.data);
    } catch {
      continue;
    }

    const delta = chunk.choices?.[0]?.delta;
    if (!delta?.tool_calls?.[0]) continue;

    const toolCall = delta.tool_calls[0];

    // Detect function name from the first chunk
    if (toolCall.function?.name && !functionName) {
      functionName = toolCall.function.name;
      console.log(`${elapsed()} 🔧 Function: ${functionName}`);

      // Early abort: if it's the wrong function, stop immediately
      if (functionName !== EXPECTED_FUNCTION) {
        console.log(`${elapsed()} ❌ Unexpected function "${functionName}" — aborting!`);
        parser.destroy();
        abort.abort();
        return;
      }
    }

    // Feed argument deltas to VectorJSON
    const args = toolCall.function?.arguments;
    if (args && args.length > 0) {
      totalBytes += args.length;
      totalChunks++;

      if (firstDelta) {
        console.log(`${elapsed()} 📝 Content streaming:`);
        firstDelta = false;
      }

      const status: FeedStatus = parser.feed(args);
      if (status === "complete" || status === "error") {
        break;
      }
    }
  }

  // ── Summary ─────────────────────────────────────────────

  console.log(); // newline after streamed content
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
