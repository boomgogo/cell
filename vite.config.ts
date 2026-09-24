import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    target: 'es2022',
    modulePreload: { polyfill: false },
    assetsInlineLimit: 8192,
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
  },
});
