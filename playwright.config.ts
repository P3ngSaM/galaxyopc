import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-tests",
  timeout: 900_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://localhost:3000",
    headless: false,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 30_000,
    screenshot: "only-on-failure",
  },
  reporter: [["list"], ["@midscene/web/playwright-reporter"]],
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
