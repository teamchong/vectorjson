import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 120_000,
  use: {
    browserName: "chromium",
    headless: true,
  },
});
