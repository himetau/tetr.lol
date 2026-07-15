import { defineConfig } from 'vite';

export default defineConfig({
  // relative asset paths so the build also works from file:// in Electron
  base: './',
  server: { port: 5199 },
  build: { target: 'es2022' },
});
