import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [["line"], ["html", { outputFolder: "artifacts/playwright-report", open: "never" }]],
  use: {
    browserName: "chromium",
    screenshot: "off",
    trace: "off",
    video: "off"
  }
});
