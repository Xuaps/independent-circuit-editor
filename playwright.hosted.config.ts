import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/hosted',
  testMatch: '**/*.hosted.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
