import { defineConfig } from 'vitest/config';

export default defineConfig({
  // No CSS here. An inline (empty) PostCSS config stops Vite from walking up
  // to the web app's postcss.config.js, which needs packages this package
  // does not install.
  css: { postcss: {} },
  test: {
    globals: true,
    include: ['__tests__/**/*.test.ts'],
  },
});
