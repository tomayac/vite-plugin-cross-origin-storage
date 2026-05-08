import { defineConfig } from 'vite';
import vitePluginCrossOriginStorage from '../../dist/index.js';

export default defineConfig({
  plugins: [
    vitePluginCrossOriginStorage({
      include: ['a', /vendor-three-.*.js/],
      exclude: ['b'],
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.endsWith('/a.js')) return 'a';
          if (id.endsWith('/b.js')) return 'b';
        },
      },
    },
  },
});
