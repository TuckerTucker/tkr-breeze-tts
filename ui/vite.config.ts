import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: {
      port: 5173,
      // Same-origin in production: the gateway serves ui/dist. In development
      // this proxy stands in for that, so no code path ever needs a base URL
      // and CORS never arises in either mode.
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${env.GATEWAY_PORT || 8787}`,
          changeOrigin: false,
        },
      },
    },
    build: { outDir: 'dist', sourcemap: true },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./test/setup.ts'],
      include: ['test/**/*.test.{ts,tsx}'],
    },
  };
});
