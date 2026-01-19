import { Plugin } from 'vite';

interface CosPluginOptions {
    /**
     * Pattern to include chunks to be managed by COS.
     * Matches against the output filename (e.g. `assets/vendor-*.js`).
     * Default: `['**\/*']` (all chunks, except the entry implementation detail)
     */
    include?: string | RegExp | (string | RegExp)[];
    /**
     * Pattern to exclude chunks from being managed by COS.
     */
    exclude?: string | RegExp | (string | RegExp)[];
}
declare function cosPlugin(options?: CosPluginOptions): Plugin;

export { type CosPluginOptions, cosPlugin as default };
