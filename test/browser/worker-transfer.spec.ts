import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "../../dist");

/** Serve dist/ files and a blank HTML page via page.route. */
async function setupPage(page: import("@playwright/test").Page) {
  // Serve a minimal HTML page so fetch() has a real origin
  await page.route("http://localhost:3000/", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<!DOCTYPE html><html><body></body></html>",
    });
  });
  await page.route("http://localhost:3000/dist/**", async (route) => {
    const url = new URL(route.request().url());
    const filename = url.pathname.split("/dist/").pop()!;
    const body = await readFile(resolve(distDir, filename));
    const contentType = filename.endsWith(".wasm")
      ? "application/wasm"
      : filename.endsWith(".js")
        ? "application/javascript"
        : "application/octet-stream";
    await route.fulfill({ body, contentType });
  });
  await page.goto("http://localhost:3000/");
}

test.describe("Worker Transferable API", () => {
  test("getRawBuffer returns correct bytes via streaming parser", async ({
    page,
  }) => {
    await setupPage(page);

    const result = await page.evaluate(async () => {
      const wasmBytes = await fetch("/dist/engine.wasm").then((r) =>
        r.arrayBuffer()
      );
      const { instance } = await WebAssembly.instantiate(wasmBytes, {});
      const engine = instance.exports as any;

      const streamId = engine.stream_create();
      const json = '{"name":"Alice","age":30}';
      const encoded = new TextEncoder().encode(json);

      // Allocate and write to WASM memory
      const ptr = engine.alloc(encoded.length + 64) >>> 0;
      new Uint8Array(engine.memory.buffer, ptr, encoded.length).set(encoded);
      new Uint8Array(engine.memory.buffer, ptr + encoded.length, 64).fill(
        0x20
      );

      engine.stream_feed(streamId, ptr, encoded.length);
      engine.dealloc(ptr, encoded.length + 64);

      // Read buffer back (same as getRawBuffer implementation)
      const bufPtr = engine.stream_get_buffer_ptr(streamId) >>> 0;
      const bufLen = engine.stream_get_buffer_len(streamId);
      const copy = new ArrayBuffer(bufLen);
      new Uint8Array(copy).set(
        new Uint8Array(engine.memory.buffer, bufPtr, bufLen)
      );

      engine.stream_destroy(streamId);

      // Verify the copied buffer matches the input
      const decoded = new TextDecoder().decode(new Uint8Array(copy));
      return { decoded, bufLen, inputLen: encoded.length };
    });

    expect(result.decoded).toBe('{"name":"Alice","age":30}');
    expect(result.bufLen).toBe(result.inputLen);
  });

  test("ArrayBuffer survives postMessage transferable round-trip", async ({
    page,
  }) => {
    await setupPage(page);

    const result = await page.evaluate(async () => {
      const json =
        '{"tool":"str_replace_editor","input":{"command":"create"}}';
      const encoded = new TextEncoder().encode(json);

      // Simulate getRawBuffer: create a standalone ArrayBuffer
      const buf = new ArrayBuffer(encoded.length);
      new Uint8Array(buf).set(encoded);
      const originalLen = buf.byteLength;

      // Transfer to a Worker and back
      const workerCode = `
        self.onmessage = (e) => {
          const buf = e.data;
          // Worker receives the transferred buffer, sends it back
          self.postMessage(buf, [buf]);
        };
      `;
      const blob = new Blob([workerCode], { type: "application/javascript" });
      const worker = new Worker(URL.createObjectURL(blob));

      const received = await new Promise<ArrayBuffer>((resolve) => {
        worker.onmessage = (e) => resolve(e.data);
        worker.postMessage(buf, [buf]);
      });

      worker.terminate();

      // Verify: original buffer is detached, received buffer has the data
      const originalDetached = buf.byteLength === 0; // detached after transfer
      const decoded = new TextDecoder().decode(new Uint8Array(received));
      return {
        originalDetached,
        decoded,
        receivedLen: received.byteLength,
        originalLen,
      };
    });

    expect(result.originalDetached).toBe(true);
    expect(result.decoded).toBe(
      '{"tool":"str_replace_editor","input":{"command":"create"}}'
    );
    expect(result.receivedLen).toBe(result.originalLen);
  });

  test("Worker parses with VectorJSON, transfers raw buffer, main thread re-parses", async ({
    page,
  }) => {
    await setupPage(page);

    const result = await page.evaluate(async () => {
      const wasmBytes = await fetch("/dist/engine.wasm").then((r) =>
        r.arrayBuffer()
      );

      // Encode the WASM bytes as base64 to pass into Worker
      const wasmB64 = btoa(
        String.fromCharCode(...new Uint8Array(wasmBytes))
      );

      const json = JSON.stringify({
        type: "tool_use",
        id: "toolu_01A09q90qw90lq917835lq9",
        name: "str_replace_editor",
        input: {
          command: "create",
          path: "/src/app.tsx",
          file_text: "console.log('hello');",
        },
      });

      const workerCode = `
        self.onmessage = async (e) => {
          const { wasmB64, jsonStr } = e.data;
          // Decode WASM bytes
          const wasmBytes = Uint8Array.from(atob(wasmB64), c => c.charCodeAt(0));
          const { instance } = await WebAssembly.instantiate(wasmBytes, {});
          const engine = instance.exports;

          // Create stream parser and feed JSON
          const streamId = engine.stream_create();
          const encoded = new TextEncoder().encode(jsonStr);
          const ptr = engine.alloc(encoded.length + 64) >>> 0;
          new Uint8Array(engine.memory.buffer, ptr, encoded.length).set(encoded);
          new Uint8Array(engine.memory.buffer, ptr + encoded.length, 64).fill(0x20);
          engine.stream_feed(streamId, ptr, encoded.length);
          engine.dealloc(ptr, encoded.length + 64);

          // getRawBuffer equivalent
          const bufPtr = engine.stream_get_buffer_ptr(streamId) >>> 0;
          const bufLen = engine.stream_get_buffer_len(streamId);
          const copy = new ArrayBuffer(bufLen);
          new Uint8Array(copy).set(new Uint8Array(engine.memory.buffer, bufPtr, bufLen));

          engine.stream_destroy(streamId);

          // Transfer (O(1)) instead of structured clone
          self.postMessage(copy, [copy]);
        };
      `;

      const blob = new Blob([workerCode], { type: "application/javascript" });
      const worker = new Worker(URL.createObjectURL(blob));

      const transferred = await new Promise<ArrayBuffer>((resolve) => {
        worker.onmessage = (e) => resolve(e.data);
        worker.postMessage({ wasmB64, jsonStr: json });
      });

      worker.terminate();

      // Verify by re-parsing with JSON.parse (the transferred bytes are valid JSON)
      const bytes = new Uint8Array(transferred);
      const decoded = new TextDecoder().decode(bytes);
      const parsed = JSON.parse(decoded);

      return {
        name: parsed.name,
        command: parsed.input.command,
        path: parsed.input.path,
        fileText: parsed.input.file_text,
        transferredSize: transferred.byteLength,
      };
    });

    expect(result).not.toHaveProperty("error");
    expect((result as any).name).toBe("str_replace_editor");
    expect((result as any).command).toBe("create");
    expect((result as any).path).toBe("/src/app.tsx");
    expect((result as any).fileText).toBe("console.log('hello');");
  });

  test("transferred buffer produces same values as direct parse", async ({
    page,
  }) => {
    await setupPage(page);

    const result = await page.evaluate(async () => {
      const wasmBytes = await fetch("/dist/engine.wasm").then((r) =>
        r.arrayBuffer()
      );

      const testData = {
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hello world" },
          },
        ],
        model: "gpt-4",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      };
      const json = JSON.stringify(testData);
      const encoded = new TextEncoder().encode(json);

      // Direct parse
      const { instance: inst1 } = await WebAssembly.instantiate(
        wasmBytes.slice(0),
        {}
      );
      const eng1 = inst1.exports as any;
      const ptr1 = eng1.alloc(encoded.length + 64) >>> 0;
      new Uint8Array(eng1.memory.buffer, ptr1, encoded.length).set(encoded);
      new Uint8Array(eng1.memory.buffer, ptr1 + encoded.length, 64).fill(
        0x20
      );
      const streamId = eng1.stream_create();
      eng1.stream_feed(streamId, ptr1, encoded.length);

      // getRawBuffer
      const bufPtr = eng1.stream_get_buffer_ptr(streamId) >>> 0;
      const bufLen = eng1.stream_get_buffer_len(streamId);
      const rawBuf = new ArrayBuffer(bufLen);
      new Uint8Array(rawBuf).set(
        new Uint8Array(eng1.memory.buffer, bufPtr, bufLen)
      );
      eng1.stream_destroy(streamId);
      eng1.dealloc(ptr1, encoded.length + 64);

      // Parse from transferred buffer
      const rawBytes = new Uint8Array(rawBuf);
      const directParsed = JSON.parse(json);
      const transferParsed = JSON.parse(new TextDecoder().decode(rawBytes));

      return {
        match: JSON.stringify(directParsed) === JSON.stringify(transferParsed),
        directModel: directParsed.model,
        transferModel: transferParsed.model,
        directTokens: directParsed.usage.total_tokens,
        transferTokens: transferParsed.usage.total_tokens,
      };
    });

    expect(result.match).toBe(true);
    expect(result.directModel).toBe("gpt-4");
    expect(result.transferModel).toBe("gpt-4");
    expect(result.directTokens).toBe(15);
    expect(result.transferTokens).toBe(15);
  });
});
