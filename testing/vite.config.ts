import { defineConfig } from 'vite';
import vitePluginCrossOriginStorage from '../dist/index.js';

export default defineConfig({
  plugins: [
    vitePluginCrossOriginStorage({
      include: ['a'],
      exclude: ['b'],
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          a: [new URL('./a.js', import.meta.url).pathname],
          b: [new URL('./b.js', import.meta.url).pathname],
        },
      },
    },
  },
});
