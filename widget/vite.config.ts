import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const widgetRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: widgetRoot,
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.join(widgetRoot, 'src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: path.join(widgetRoot, 'dist'),
    emptyOutDir: true,
    target: 'chrome136',
    sourcemap: false,
  },
});
