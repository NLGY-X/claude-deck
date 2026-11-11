import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` serves the UI with hot reload and forwards the API to a
// running bridge (`npm start`). Open it on the tablet at the dev server's
// LAN address; pairing works the same way.
export default defineConfig({
  plugins: [react()],
  server: { host: true, proxy: { '/deck': 'http://127.0.0.1:4771' } },
  build: { target: 'es2022' },
});
