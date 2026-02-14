/**
 * Debug test: directly call the Zig engine to verify tape iteration works.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "../dist");

const engineBytes = await readFile(join(distDir, "engine.wasm"));
const engineModule = await WebAssembly.compile(engineBytes);
const engineInstance = await WebAssembly.instantiate(engineModule, {});
const engine = engineInstance.exports;

const decoder = new TextDecoder("utf-8");

function readString(ptr, len) {
  return decoder.decode(new Uint8Array(engine.memory.buffer, ptr, len));
}

// Token type names
const TOKEN_NAMES = [
  "null", "true", "false",
  "unsigned", "signed", "double",
  "string", "object_start", "object_end",
  "array_start", "array_end", "key",
  "end_of_tape", "error"
];

// Test parsing
const input = '{"hello": "world"}';
const bytes = new TextEncoder().encode(input);
const len = bytes.byteLength;

const ptr = engine.alloc(len);
console.log(`Allocated ${len} bytes at ptr ${ptr}`);

new Uint8Array(engine.memory.buffer, ptr, len).set(bytes);

const result = engine.parse(ptr, len);
console.log(`Parse result: ${result} (0=ok, 1=error)`);
console.log(`Error code: ${engine.get_error_code()}`);

console.log("\nTape iteration:");
for (let i = 0; i < 20; i++) {
  const token = engine.get_next_token();
  const name = TOKEN_NAMES[token] || `unknown(${token})`;
  let detail = "";

  if (token === 6 || token === 11) { // string or key
    const sptr = engine.get_token_string_ptr();
    const slen = engine.get_token_string_len();
    detail = ` = "${readString(sptr, slen)}"`;
  } else if (token >= 3 && token <= 5) { // number
    detail = ` = ${engine.get_token_number()}`;
  } else if (token === 1 || token === 2) { // bool
    detail = ` = ${engine.get_token_bool()}`;
  }

  console.log(`  [${i}] ${name}${detail}`);

  if (token === 12) break; // end_of_tape
}

engine.dealloc(ptr, len);

// Test array
console.log("\nTesting: [1, 2, 3]");
const input2 = "[1, 2, 3]";
const bytes2 = new TextEncoder().encode(input2);
const ptr2 = engine.alloc(bytes2.length);
new Uint8Array(engine.memory.buffer, ptr2, bytes2.length).set(bytes2);
const result2 = engine.parse(ptr2, bytes2.length);
console.log(`Parse result: ${result2}`);
for (let i = 0; i < 20; i++) {
  const token = engine.get_next_token();
  const name = TOKEN_NAMES[token] || `unknown(${token})`;
  let detail = "";
  if (token >= 3 && token <= 5) detail = ` = ${engine.get_token_number()}`;
  console.log(`  [${i}] ${name}${detail}`);
  if (token === 12) break;
}
engine.dealloc(ptr2, bytes2.length);
