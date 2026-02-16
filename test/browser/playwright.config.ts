import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  use: {
    browserName: "chromium",
    headless: true,
  },
});
