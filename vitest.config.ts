import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: process.platform === 'win32' ? 35000 : 5000,
    hookTimeout: process.platform === 'win32' ? 35000 : 10000,
    maxWorkers: process.platform === 'win32' ? 2 : undefined,
  },
});
