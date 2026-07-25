import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev proxy sends /v1 and /healthz to the API so the client can call same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/v1': 'http://localhost:8080',
      '/healthz': 'http://localhost:8080',
    },
  },
});
