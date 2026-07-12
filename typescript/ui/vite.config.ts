import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  define: command === 'serve'
    ? { 'import.meta.env.VITE_GATEWAY_PATH': JSON.stringify('/gateway') }
    : {},
  server: {
    port: 3000,
    strictPort: true,
    allowedHosts: ['localhost', '127.0.0.1', '::1'],
    proxy: {
      '/gateway': {
        target: 'ws://127.0.0.1:18790',
        ws: true,
        changeOrigin: false,
      },
      '/api': {
        target: 'http://127.0.0.1:18790',
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/health': {
        target: 'http://127.0.0.1:18790',
        changeOrigin: false,
      },
      '/status': {
        target: 'http://127.0.0.1:18790',
        changeOrigin: false,
      },
    },
  },
}));
