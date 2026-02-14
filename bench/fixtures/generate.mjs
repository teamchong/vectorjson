/**
 * Generate realistic JSON fixtures at various sizes.
 * Simulates real-world data: API responses, config, logs, analytics, etc.
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Helpers ---
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randFloat = (min, max) => +(Math.random() * (max - min) + min).toFixed(4);
const randStr = (len) => {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[randInt(0, chars.length - 1)];
  return s;
};
const randDate = () => {
  const y = randInt(2020, 2026);
  const m = String(randInt(1, 12)).padStart(2, "0");
  const d = String(randInt(1, 28)).padStart(2, "0");
  return `${y}-${m}-${d}T${String(randInt(0, 23)).padStart(2, "0")}:${String(randInt(0, 59)).padStart(2, "0")}:${String(randInt(0, 59)).padStart(2, "0")}Z`;
};

const NAMES = ["Alice", "Bob", "Charlie", "Diana", "Eve", "Frank", "Grace", "Hank", "Ivy", "Jack"];
const EMAILS = NAMES.map((n) => `${n.toLowerCase()}@example.com`);
const TAGS = ["urgent", "low", "bug", "feature", "docs", "refactor", "perf", "security", "ux", "api"];
const STATUSES = ["active", "inactive", "pending", "suspended", "archived"];
const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"];
const PATHS = ["/api/users", "/api/items", "/api/auth", "/api/search", "/api/config", "/api/health"];

// --- Fixture generators ---

/** Tiny: single config object (~200 bytes) */
function genTiny() {
  return {
    host: "localhost",
    port: 8080,
    debug: false,
    maxRetries: 3,
    timeout: 30000,
    logLevel: "info",
  };
}

/** Small: single user record (~500 bytes) */
function genSmall() {
  return {
    id: randInt(1, 99999),
    name: pick(NAMES),
    email: pick(EMAILS),
    age: randInt(18, 80),
    active: Math.random() > 0.3,
    role: pick(["admin", "user", "editor", "viewer"]),
    createdAt: randDate(),
    tags: Array.from({ length: randInt(1, 4) }, () => pick(TAGS)),
    settings: {
      theme: pick(["light", "dark", "auto"]),
      notifications: Math.random() > 0.5,
      language: pick(["en", "es", "fr", "de", "ja"]),
    },
  };
}

/** Medium: API response with 100 items (~50 KB) */
function genMedium() {
  return {
    status: "success",
    code: 200,
    meta: {
      page: 1,
      perPage: 100,
      total: randInt(500, 5000),
      processingTimeMs: randFloat(10, 200),
    },
    data: Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      name: `${pick(NAMES)} ${randStr(8)}`,
      email: `user${i}@example.com`,
      score: randFloat(0, 100),
      active: Math.random() > 0.2,
      role: pick(["admin", "user", "editor"]),
      createdAt: randDate(),
      updatedAt: randDate(),
      tags: Array.from({ length: randInt(1, 5) }, () => pick(TAGS)),
      metadata: {
        lastLogin: randDate(),
        loginCount: randInt(0, 1000),
        browser: pick(["Chrome", "Firefox", "Safari", "Edge"]),
        os: pick(["Windows", "macOS", "Linux", "iOS", "Android"]),
      },
    })),
  };
}

/** Large: analytics dashboard (~500 KB) */
function genLarge() {
  return {
    dashboard: {
      id: "dash-" + randStr(8),
      title: "Analytics Dashboard",
      createdAt: randDate(),
      updatedAt: randDate(),
    },
    metrics: Array.from({ length: 30 }, (_, i) => ({
      name: `metric_${i}`,
      type: pick(["counter", "gauge", "histogram"]),
      unit: pick(["ms", "bytes", "requests", "errors", "%"]),
      dataPoints: Array.from({ length: 200 }, (_, j) => ({
        timestamp: `2024-01-${String((j % 28) + 1).padStart(2, "0")}T${String(j % 24).padStart(2, "0")}:00:00Z`,
        value: randFloat(0, 10000),
        tags: { region: pick(["us-east", "us-west", "eu", "asia"]), env: pick(["prod", "staging"]) },
      })),
    })),
    summary: {
      totalRequests: randInt(1000000, 50000000),
      errorRate: randFloat(0, 5),
      p50Latency: randFloat(10, 100),
      p95Latency: randFloat(100, 500),
      p99Latency: randFloat(500, 2000),
    },
  };
}

/** XLarge: log entries (~2 MB) */
function genXLarge() {
  return {
    logs: Array.from({ length: 5000 }, (_, i) => ({
      id: `log-${String(i).padStart(6, "0")}`,
      timestamp: randDate(),
      level: pick(["DEBUG", "INFO", "WARN", "ERROR"]),
      service: pick(["api-gateway", "auth-service", "user-service", "billing", "notifications"]),
      message: randStr(randInt(50, 200)),
      context: {
        requestId: `req-${randStr(12)}`,
        userId: `usr-${randInt(1, 10000)}`,
        method: pick(METHODS),
        path: pick(PATHS),
        statusCode: pick([200, 201, 301, 400, 401, 403, 404, 500, 502, 503]),
        duration: randFloat(1, 5000),
        ip: `${randInt(1, 255)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(0, 255)}`,
      },
      stackTrace: Math.random() > 0.9 ? `Error: ${randStr(30)}\n  at ${randStr(20)}:${randInt(1, 500)}\n  at ${randStr(20)}:${randInt(1, 500)}` : null,
    })),
  };
}

/** Huge: simulated streaming AI response (~5 MB) */
function genHuge() {
  return {
    model: "gpt-4-turbo",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: randStr(50000), // ~50KB text
        tool_calls: Array.from({ length: 20 }, (_, i) => ({
          id: `call-${randStr(8)}`,
          type: "function",
          function: {
            name: pick(["search", "calculate", "fetch_data", "summarize", "translate"]),
            arguments: JSON.stringify({
              query: randStr(100),
              options: { limit: randInt(10, 100), offset: randInt(0, 1000) },
            }),
          },
        })),
      },
      finish_reason: "stop",
    }],
    usage: {
      prompt_tokens: randInt(100, 5000),
      completion_tokens: randInt(100, 10000),
      total_tokens: randInt(200, 15000),
    },
    // Simulate a large structured response from an AI
    structured_output: {
      analysis: Array.from({ length: 100 }, (_, i) => ({
        section: `Section ${i + 1}`,
        title: randStr(30),
        content: randStr(500),
        confidence: randFloat(0, 1),
        citations: Array.from({ length: randInt(1, 5) }, () => ({
          source: randStr(30),
          url: `https://example.com/${randStr(10)}`,
          relevance: randFloat(0, 1),
        })),
        entities: Array.from({ length: randInt(2, 10) }, () => ({
          name: randStr(15),
          type: pick(["person", "org", "location", "date", "concept"]),
          mentions: randInt(1, 20),
        })),
      })),
    },
  };
}

// --- Generate and write ---
const fixtures = {
  "tiny.json": genTiny,
  "small.json": genSmall,
  "medium.json": genMedium,
  "large.json": genLarge,
  "xlarge.json": genXLarge,
  "huge.json": genHuge,
};

for (const [name, gen] of Object.entries(fixtures)) {
  const data = gen();
  const json = JSON.stringify(data);
  const path = join(__dirname, name);
  writeFileSync(path, json);
  const sizeKB = (json.length / 1024).toFixed(1);
  console.log(`  ${name}: ${sizeKB} KB`);
}

console.log("\nFixtures generated.");
