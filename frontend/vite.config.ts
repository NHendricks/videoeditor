import { defineConfig } from 'vite';

// Im Dev-Modus werden API- und Video-Anfragen ans Hono-Backend (Port 3000) weitergeleitet.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/videos': 'http://localhost:3000',
    },
  },
});
