import { defineConfig } from 'vite';
import vitePluginCrossOriginStorage from '../dist/index.js';

export default defineConfig({
  plugins: [vitePluginCrossOriginStorage()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          counter: [new URL('./counter.js', import.meta.url).pathname],
          constants: [new URL('./constants.js', import.meta.url).pathname],
        },
      },
    },
  },
});
