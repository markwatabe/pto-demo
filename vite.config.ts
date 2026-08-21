import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The @apygee packages declare react/react-dom as peers; make sure the
    // app and the linked workspace packages share a single React instance.
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    open: false,
  },
});
