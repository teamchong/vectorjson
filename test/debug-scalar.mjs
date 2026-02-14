import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "../dist");
const engineBytes = await readFile(join(distDir, "engine.wasm"));
const engineInstance = await WebAssembly.instantiate(await WebAssembly.compile(engineBytes), {});
const engine = engineInstance.exports;
const decoder = new TextDecoder("utf-8");
const TOKEN_NAMES = ["null","true","false","unsigned","signed","double","string","object_start","object_end","array_start","array_end","key","end_of_tape","error"];

for (const input of ["42", "true", "false", "null", '"hello"']) {
  const bytes = new TextEncoder().encode(input);
  const ptr = engine.alloc(bytes.length);
  new Uint8Array(engine.memory.buffer, ptr, bytes.length).set(bytes);
  const result = engine.parse(ptr, bytes.length);
  console.log(`\n"${input}" → parse result: ${result}, error: ${engine.get_error_code()}`);
  for (let i = 0; i < 5; i++) {
    const token = engine.get_next_token();
    const name = TOKEN_NAMES[token] || `unknown(${token})`;
    let detail = "";
    if (token >= 3 && token <= 5) detail = ` = ${engine.get_token_number()}`;
    if (token === 6) detail = ` = "${decoder.decode(new Uint8Array(engine.memory.buffer, engine.get_token_string_ptr(), engine.get_token_string_len()))}"`;
    if (token === 1 || token === 2) detail = ` = ${engine.get_token_bool()}`;
    console.log(`  [${i}] ${name}${detail}`);
    if (token === 12) break;
  }
  engine.dealloc(ptr, bytes.length);
}
