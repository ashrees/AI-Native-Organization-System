import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    allowedHosts: [
      'localhost',
      '127.0.0.1',
      '0.0.0.0',
      'a272-2607-fea8-fdf0-7d77-d5f-28f5-c644-b28f.ngrok-free.app',
    ],
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  }
});
