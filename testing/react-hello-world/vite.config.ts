import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import vitePluginCrossOriginStorage from '../../dist/index.js';

export default defineConfig({
  plugins: [
    react(),
    vitePluginCrossOriginStorage({
      // Manage the manually-split React vendor chunk via COS. Using a regex
      // rather than magic externals because react-dom exposes subpath imports
      // (react-dom/client) that the string-based externals pattern doesn't
      // capture.
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
