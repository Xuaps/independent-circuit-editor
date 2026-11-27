import { defineConfig } from '@playwright/test';

// Playwright 1.56 otherwise takes a page snapshot on failure even with tracing off.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

export default defineConfig({
  testDir: './tests/hosted',
  testMatch: '**/*.hosted.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: 'line',
  preserveOutput: 'never',
  use: {
    browserName: 'chromium',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
