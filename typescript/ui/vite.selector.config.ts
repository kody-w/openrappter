import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    lib: {
      entry: resolve(fileURLToPath(new URL('.', import.meta.url)), 'src/release-ring-selector.ts'),
      formats: ['es'],
      fileName: () => 'release-ring-selector.js',
    },
  },
});
