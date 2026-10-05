import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Rendering tests explicitly simulate a color terminal and override these
  // values for NO_COLOR/non-TTY cases. Do not inherit the launcher environment.
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: process.platform === 'win32' ? 35000 : 5000,
    hookTimeout: process.platform === 'win32' ? 35000 : 10000,
    maxWorkers: process.platform === 'win32' ? 2 : 4,
    env: {
      NO_COLOR: '',
      FORCE_COLOR: '1',
      VIBE_AUTO_INTEGRATIONS: '0',
    },
  },
});

