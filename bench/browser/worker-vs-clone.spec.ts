import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "../../dist");

async function setupPage(page: import("@playwright/test").Page) {
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

test.describe("Worker Transfer vs Structured Clone Benchmark", () => {
  const sizes = [10, 50, 100, 500, 1000];

  test("benchmark: transferable vs structured clone", async ({ page }) => {
    await setupPage(page);

    const logs: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "log") logs.push(msg.text());
    });

    await page.evaluate(async (sizes) => {
      function makeToolUsePayload(sizeKB: number): string {
        const lines: string[] = [];
        lines.push("import React, { useState, useEffect } from 'react';");
        lines.push(
          "import { fetchUserData, updateProfile } from '../api/users';"
        );
        lines.push(
          "import { Button, Input, Card, Spinner } from '../components/ui';"
        );
        lines.push("");
        lines.push("export function ProfileEditor({ userId }) {");
        lines.push("  const [profile, setProfile] = useState(null);");
        lines.push("  const [loading, setLoading] = useState(true);");
        lines.push("");
        const targetSize = sizeKB * 1024;
        while (lines.join("\n").length < targetSize) {
          const i = lines.length;
          lines.push(`  const handleField${i} = (value) => {`);
          lines.push(
            `    setProfile(prev => prev ? { ...prev, field${i}: value } : null);`
          );
          lines.push(`  };`);
          lines.push("");
        }
        lines.push("  return <div>{/* form */}</div>;");
        lines.push("}");
        const content = lines.join("\n").slice(0, targetSize);
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

      function formatTime(ms: number): string {
        if (ms < 0.001) return (ms * 1e6).toFixed(0) + " ns";
        if (ms < 1) return (ms * 1e3).toFixed(1) + " µs";
        if (ms < 1000) return ms.toFixed(2) + " ms";
        return (ms / 1000).toFixed(2) + " s";
      }

      const wasmBytes = await fetch("/dist/engine.wasm").then((r) =>
        r.arrayBuffer()
      );
      const wasmU8 = new Uint8Array(wasmBytes);
      let wasmBin = '';
      for (let i = 0; i < wasmU8.length; i += 8192) {
        wasmBin += String.fromCharCode(...wasmU8.subarray(i, i + 8192));
      }
      const wasmB64 = btoa(wasmBin);

      console.log(
        "╔══════════════════════════════════════════════════════════════════════╗"
      );
      console.log(
        "║   Worker Transfer Benchmark: Transferable vs Structured Clone      ║"
      );
      console.log(
        "║                                                                     ║"
      );
      console.log(
        "║   Measures MAIN THREAD BLOCKING time — what the user feels.        ║"
      );
      console.log(
        "║   Approach A: Worker JSON.parse → structured clone to main thread  ║"
      );
      console.log(
        "║   Approach B: Worker stream → getRawBuffer → transferable to main  ║"
      );
      console.log(
        "║   Approach C: Worker parse → tape transfer → zero-parse on main   ║"
      );
      console.log(
        "╚══════════════════════════════════════════════════════════════════════╝"
      );
      console.log("");

      const WARMUP = 3;
      const ITERS = 10;

      for (const sizeKB of sizes) {
        const payload = makeToolUsePayload(sizeKB);
        const payloadSizeStr = (payload.length / 1024).toFixed(1);
        console.log(
          `  ─── ${payloadSizeStr} KB payload ─── (${ITERS} iterations, ${WARMUP} warmup)`
        );

        // ============================================================
        // Approach A: JSON.parse in Worker + structured clone to main
        // ============================================================
        let cloneMainBlock = 0;
        let cloneWorkerParse = 0;
        {
          const workerCode = `
            self.onmessage = (e) => {
              const t0 = performance.now();
              const obj = JSON.parse(e.data);
              const parseMs = performance.now() - t0;
              // Structured clone happens here — main thread is blocked
              // while Chrome deep-copies the entire object graph
              self.postMessage({ obj, parseMs });
            };
          `;
          const blob = new Blob([workerCode], {
            type: "application/javascript",
          });
          const worker = new Worker(URL.createObjectURL(blob));

          for (let i = 0; i < WARMUP + ITERS; i++) {
            const result: any = await new Promise((resolve) => {
              worker.onmessage = (e) => {
                // Main thread: measure how long we're blocked receiving + reading
                const t0 = performance.now();
                const _name = e.data.obj.name;
                const _cmd = e.data.obj.input.command;
                const _path = e.data.obj.input.path;
                const mainBlock = performance.now() - t0;
                resolve({ mainBlock, parseMs: e.data.parseMs });
              };
              worker.postMessage(payload);
            });
            if (i >= WARMUP) {
              cloneMainBlock += result.mainBlock;
              cloneWorkerParse += result.parseMs;
            }
          }
          worker.terminate();
          cloneMainBlock /= ITERS;
          cloneWorkerParse /= ITERS;
        }

        // ============================================================
        // Approach B: VectorJSON stream in Worker + transferable to main
        // ============================================================
        let transferMainBlock = 0;
        let transferWorkerParse = 0;
        {
          const workerCode = `
            let engine = null;
            self.onmessage = async (e) => {
              if (e.data.type === 'init') {
                const wasmBytes = Uint8Array.from(atob(e.data.wasmB64), c => c.charCodeAt(0));
                const { instance } = await WebAssembly.instantiate(wasmBytes, {});
                engine = instance.exports;
                self.postMessage({ type: 'ready' });
                return;
              }

              const jsonStr = e.data;
              const encoded = new TextEncoder().encode(jsonStr);

              const t0 = performance.now();
              const streamId = engine.stream_create();
              const ptr = engine.alloc(encoded.length + 64) >>> 0;
              new Uint8Array(engine.memory.buffer, ptr, encoded.length).set(encoded);
              new Uint8Array(engine.memory.buffer, ptr + encoded.length, 64).fill(0x20);
              engine.stream_feed(streamId, ptr, encoded.length);
              engine.dealloc(ptr, encoded.length + 64);

              // getRawBuffer: copy from WASM into standalone ArrayBuffer
              const bufPtr = engine.stream_get_buffer_ptr(streamId) >>> 0;
              const bufLen = engine.stream_get_buffer_len(streamId);
              const copy = new ArrayBuffer(bufLen);
              new Uint8Array(copy).set(new Uint8Array(engine.memory.buffer, bufPtr, bufLen));
              engine.stream_destroy(streamId);

              const parseMs = performance.now() - t0;
              // Transfer O(1) — just moves the backing store pointer
              self.postMessage({ buf: copy, parseMs }, [copy]);
            };
          `;
          const blob = new Blob([workerCode], {
            type: "application/javascript",
          });
          const worker = new Worker(URL.createObjectURL(blob));

          await new Promise<void>((resolve) => {
            worker.onmessage = (e) => {
              if (e.data.type === "ready") resolve();
            };
            worker.postMessage({ type: "init", wasmB64 });
          });

          // Init WASM on main thread for re-parsing
          const { instance: mainInstance } = await WebAssembly.instantiate(
            await fetch("/dist/engine.wasm").then((r) => r.arrayBuffer()),
            {}
          );
          const mainEngine = mainInstance.exports as any;

          for (let i = 0; i < WARMUP + ITERS; i++) {
            const result: any = await new Promise((resolve) => {
              worker.onmessage = (e) => {
                // Main thread: measure blocking time for receive + parse + read
                const t0 = performance.now();
                const buf = e.data.buf as ArrayBuffer;
                const bytes = new Uint8Array(buf);

                // Parse on main thread (VectorJSON WASM parse)
                const ptr = mainEngine.alloc(bytes.length + 64) >>> 0;
                new Uint8Array(
                  mainEngine.memory.buffer,
                  ptr,
                  bytes.length
                ).set(bytes);
                new Uint8Array(
                  mainEngine.memory.buffer,
                  ptr + bytes.length,
                  64
                ).fill(0x20);
                const docId = mainEngine.doc_parse(ptr, bytes.length);

                // Read fields via source span (fast path)
                // In production you'd use the Proxy, but here we verify
                // the bytes arrived correctly by JSON.parsing the transferred buffer
                const decoded = new TextDecoder().decode(bytes);
                const obj = JSON.parse(decoded);
                const _name = obj.name;
                const _cmd = obj.input.command;
                const _path = obj.input.path;

                if (docId >= 0) mainEngine.doc_free(docId);
                mainEngine.dealloc(ptr, bytes.length + 64);

                const mainBlock = performance.now() - t0;
                resolve({ mainBlock, parseMs: e.data.parseMs });
              };
              worker.postMessage(payload);
            });
            if (i >= WARMUP) {
              transferMainBlock += result.mainBlock;
              transferWorkerParse += result.parseMs;
            }
          }
          worker.terminate();
          transferMainBlock /= ITERS;
          transferWorkerParse /= ITERS;
        }

        // ============================================================
        // Approach C: Tape transfer (zero-parse on main thread)
        // ============================================================
        let tapeMainBlock = 0;
        let tapeWorkerParse = 0;
        {
          const workerCode = `
            let engine = null;
            self.onmessage = async (e) => {
              if (e.data.type === 'init') {
                const wasmBytes = Uint8Array.from(atob(e.data.wasmB64), c => c.charCodeAt(0));
                const { instance } = await WebAssembly.instantiate(wasmBytes, {});
                engine = instance.exports;
                self.postMessage({ type: 'ready' });
                return;
              }

              const jsonStr = e.data;
              const encoded = new TextEncoder().encode(jsonStr);

              const t0 = performance.now();
              // Parse
              const ptr = engine.alloc(encoded.length + 64) >>> 0;
              new Uint8Array(engine.memory.buffer, ptr, encoded.length).set(encoded);
              new Uint8Array(engine.memory.buffer, ptr + encoded.length, 64).fill(0x20);
              const docId = engine.doc_parse(ptr, encoded.length);
              engine.dealloc(ptr, encoded.length + 64);

              // Export tape
              const exportSize = engine.doc_export_tape_size(docId);
              const outPtr = engine.alloc(exportSize) >>> 0;
              const written = engine.doc_export_tape(docId, outPtr, exportSize);
              const tapeBuf = new ArrayBuffer(written);
              new Uint8Array(tapeBuf).set(
                new Uint8Array(engine.memory.buffer, outPtr, written)
              );
              engine.dealloc(outPtr, exportSize);
              engine.doc_free(docId);

              const parseMs = performance.now() - t0;
              self.postMessage({ buf: tapeBuf, parseMs }, [tapeBuf]);
            };
          `;
          const blob = new Blob([workerCode], {
            type: "application/javascript",
          });
          const worker = new Worker(URL.createObjectURL(blob));

          await new Promise<void>((resolve) => {
            worker.onmessage = (e) => {
              if (e.data.type === "ready") resolve();
            };
            worker.postMessage({ type: "init", wasmB64 });
          });

          // Init WASM on main thread for tape import
          const { instance: mainInstance } = await WebAssembly.instantiate(
            await fetch("/dist/engine.wasm").then((r) => r.arrayBuffer()),
            {}
          );
          const me = mainInstance.exports as any;

          // Pre-encode keys outside the hot loop
          const enc = new TextEncoder();
          const keys = { name: enc.encode("name"), input: enc.encode("input"), command: enc.encode("command"), path: enc.encode("path") };

          function findField(docId: number, objIdx: number, key: Uint8Array) {
            const ptr = me.alloc(key.length) >>> 0;
            new Uint8Array(me.memory.buffer, ptr, key.length).set(key);
            const idx = me.doc_find_field(docId, objIdx, ptr, key.length);
            me.dealloc(ptr, key.length);
            return idx;
          }

          for (let i = 0; i < WARMUP + ITERS; i++) {
            const result: any = await new Promise((resolve) => {
              worker.onmessage = (e) => {
                const t0 = performance.now();
                const bytes = new Uint8Array(e.data.buf as ArrayBuffer);

                // Import tape (zero parse — just memcpy)
                const ptr = me.alloc(bytes.length) >>> 0;
                new Uint8Array(me.memory.buffer, ptr, bytes.length).set(bytes);
                const docId = me.doc_import_tape(ptr, bytes.length);
                me.dealloc(ptr, bytes.length);

                if (docId < 0) {
                  resolve({ mainBlock: performance.now() - t0, parseMs: e.data.parseMs });
                  return;
                }

                // Read same fields as other approaches: name, input.command, input.path
                findField(docId, 1, keys.name);
                const inputIdx = findField(docId, 1, keys.input);
                findField(docId, inputIdx, keys.command);
                findField(docId, inputIdx, keys.path);

                me.doc_free(docId);

                const mainBlock = performance.now() - t0;
                resolve({ mainBlock, parseMs: e.data.parseMs });
              };
              worker.postMessage(payload);
            });
            if (i >= WARMUP) {
              tapeMainBlock += result.mainBlock;
              tapeWorkerParse += result.parseMs;
            }
          }
          worker.terminate();
          tapeMainBlock /= ITERS;
          tapeWorkerParse /= ITERS;
        }

        // ============================================================
        // Approach D: Direct main-thread baseline (no Worker)
        // ============================================================
        let directTime = 0;
        {
          for (let i = 0; i < WARMUP + ITERS; i++) {
            const t0 = performance.now();
            const obj = JSON.parse(payload);
            const _name = obj.name;
            const _cmd = obj.input.command;
            const _path = obj.input.path;
            const elapsed = performance.now() - t0;
            if (i >= WARMUP) directTime += elapsed;
          }
          directTime /= ITERS;
        }

        // --- Print results ---
        console.log(
          `  Direct JSON.parse (no worker):   main-thread ${formatTime(directTime).padStart(10)}`
        );
        console.log(
          `  JSON.parse + structured clone:   worker-parse ${formatTime(cloneWorkerParse).padStart(10)}  main-block ${formatTime(cloneMainBlock).padStart(10)}`
        );
        console.log(
          `  VectorJSON + transferable:       worker-parse ${formatTime(transferWorkerParse).padStart(10)}  main-block ${formatTime(transferMainBlock).padStart(10)}`
        );
        console.log(
          `  VectorJSON + tape transfer:      worker-parse ${formatTime(tapeWorkerParse).padStart(10)}  main-block ${formatTime(tapeMainBlock).padStart(10)}`
        );
        if (cloneWorkerParse > 0) {
          const workerSpeedup = cloneWorkerParse / transferWorkerParse;
          console.log(
            `  → Worker parse: VectorJSON ${workerSpeedup.toFixed(1)}× ${workerSpeedup > 1 ? "faster" : "slower"}`
          );
        }
        if (transferMainBlock > 0) {
          const tapeSpeedup = transferMainBlock / tapeMainBlock;
          console.log(
            `  → Main-block: tape ${tapeSpeedup.toFixed(1)}× ${tapeSpeedup > 1 ? "faster" : "slower"} than raw transfer`
          );
        }
        console.log("");
      }

      console.log(
        "  Main-block = time the main thread spends receiving + accessing data."
      );
      console.log(
        "  With structured clone, the browser must deep-copy the entire object"
      );
      console.log(
        "  graph during postMessage — blocking the main thread proportional to"
      );
      console.log(
        "  object size. With transferable ArrayBuffer, the main thread receives"
      );
      console.log(
        "  the buffer in O(1) and can parse/access lazily. Tape transfer skips"
      );
      console.log(
        "  re-parsing entirely — the main thread imports the pre-built tape."
      );
    }, sizes);

    for (const line of logs) {
      console.log(line);
    }

    expect(logs.length).toBeGreaterThan(5);
    expect(logs.some((l) => l.includes("JSON.parse + structured clone"))).toBe(
      true
    );
    expect(logs.some((l) => l.includes("VectorJSON + transferable"))).toBe(
      true
    );
    expect(logs.some((l) => l.includes("VectorJSON + tape transfer"))).toBe(
      true
    );
  });
});
