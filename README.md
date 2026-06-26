> [!NOTE]
> Superseded by [@danielroe](https://github.com/danielroe)'s
> [danielroe/cross-origin-storage](https://github.com/danielroe/cross-origin-storage).
> The npm package `vite-plugin-cross-origin-storage` remains the same.

# vite-plugin-cross-origin-storage

A Vite plugin to cache and load static assets (chunks) using the
[Cross-Origin Storage (COS) API](https://github.com/WICG/cross-origin-storage).

This plugin progressively enhances your application by attempting to load vendor
chunks and other assets from a shared Cross-Origin Storage, reducing bandwidth
usage and improving load times across different sites that share common
dependencies.

## Features

- **Automatic Import Rewriting**: Rewrites static imports to use COS-loaded Blob
  URLs when available.
- **Network Fallback**: Gracefully falls back to standard network requests if
  COS is unavailable or the asset is missing.
- **Smart Caching**: Automatically stores fetched assets into COS for future
  use.
- **Configurable**: Easily include or exclude specific chunks using glob
  patterns.
- **Runtime Loader**: Injects a lightweight loader to handle COS interactions
  transparently.

## Installation

```bash
npm install vite-plugin-cross-origin-storage --save-dev
```

## Usage

Add the plugin to your `vite.config.ts` (or `vite.config.js`):

```ts
import { defineConfig } from 'vite';
import cosPlugin from 'vite-plugin-cross-origin-storage';

export default defineConfig({
  plugins: [
    cosPlugin({
      // Configuration options
      include: ['**/vendor-*'], // Example: only manage vendor chunks
    }),
  ],
});
```

## Configuration

| Option    | Type                        | Default     | Description                                     |
| :-------- | :-------------------------- | :---------- | :---------------------------------------------- |
| `include` | `string \| RegExp \| Array` | `['**/*']`  | Pattern to include chunks to be managed by COS. |
| `exclude` | `string \| RegExp \| Array` | `undefined` | Pattern to exclude chunks from being managed.   |

## Recipe: Granular Vendor Splitting

To maximize caching benefits, it is recommended to split your `node_modules`
dependencies into separate chunks. This ensures that updates to one package
(e.g., `react`) do not invalidate the cache for others (e.g., `lodash`).

Add the following `manualChunks` configuration to your `vite.config.ts`:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import cosPlugin from 'vite-plugin-cross-origin-storage';

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            // Split each package into its own chunk
            // e.g. "node_modules/react/..." -> "vendor-react"
            // e.g. "node_modules/@scope/pkg/..." -> "vendor-scope-pkg"
            const parts = id.split('node_modules/')[1].split('/');
            const packageName = parts[0].startsWith('@')
              ? `${parts[0]}/${parts[1]}`
              : parts[0];
            return `vendor-${packageName.replace('@', '').replace('/', '-')}`;
          }
        },
      },
    },
  },
  plugins: [
    cosPlugin({
      // Only manage these vendor chunks with COS
      include: ['**/vendor-*'],
    }),
  ],
});
```

## How It Works

### Build Time

1. **Magic Externals**: For `include` patterns that resolve to npm package
   names (e.g. `vendor-react` → `react`), the plugin externalizes the package
   from Rollup and uses esbuild to produce a single self-contained ESM bundle.
   This bundle is emitted as a hashed asset (e.g. `assets/react-a1b2c3d4.js`)
   and treated as a managed chunk.
2. **Import Rewriting**: All inter-chunk imports are rewritten from relative
   paths (`"./chunk.js"`) to bare specifiers (`"coschunk-assets-chunk-js"`).
   This applies to both managed and unmanaged chunks, because managed chunks
   run as Blob URLs and cannot resolve relative paths at runtime.
3. **Manifest Generation**: A JSON manifest is built containing the base path,
   the entry chunk filename, a map of every managed chunk filename to its
   SHA-256 hash, and a list of unmanaged chunks that need network-URL entries
   in the import map.
4. **Loader Injection**: The plugin disables the default
   `<script type="module">` entry tag and injects a `<script id="cos-loader">`
   containing the runtime loader with the manifest inlined.

### Runtime

1. The loader checks for `navigator.crossOriginStorage`.
2. For each managed chunk it calls
   `navigator.crossOriginStorage.requestFileHandles([{ algorithm: 'SHA-256', value: hash }])`:
   - **Cache hit**: wraps the returned `File` as a Blob URL.
   - **Cache miss**: fetches the chunk from the network, stores it in COS via
     `requestFileHandles(..., { create: true })`, then wraps it as a Blob URL.
3. Unmanaged chunks receive absolute network URLs.
4. An `<script type="importmap">` is injected into `<head>` mapping every
   `coschunk-*` bare specifier to its resolved URL.
5. The entry point is imported via its bare specifier inside a `setTimeout`
   callback so the browser has time to register the import map before the
   first module resolution occurs.

## Requirements

- A browser with `Cross-Origin Storage` support (or a
  [browser extension](https://chromewebstore.google.com/detail/cross-origin-storage/denpnpcgjgikjpoglpjefakmdcbmlgih)).

## License

Apache 2.0
