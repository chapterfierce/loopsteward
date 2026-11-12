import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/*integration*.test.ts'],
    reporter: 'verbose',
    globals: true,
    testTimeout: 20000,
  },
});
