import { defineConfig } from 'vite';

export default defineConfig({
  // relative asset paths, so the build runs from any subfolder (GitHub Pages serves it
  // at /<repo>/)
  base: './',
  // 5173 is commonly taken by other local projects on this machine.
  server: { port: 5180 },
});
