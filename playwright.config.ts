import { defineConfig } from '@playwright/test';
// Isolated UI review gate; default comparison ports remain unchanged.
const devPort = process.env.CADESIMU_UI_TEST_PORTS === '1' ? 4273 : 4173;
const previewPort = process.env.CADESIMU_UI_TEST_PORTS === '1' ? 4274 : 4174;
export default defineConfig({
  // Supported browser gate is serialized; repeated cases still use isolated contexts.
  testDir: './tests/browser', fullyParallel: false, workers: 1, retries: 0,
  use: { browserName: 'chromium', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'development', testIgnore: 'offline-export.spec.ts', use: { baseURL: `http://127.0.0.1:${devPort}` } },
    { name: 'production-offline', testMatch: 'offline-export.spec.ts', use: { baseURL: `http://127.0.0.1:${previewPort}` } }
  ],
  webServer: [
    { command: `npm run dev -- --port ${devPort} --strictPort`, url: `http://127.0.0.1:${devPort}`, reuseExistingServer: false, timeout: 30000 },
    { command: `npm run preview -- --port ${previewPort} --strictPort`, url: `http://127.0.0.1:${previewPort}`, reuseExistingServer: false, timeout: 30000 }
  ]
});
