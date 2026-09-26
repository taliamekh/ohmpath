import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', timeout: 120000, workers: 1,
  reporter: [['list']], outputDir: '../../runtime/playwright-results',
});
