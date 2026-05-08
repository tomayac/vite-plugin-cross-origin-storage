import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import vitePluginCrossOriginStorage from '../../dist/index.js';

// This config is intentionally identical to react-hello-world/vite.config.ts.
// Both apps bundle React with the same esbuild settings, so they produce the
// same vendor-react hash. Visiting react-hello-world first populates COS;
// opening react-todo on a different port (different origin) should then serve
// the vendor-react chunk from COS rather than the network.
export default defineConfig({
  plugins: [
    react(),
    vitePluginCrossOriginStorage({
      include: [/vendor-react-.*/],
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (
            id.includes('node_modules/react') ||
            id.includes('node_modules/react-dom') ||
            id.includes('node_modules/scheduler')
          ) {
            return 'vendor-react';
          }
        },
      },
    },
  },
});
