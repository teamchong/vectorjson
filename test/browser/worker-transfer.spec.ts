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
      // Chunked encoding to avoid stack overflow from spread on large arrays
      const wasmU8 = new Uint8Array(wasmBytes);
      let wasmBin = '';
      for (let i = 0; i < wasmU8.length; i += 8192) {
        wasmBin += String.fromCharCode(...wasmU8.subarray(i, i + 8192));
      }
      const wasmB64 = btoa(wasmBin);

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

test.describe("Tape Transfer API", () => {
  /** WASM helpers injected into page.evaluate — parse, export tape, import tape, find field, read string. */
  const WASM_HELPERS = `
    function wasmParse(engine, json) {
      const encoded = new TextEncoder().encode(json);
      const ptr = engine.alloc(encoded.length + 64) >>> 0;
      new Uint8Array(engine.memory.buffer, ptr, encoded.length).set(encoded);
      new Uint8Array(engine.memory.buffer, ptr + encoded.length, 64).fill(0x20);
      const docId = engine.doc_parse(ptr, encoded.length);
      engine.dealloc(ptr, encoded.length + 64);
      return docId;
    }
    function wasmExportTape(engine, docId) {
      const size = engine.doc_export_tape_size(docId);
      const outPtr = engine.alloc(size) >>> 0;
      engine.doc_export_tape(docId, outPtr, size);
      const buf = new ArrayBuffer(size);
      new Uint8Array(buf).set(new Uint8Array(engine.memory.buffer, outPtr, size));
      engine.dealloc(outPtr, size);
      return buf;
    }
    function wasmImportTape(engine, tapeBuf) {
      const ptr = engine.alloc(tapeBuf.byteLength) >>> 0;
      new Uint8Array(engine.memory.buffer, ptr, tapeBuf.byteLength).set(new Uint8Array(tapeBuf));
      const docId = engine.doc_import_tape(ptr, tapeBuf.byteLength);
      engine.dealloc(ptr, tapeBuf.byteLength);
      return docId;
    }
    function wasmFindField(engine, docId, objIdx, key) {
      const k = new TextEncoder().encode(key);
      const ptr = engine.alloc(k.length) >>> 0;
      new Uint8Array(engine.memory.buffer, ptr, k.length).set(k);
      const idx = engine.doc_find_field(docId, objIdx, ptr, k.length);
      engine.dealloc(ptr, k.length);
      return idx;
    }
    function wasmReadString(engine, docId, idx) {
      const rawLen = engine.doc_read_string_raw(docId, idx);
      if (rawLen === 0) return "";
      const batchPtr = engine.doc_batch_ptr() >>> 0;
      const srcOffset = new Uint32Array(engine.memory.buffer, batchPtr, 1)[0];
      const inputPtr = engine.doc_get_input_ptr(docId) >>> 0;
      return new TextDecoder().decode(new Uint8Array(engine.memory.buffer, inputPtr + srcOffset, rawLen));
    }
  `;

  test("doc_export_tape → doc_import_tape round-trip preserves values", async ({
    page,
  }) => {
    await setupPage(page);

    const result = await page.evaluate(new Function("return (async () => {" + WASM_HELPERS + `
      const wasmBytes = await fetch("/dist/engine.wasm").then(r => r.arrayBuffer());
      const { instance } = await WebAssembly.instantiate(wasmBytes, {});
      const engine = instance.exports;

      const docId = wasmParse(engine, '{"name":"Alice","age":30,"nested":{"x":[1,2,3]}}');
      if (docId < 0) return { error: "parse failed" };

      const tapeBuf = wasmExportTape(engine, docId);
      engine.doc_free(docId);

      const newDocId = wasmImportTape(engine, tapeBuf);
      if (newDocId < 0) return { error: "import failed" };

      const result = {
        rootTag: engine.doc_get_tag(newDocId, 1),
        count: engine.doc_get_count(newDocId, 1),
        nameStr: wasmReadString(engine, newDocId, wasmFindField(engine, newDocId, 1, "name")),
        ageVal: engine.doc_get_number(newDocId, wasmFindField(engine, newDocId, 1, "age")),
      };
      engine.doc_free(newDocId);
      return result;
    })()`) as any);

    expect(result).not.toHaveProperty("error");
    expect((result as any).rootTag).toBe(5);
    expect((result as any).count).toBe(3);
    expect((result as any).nameStr).toBe("Alice");
    expect((result as any).ageVal).toBe(30);
  });

  test("tape transfer via Worker produces correct values", async ({ page }) => {
    await setupPage(page);

    const result = await page.evaluate(new Function("return (async () => {" + WASM_HELPERS + `
      const wasmBytes = await fetch("/dist/engine.wasm").then(r => r.arrayBuffer());
      const wasmU8 = new Uint8Array(wasmBytes);
      let wasmBin = "";
      for (let i = 0; i < wasmU8.length; i += 8192)
        wasmBin += String.fromCharCode(...wasmU8.subarray(i, i + 8192));
      const wasmB64 = btoa(wasmBin);

      const json = JSON.stringify({
        type: "tool_use", name: "str_replace_editor",
        input: { command: "create", path: "/src/app.tsx" },
        flag: true, nothing: null,
      });

      const workerCode = \`
        self.onmessage = async (e) => {
          const { wasmB64, jsonStr } = e.data;
          const wasmBytes = Uint8Array.from(atob(wasmB64), c => c.charCodeAt(0));
          const { instance } = await WebAssembly.instantiate(wasmBytes, {});
          const engine = instance.exports;
          const encoded = new TextEncoder().encode(jsonStr);
          const ptr = engine.alloc(encoded.length + 64) >>> 0;
          new Uint8Array(engine.memory.buffer, ptr, encoded.length).set(encoded);
          new Uint8Array(engine.memory.buffer, ptr + encoded.length, 64).fill(0x20);
          const docId = engine.doc_parse(ptr, encoded.length);
          engine.dealloc(ptr, encoded.length + 64);
          const size = engine.doc_export_tape_size(docId);
          const outPtr = engine.alloc(size) >>> 0;
          engine.doc_export_tape(docId, outPtr, size);
          const tapeBuf = new ArrayBuffer(size);
          new Uint8Array(tapeBuf).set(new Uint8Array(engine.memory.buffer, outPtr, size));
          engine.dealloc(outPtr, size);
          engine.doc_free(docId);
          self.postMessage(tapeBuf, [tapeBuf]);
        };
      \`;

      const blob = new Blob([workerCode], { type: "application/javascript" });
      const worker = new Worker(URL.createObjectURL(blob));
      const tapeBuf = await new Promise(resolve => {
        worker.onmessage = (e) => resolve(e.data);
        worker.postMessage({ wasmB64, jsonStr: json });
      });
      worker.terminate();

      // Import on main thread
      const { instance: mainInst } = await WebAssembly.instantiate(
        await fetch("/dist/engine.wasm").then(r => r.arrayBuffer()), {}
      );
      const me = mainInst.exports;
      const docId = wasmImportTape(me, tapeBuf);
      if (docId < 0) return { error: "import failed" };

      const result = {
        rootTag: me.doc_get_tag(docId, 1),
        nameStr: wasmReadString(me, docId, wasmFindField(me, docId, 1, "name")),
        flagTag: me.doc_get_tag(docId, wasmFindField(me, docId, 1, "flag")),
        nothingTag: me.doc_get_tag(docId, wasmFindField(me, docId, 1, "nothing")),
      };
      me.doc_free(docId);
      return result;
    })()`) as any);

    expect(result).not.toHaveProperty("error");
    expect((result as any).rootTag).toBe(5);
    expect((result as any).nameStr).toBe("str_replace_editor");
    expect((result as any).flagTag).toBe(1);
    expect((result as any).nothingTag).toBe(0);
  });

  test("export → import tape round-trip preserves nested structure", async ({
    page,
  }) => {
    await setupPage(page);

    const result = await page.evaluate(new Function("return (async () => {" + WASM_HELPERS + `
      const wasmBytes = await fetch("/dist/engine.wasm").then(r => r.arrayBuffer());
      const { instance } = await WebAssembly.instantiate(wasmBytes, {});
      const engine = instance.exports;

      const docId = wasmParse(engine, '{"name":"Bob","items":[10,20,30],"nested":{"x":"hello"}}');
      if (docId < 0) return { error: "parse failed" };

      const tapeBuf = wasmExportTape(engine, docId);
      engine.doc_free(docId);
      const newDocId = wasmImportTape(engine, tapeBuf);
      if (newDocId < 0) return { error: "import failed" };

      const batchPtr = engine.doc_batch_ptr() >>> 0;
      const itemsIdx = wasmFindField(engine, newDocId, 1, "items");
      engine.doc_array_elements(newDocId, itemsIdx, 0);
      const elem0Idx = new Uint32Array(engine.memory.buffer, batchPtr, 1)[0];
      const nestedIdx = wasmFindField(engine, newDocId, 1, "nested");

      const result = {
        nameStr: wasmReadString(engine, newDocId, wasmFindField(engine, newDocId, 1, "name")),
        itemsCount: engine.doc_get_count(newDocId, itemsIdx),
        item0: engine.doc_get_number(newDocId, elem0Idx),
        xStr: wasmReadString(engine, newDocId, wasmFindField(engine, newDocId, nestedIdx, "x")),
      };
      engine.doc_free(newDocId);
      return result;
    })()`) as any);

    expect(result).not.toHaveProperty("error");
    expect((result as any).nameStr).toBe("Bob");
    expect((result as any).itemsCount).toBe(3);
    expect((result as any).item0).toBe(10);
    expect((result as any).xStr).toBe("hello");
  });
});
