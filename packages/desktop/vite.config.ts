import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  resolve: { conditions: ['development'] },
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
});
