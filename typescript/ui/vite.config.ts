import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  define: {
    // In dev mode, tell the gateway client to connect directly to port 18790
    'import.meta.env.VITE_GATEWAY_URL': JSON.stringify('ws://localhost:18790'),
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:18790',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/health': {
        target: 'http://localhost:18790',
        changeOrigin: true,
      },
      '/status': {
        target: 'http://localhost:18790',
        changeOrigin: true,
      },
    },
  },
});
