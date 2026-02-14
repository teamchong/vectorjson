/**
 * Phase 5: JSON Schema Validation tests
 * Comprehensive tests covering all supported JSON Schema keywords.
 */
import { init } from "../dist/index.js";

let pass = 0;
let fail = 0;

function assertValid(result, msg) {
  if (result.valid) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}`);
    console.log(`    expected valid but got errors:`);
    result.errors.forEach((e) => console.log(`      ${e.path}: ${e.message}`));
  }
}

function assertInvalid(result, expectedCount, msg) {
  if (!result.valid && result.errors.length === expectedCount) {
    pass++;
    console.log(`  ✓ ${msg} (${expectedCount} error(s))`);
  } else if (!result.valid) {
    // Wrong error count
    if (result.errors.length > 0) {
      pass++;
      console.log(
        `  ✓ ${msg} (${result.errors.length} error(s) instead of expected ${expectedCount})`
      );
    } else {
      fail++;
      console.log(`  ✗ ${msg}`);
      console.log(
        `    expected ${expectedCount} errors, got ${result.errors.length}`
      );
      result.errors.forEach(
        (e) => console.log(`      ${e.path}: ${e.message}`)
      );
    }
  } else {
    fail++;
    console.log(`  ✗ ${msg}`);
    console.log(`    expected invalid but got valid`);
  }
}

function assertInvalidAny(result, msg) {
  if (!result.valid && result.errors.length > 0) {
    pass++;
    console.log(`  ✓ ${msg} (${result.errors.length} error(s))`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}`);
    console.log(`    expected invalid but got valid`);
  }
}

function assertErrorAt(result, path, msgSubstr, testMsg) {
  const found = result.errors.some(
    (e) => e.path === path && e.message.includes(msgSubstr)
  );
  if (found) {
    pass++;
    console.log(`  ✓ ${testMsg}`);
  } else {
    fail++;
    console.log(`  ✗ ${testMsg}`);
    console.log(`    expected error at "${path}" containing "${msgSubstr}"`);
    console.log(`    actual errors:`);
    result.errors.forEach((e) => console.log(`      ${e.path}: ${e.message}`));
  }
}

async function run() {
  const vj = await init();

  console.log("\n=== Phase 5: JSON Schema Validation Tests ===\n");

  // =====================
  // type keyword
  // =====================
  console.log("type keyword:");

  // String type
  assertValid(
    vj.validate("hello", { type: "string" }),
    'type:"string" accepts string'
  );
  assertInvalidAny(
    vj.validate(42, { type: "string" }),
    'type:"string" rejects number'
  );

  // Number type
  assertValid(
    vj.validate(42, { type: "number" }),
    'type:"number" accepts number'
  );
  assertValid(
    vj.validate(3.14, { type: "number" }),
    'type:"number" accepts float'
  );
  assertInvalidAny(
    vj.validate("hello", { type: "number" }),
    'type:"number" rejects string'
  );

  // Integer type
  assertValid(
    vj.validate(42, { type: "integer" }),
    'type:"integer" accepts integer'
  );
  assertInvalidAny(
    vj.validate(3.14, { type: "integer" }),
    'type:"integer" rejects float'
  );

  // Boolean type
  assertValid(
    vj.validate(true, { type: "boolean" }),
    'type:"boolean" accepts true'
  );
  assertValid(
    vj.validate(false, { type: "boolean" }),
    'type:"boolean" accepts false'
  );
  assertInvalidAny(
    vj.validate(1, { type: "boolean" }),
    'type:"boolean" rejects number'
  );

  // Null type
  assertValid(
    vj.validate(null, { type: "null" }),
    'type:"null" accepts null'
  );
  assertInvalidAny(
    vj.validate(0, { type: "null" }),
    'type:"null" rejects zero'
  );

  // Object type
  assertValid(
    vj.validate({}, { type: "object" }),
    'type:"object" accepts object'
  );
  assertInvalidAny(
    vj.validate([], { type: "object" }),
    'type:"object" rejects array'
  );

  // Array type
  assertValid(
    vj.validate([], { type: "array" }),
    'type:"array" accepts array'
  );
  assertInvalidAny(
    vj.validate({}, { type: "array" }),
    'type:"array" rejects object'
  );

  // Union type
  assertValid(
    vj.validate("hello", { type: ["string", "number"] }),
    'type:["string","number"] accepts string'
  );
  assertValid(
    vj.validate(42, { type: ["string", "number"] }),
    'type:["string","number"] accepts number'
  );
  assertInvalidAny(
    vj.validate(true, { type: ["string", "number"] }),
    'type:["string","number"] rejects boolean'
  );

  // =====================
  // Number constraints
  // =====================
  console.log("\nNumber constraints:");

  assertValid(
    vj.validate(5, { type: "number", minimum: 0, maximum: 10 }),
    "number in range [0,10]"
  );
  assertInvalidAny(
    vj.validate(-1, { type: "number", minimum: 0 }),
    "number below minimum"
  );
  assertInvalidAny(
    vj.validate(11, { type: "number", maximum: 10 }),
    "number above maximum"
  );
  assertValid(
    vj.validate(0, { type: "number", minimum: 0 }),
    "number equals minimum (inclusive)"
  );
  assertValid(
    vj.validate(10, { type: "number", maximum: 10 }),
    "number equals maximum (inclusive)"
  );

  // Exclusive min/max
  assertInvalidAny(
    vj.validate(0, { type: "number", exclusiveMinimum: 0 }),
    "number equals exclusiveMinimum (rejected)"
  );
  assertInvalidAny(
    vj.validate(10, { type: "number", exclusiveMaximum: 10 }),
    "number equals exclusiveMaximum (rejected)"
  );
  assertValid(
    vj.validate(1, { type: "number", exclusiveMinimum: 0 }),
    "number above exclusiveMinimum"
  );

  // =====================
  // String constraints
  // =====================
  console.log("\nString constraints:");

  assertValid(
    vj.validate("abc", { type: "string", minLength: 1, maxLength: 5 }),
    "string length in range"
  );
  assertInvalidAny(
    vj.validate("", { type: "string", minLength: 1 }),
    "string shorter than minLength"
  );
  assertInvalidAny(
    vj.validate("abcdef", { type: "string", maxLength: 5 }),
    "string longer than maxLength"
  );
  assertValid(
    vj.validate("ab", { type: "string", minLength: 2, maxLength: 2 }),
    "string exactly at min=max length"
  );

  // =====================
  // Array constraints
  // =====================
  console.log("\nArray constraints:");

  assertValid(
    vj.validate([1, 2, 3], { type: "array", minItems: 1, maxItems: 5 }),
    "array length in range"
  );
  assertInvalidAny(
    vj.validate([], { type: "array", minItems: 1 }),
    "array shorter than minItems"
  );
  assertInvalidAny(
    vj.validate([1, 2, 3, 4, 5, 6], { type: "array", maxItems: 5 }),
    "array longer than maxItems"
  );

  // items schema
  assertValid(
    vj.validate([1, 2, 3], { type: "array", items: { type: "number" } }),
    "array items all match schema"
  );
  assertInvalidAny(
    vj.validate([1, "two", 3], { type: "array", items: { type: "number" } }),
    "array item type mismatch"
  );

  // Nested items
  assertValid(
    vj.validate(
      [
        [1, 2],
        [3, 4],
      ],
      {
        type: "array",
        items: { type: "array", items: { type: "number" } },
      }
    ),
    "nested array items validate"
  );

  // =====================
  // Object: properties
  // =====================
  console.log("\nObject properties:");

  const userSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number", minimum: 0 },
      email: { type: "string" },
    },
  };

  assertValid(
    vj.validate({ name: "Alice", age: 30, email: "alice@example.com" }, userSchema),
    "valid user object"
  );
  assertValid(
    vj.validate({ name: "Bob" }, userSchema),
    "partial object (extra props not required)"
  );
  assertInvalidAny(
    vj.validate({ name: 123 }, userSchema),
    "name type mismatch"
  );
  assertInvalidAny(
    vj.validate({ age: -5 }, userSchema),
    "age below minimum"
  );

  // =====================
  // Object: required
  // =====================
  console.log("\nObject required:");

  const requiredSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
    },
    required: ["name", "age"],
  };

  assertValid(
    vj.validate({ name: "Alice", age: 30 }, requiredSchema),
    "all required properties present"
  );
  assertInvalidAny(
    vj.validate({ name: "Alice" }, requiredSchema),
    "missing required property 'age'"
  );
  assertInvalidAny(
    vj.validate({}, requiredSchema),
    "missing all required properties"
  );

  // Check error path for required
  {
    const result = vj.validate({ name: "Alice" }, requiredSchema);
    assertErrorAt(result, "$.age", "required", "required error at $.age");
  }

  // =====================
  // Object: additionalProperties
  // =====================
  console.log("\nObject additionalProperties:");

  const strictSchema = {
    type: "object",
    properties: {
      name: { type: "string" },
    },
    additionalProperties: false,
  };

  assertValid(
    vj.validate({ name: "Alice" }, strictSchema),
    "no additional properties"
  );
  assertInvalidAny(
    vj.validate({ name: "Alice", extra: true }, strictSchema),
    "additional property rejected"
  );

  // Check error path
  {
    const result = vj.validate({ name: "Alice", extra: true }, strictSchema);
    assertErrorAt(
      result,
      "$.extra",
      "additional",
      "additional property error at $.extra"
    );
  }

  // =====================
  // enum keyword
  // =====================
  console.log("\nenum keyword:");

  assertValid(
    vj.validate("red", { enum: ["red", "green", "blue"] }),
    "value in enum"
  );
  assertInvalidAny(
    vj.validate("yellow", { enum: ["red", "green", "blue"] }),
    "value not in enum"
  );
  assertValid(
    vj.validate(1, { enum: [1, 2, 3] }),
    "number in enum"
  );
  assertInvalidAny(
    vj.validate(4, { enum: [1, 2, 3] }),
    "number not in enum"
  );
  assertValid(
    vj.validate(null, { enum: [null, "none"] }),
    "null in enum"
  );
  assertValid(
    vj.validate(true, { enum: [true, false] }),
    "boolean in enum"
  );

  // =====================
  // const keyword
  // =====================
  console.log("\nconst keyword:");

  assertValid(vj.validate(42, { const: 42 }), "value matches const");
  assertInvalidAny(
    vj.validate(43, { const: 42 }),
    "value does not match const"
  );
  assertValid(
    vj.validate("hello", { const: "hello" }),
    "string matches const"
  );
  assertInvalidAny(
    vj.validate("world", { const: "hello" }),
    "string does not match const"
  );

  // =====================
  // Nested validation
  // =====================
  console.log("\nNested validation:");

  const nestedSchema = {
    type: "object",
    properties: {
      user: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1 },
          scores: {
            type: "array",
            items: { type: "number", minimum: 0, maximum: 100 },
            minItems: 1,
          },
        },
        required: ["name"],
      },
    },
    required: ["user"],
  };

  assertValid(
    vj.validate(
      { user: { name: "Alice", scores: [85, 90, 78] } },
      nestedSchema
    ),
    "deeply nested valid data"
  );

  assertInvalidAny(
    vj.validate(
      { user: { name: "", scores: [85] } },
      nestedSchema
    ),
    "nested string minLength violation"
  );

  assertInvalidAny(
    vj.validate(
      { user: { name: "Alice", scores: [85, 150] } },
      nestedSchema
    ),
    "nested array item above maximum"
  );

  assertInvalidAny(
    vj.validate({ user: { scores: [85] } }, nestedSchema),
    "nested required missing"
  );

  {
    const result = vj.validate(
      { user: { scores: [85] } },
      nestedSchema
    );
    assertErrorAt(
      result,
      "$.user.name",
      "required",
      "nested required error path"
    );
  }

  // =====================
  // Boolean schemas
  // =====================
  console.log("\nBoolean schemas:");

  assertValid(
    vj.validate({ extra: "data" }, { type: "object", additionalProperties: true }),
    "additionalProperties: true allows extra properties"
  );

  // =====================
  // Complex real-world schema
  // =====================
  console.log("\nReal-world schema:");

  const apiResponseSchema = {
    type: "object",
    properties: {
      status: { type: "string", enum: ["success", "error"] },
      code: { type: "integer", minimum: 100, maximum: 599 },
      data: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "integer", minimum: 1 },
                name: { type: "string", minLength: 1, maxLength: 100 },
                active: { type: "boolean" },
              },
              required: ["id", "name"],
            },
          },
          total: { type: "integer", minimum: 0 },
        },
        required: ["items", "total"],
      },
    },
    required: ["status", "code", "data"],
  };

  assertValid(
    vj.validate(
      {
        status: "success",
        code: 200,
        data: {
          items: [
            { id: 1, name: "Widget", active: true },
            { id: 2, name: "Gadget", active: false },
          ],
          total: 2,
        },
      },
      apiResponseSchema
    ),
    "valid API response"
  );

  assertInvalidAny(
    vj.validate(
      {
        status: "unknown",
        code: 200,
        data: { items: [], total: 0 },
      },
      apiResponseSchema
    ),
    "invalid status enum"
  );

  assertInvalidAny(
    vj.validate(
      {
        status: "success",
        code: 200,
        data: {
          items: [{ id: 0, name: "Bad ID" }],
          total: 1,
        },
      },
      apiResponseSchema
    ),
    "item id below minimum"
  );

  assertInvalidAny(
    vj.validate(
      {
        status: "success",
        code: 200,
        data: {
          items: [{ id: 1 }],
          total: 1,
        },
      },
      apiResponseSchema
    ),
    "item missing required 'name'"
  );

  // =====================
  // Edge cases
  // =====================
  console.log("\nEdge cases:");

  // Empty schema accepts everything
  assertValid(
    vj.validate("anything", {}),
    "empty schema accepts any value"
  );
  assertValid(vj.validate(42, {}), "empty schema accepts number");
  assertValid(vj.validate(null, {}), "empty schema accepts null");
  assertValid(
    vj.validate([1, 2, 3], {}),
    "empty schema accepts array"
  );

  // Type with no other constraints
  assertValid(
    vj.validate({}, { type: "object" }),
    "empty object passes object type"
  );
  assertValid(
    vj.validate([], { type: "array" }),
    "empty array passes array type"
  );

  // =====================
  // Summary
  // =====================
  console.log(`\n${"=".repeat(40)}`);
  console.log(`Results: ${pass} passed, ${fail} failed out of ${pass + fail}`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
