/**
 * VectorJSON — Real-World AI Usage Examples
 *
 * Shows how to use VectorJSON with:
 *   1. MCP stdio transport (JSONL)
 *   2. MCP Streamable HTTP (SSE + JSON responses)
 *   3. OpenAI Chat Completions streaming
 *   4. Anthropic Messages streaming
 *   5. Vercel AI SDK streamObject (partial JSON)
 *   6. Embeddings batch responses (JSONL)
 */

import { init, type VectorJSON, type ParseResult } from "../dist/index.js";

// ─────────────────────────────────────────────────────────
// 1. MCP STDIO Transport — newline-delimited JSON-RPC
// ─────────────────────────────────────────────────────────
//
// MCP stdio: each line on stdin/stdout is a complete JSON-RPC message.
// This is literally JSONL. VectorJSON's `complete_early` handles it.

async function mcpStdioExample(vj: VectorJSON) {
  // Simulates reading from a child process stdout
  const stdoutData = [
    '{"jsonrpc":"2.0","id":1,"result":{"capabilities":{"tools":{}}}}\n',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
    '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"Hello"}]}}\n',
  ].join("");

  // Parse all messages from the buffer
  const messages: unknown[] = [];
  let remaining: string | Uint8Array = stdoutData;

  while (remaining.length > 0) {
    const r = vj.parse(remaining);

    if (r.status === "complete" || r.status === "complete_early") {
      messages.push(r.toJSON()); // fast: JSON.parse internally
      if (r.remaining && r.remaining.byteLength > 0) {
        remaining = r.remaining; // pass Uint8Array directly — no decode needed
      } else {
        break;
      }
    } else if (r.status === "incomplete") {
      // Partial message — wait for more data from stdout
      break;
    } else {
      // invalid — skip this line, log error
      console.error("Invalid JSON-RPC message:", r.error);
      break;
    }
  }

  console.log("MCP stdio messages:", messages.length);
  // messages = [
  //   { jsonrpc: "2.0", id: 1, result: { capabilities: { tools: {} } } },
  //   { jsonrpc: "2.0", method: "notifications/initialized" },
  //   { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "Hello" }] } },
  // ]
}

// ─────────────────────────────────────────────────────────
// 2. MCP Streamable HTTP — SSE + JSON responses
// ─────────────────────────────────────────────────────────
//
// MCP Streamable HTTP POST can return:
//   - Content-Type: application/json → single JSON-RPC response
//   - Content-Type: text/event-stream → SSE stream of JSON-RPC messages
//
// SSE frames look like:
//   event: message\n
//   data: {"jsonrpc":"2.0","id":1,"result":{...}}\n
//   \n

async function mcpStreamableHttpExample(vj: VectorJSON) {
  // Step 1: Send JSON-RPC request
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "get_weather", arguments: { city: "Tokyo" } },
  };

  const response = await fetch("https://example.com/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Mcp-Session-Id": "abc-123",
    },
    body: JSON.stringify(request),
  });

  const contentType = response.headers.get("Content-Type") ?? "";

  // Step 2a: Single JSON response — just parse it
  if (contentType.includes("application/json")) {
    const body = new Uint8Array(await response.arrayBuffer());
    const r = vj.parse(body);
    if (r.status === "complete") {
      handleJsonRpcMessage(r.toJSON());
    }
    return;
  }

  // Step 2b: SSE stream — parse each frame
  if (contentType.includes("text/event-stream")) {
    // Read SSE frames from the response body
    for await (const message of readSSE(response.body!, vj)) {
      handleJsonRpcMessage(message);
    }
    return;
  }
}

/**
 * SSE frame parser — reassembles raw HTTP chunks into complete SSE events,
 * then extracts the `data:` payload and parses it with VectorJSON.
 *
 * SSE wire format:
 *   event: message\n
 *   data: {"jsonrpc":"2.0",...}\n
 *   \n                              ← empty line = frame boundary
 *
 * Key detail: HTTP chunked transfer can split an SSE frame across multiple
 * TCP packets. So we buffer raw text until we see `\n\n` (frame boundary).
 */
async function* readSSE(
  body: ReadableStream<Uint8Array>,
  vj: VectorJSON,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    // Process all complete SSE frames in the buffer
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      // Extract data: lines (SSE spec allows multi-line data)
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("data: ")) {
          dataLines.push(line.slice(6));
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5));
        }
        // Skip event:, id:, retry: lines — not JSON
      }

      if (dataLines.length === 0) continue;
      const payload = dataLines.join("\n");

      // Parse the JSON payload with VectorJSON
      const r = vj.parse(payload);
      if (r.status === "complete" || r.status === "complete_early") {
        yield r.toJSON();
      }
    }
  }
}

// ─────────────────────────────────────────────────────────
// 3. OpenAI Chat Completions — streaming SSE
// ─────────────────────────────────────────────────────────
//
// Wire format:
//   data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"}}]}
//   \n
//   data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"delta":{"content":" world"}}]}
//   \n
//   data: [DONE]
//   \n

async function openaiStreamExample(vj: VectorJSON) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer sk-...",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: "Say hello" }],
      stream: true,
    }),
  });

  let fullContent = "";

  for await (const event of readSSE(response.body!, vj)) {
    const chunk = event as any;
    // OpenAI: [DONE] is handled by readSSE (not valid JSON, parse returns invalid)
    if (!chunk?.choices?.[0]?.delta) continue;

    const delta = chunk.choices[0].delta;
    if (delta.content) {
      fullContent += delta.content;
      process.stdout.write(delta.content); // stream to terminal
    }
  }

  console.log("\n\nFull response:", fullContent);
}

// ─────────────────────────────────────────────────────────
// 4. Anthropic Messages — streaming SSE
// ─────────────────────────────────────────────────────────
//
// 👉 For a **runnable** version with EventParser field-level streaming,
//    early abort, and mock mode, see: examples/anthropic-tool-call.ts
//
// Wire format:
//   event: message_start
//   data: {"type":"message_start","message":{"id":"msg_...","model":"claude-3-opus-20240229",...}}
//   \n
//   event: content_block_delta
//   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
//   \n
//   event: message_stop
//   data: {"type":"message_stop"}

async function anthropicStreamExample(vj: VectorJSON) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": "sk-ant-...",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Say hello" }],
      stream: true,
    }),
  });

  let fullContent = "";

  for await (const event of readSSE(response.body!, vj)) {
    const data = event as any;

    switch (data.type) {
      case "content_block_delta":
        if (data.delta?.text) {
          fullContent += data.delta.text;
          process.stdout.write(data.delta.text);
        }
        break;
      case "message_stop":
        console.log("\n\nFull response:", fullContent);
        break;
    }
  }
}

// ─────────────────────────────────────────────────────────
// 5. Vercel AI SDK streamObject — partial JSON
// ─────────────────────────────────────────────────────────
//
// The AI SDK sends partial JSON that grows over time.
// Each SSE chunk contains the FULL JSON so far (not a delta).
// VectorJSON's `incomplete` status + `isComplete()` handles this.
//
// Wire format from AI SDK streamObject:
//   0:"{"
//   0:"\"users\":"
//   0:"[{\"name\":\"Alice\""
//   0:",\"age\":30}"
//   ...
//
// After reassembly, each accumulated string is partial JSON:
//   {"users":[{"name":"Alice","age":30},{"name":"Bo

interface User {
  name: string;
  age: number;
}

async function vercelStreamObjectExample(vj: VectorJSON) {
  // Simulated growing partial JSON (as the LLM generates tokens)
  const partialSnapshots = [
    '{"users":[{"name":"Alice"',
    '{"users":[{"name":"Alice","age":30}',
    '{"users":[{"name":"Alice","age":30},{"name":"Bob"',
    '{"users":[{"name":"Alice","age":30},{"name":"Bob","age":25}]}'
  ];

  for (const snapshot of partialSnapshots) {
    const r = vj.parse(snapshot);

    if (r.status === "incomplete" || r.status === "complete") {
      const data = r.value as any;

      // Render only complete elements to the UI
      if (data?.users) {
        for (const user of data.users) {
          if (r.isComplete(user)) {
            // This user object is fully present in the original input
            const { name, age } = user as User;
            console.log(`  ✓ ${name}, age ${age}`);
          } else {
            // Autocompleted placeholder — don't render yet
            console.log(`  … (streaming)`);
          }
        }
      }
    }

    // For complete status, toJSON() gives the fastest full materialization
    if (r.status === "complete") {
      const plain = r.toJSON() as { users: User[] };
      console.log("Final result:", plain.users);
    }
  }
}

// ─────────────────────────────────────────────────────────
// 6. Embeddings batch API — JSONL response
// ─────────────────────────────────────────────────────────
//
// OpenAI batch API or custom embedding services may return JSONL:
//   {"object":"embedding","index":0,"embedding":[0.1,0.2,...]}
//   {"object":"embedding","index":1,"embedding":[0.3,0.4,...]}

async function embeddingsBatchExample(vj: VectorJSON) {
  // Simulated JSONL response from embeddings API
  const responseBody =
    '{"object":"embedding","index":0,"embedding":[0.0023,-0.0091,0.0152]}\n' +
    '{"object":"embedding","index":1,"embedding":[0.0041,0.0073,-0.0029]}\n' +
    '{"object":"embedding","index":2,"embedding":[-0.0015,0.0088,0.0061]}\n';

  const embeddings: number[][] = [];
  let input: string | Uint8Array = responseBody;

  while (input.length > 0) {
    const r = vj.parse(input);
    if (r.status === "complete" || r.status === "complete_early") {
      const obj = r.toJSON() as { index: number; embedding: number[] };
      embeddings[obj.index] = obj.embedding;

      if (r.remaining && r.remaining.byteLength > 0) {
        input = r.remaining;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  console.log(`Parsed ${embeddings.length} embeddings`);
  // embeddings = [[0.0023, -0.0091, 0.0152], [0.0041, ...], [-0.0015, ...]]
}

// ─────────────────────────────────────────────────────────
// 7. Real fetch() + VectorJSON — end-to-end streaming
// ─────────────────────────────────────────────────────────
//
// This shows the full pattern: fetch() → ReadableStream → VectorJSON.
// Works with any SSE API (OpenAI, Anthropic, MCP, custom).

async function fullStreamingExample(vj: VectorJSON) {
  const response = await fetch("https://api.example.com/stream", {
    method: "POST",
    headers: {
      "Accept": "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "..." }),
  });

  if (!response.body) throw new Error("No response body");

  // Option A: SSE stream — use readSSE helper
  if (response.headers.get("Content-Type")?.includes("text/event-stream")) {
    for await (const message of readSSE(response.body, vj)) {
      console.log("SSE message:", message);
    }
    return;
  }

  // Option B: JSONL stream — accumulate chunks, parse with remaining
  const reader = response.body.getReader();
  let leftover = new Uint8Array(0);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    // Concatenate leftover + new chunk
    const combined = new Uint8Array(leftover.length + value.length);
    combined.set(leftover);
    combined.set(value, leftover.length);

    // Parse as many complete messages as possible
    let input: Uint8Array = combined;
    while (input.byteLength > 0) {
      const r = vj.parse(input);
      if (r.status === "complete" || r.status === "complete_early") {
        console.log("Message:", r.toJSON());
        if (r.remaining && r.remaining.byteLength > 0) {
          input = r.remaining;
        } else {
          input = new Uint8Array(0);
        }
      } else {
        // incomplete — save for next chunk
        leftover = input;
        break;
      }
    }
    if (input.byteLength === 0) leftover = new Uint8Array(0);
  }
}

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function handleJsonRpcMessage(msg: unknown) {
  const m = msg as any;
  if (m.method) {
    console.log(`JSON-RPC ${m.method}`, m.params ?? "");
  } else if (m.result !== undefined) {
    console.log(`JSON-RPC response #${m.id}:`, m.result);
  } else if (m.error) {
    console.error(`JSON-RPC error #${m.id}:`, m.error);
  }
}

// ─────────────────────────────────────────────────────────
// Run examples
// ─────────────────────────────────────────────────────────

async function main() {
  const vj = await init();

  console.log("=== 1. MCP STDIO (JSONL) ===");
  await mcpStdioExample(vj);

  console.log("\n=== 5. Vercel AI SDK streamObject ===");
  await vercelStreamObjectExample(vj);

  console.log("\n=== 6. Embeddings Batch (JSONL) ===");
  await embeddingsBatchExample(vj);

  // Examples 2-4, 7 require live API endpoints — shown for reference
  console.log("\n=== Examples 2-4, 7: require live endpoints (see source) ===");
}

main().catch(console.error);
