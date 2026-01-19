# vite-plugin-cross-origin-storage

A Vite plugin to cache and load static assets (chunks) using the [Cross-Origin Storage (COS) API](https://github.com/WICG/cross-origin-storage).

This plugin progressively enhances your application by attempting to load vendor chunks and other assets from a shared Cross-Origin Storage, reducing bandwidth usage and improving load times across different sites that share common dependencies.

## Features

- **Automatic Import Rewriting**: Rewrites static imports to use COS-loaded Blob URLs when available.
- **Network Fallback**: Gracefully falls back to standard network requests if COS is unavailable or the asset is missing.
- **Smart Caching**: Automatically stores fetched assets into COS for future use.
- **Configurable**: Easily include or exclude specific chunks using glob patterns.
- **Runtime Loader**: Injects a lightweight loader to handle COS interactions transparently.

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

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `include` | `string \| RegExp \| Array` | `['**/*']` | Pattern to include chunks to be managed by COS. |
| `exclude` | `string \| RegExp \| Array` | `undefined` | Pattern to exclude chunks from being managed. |

## How It Works

1. **Build Time**:
   - The plugin analyzes your bundle and identifies chunks matching the `include` pattern.
   - It generates a stable hash for each managed chunk.
   - It rewrites imports in your code to look for a global variable (e.g., `window.__COS_CHUNK_...`) containing the Blob URL of the chunk, falling back to the relative network path if the variable is unset.
   - It disables the default `<script type="module" src="...">` entry point in your `index.html` and injects a custom `loader.js`.

2. **Runtime**:
   - The injected loader checks for `navigator.crossOriginStorage`.
   - If supported, it requests the file handle for each managed chunk using its hash.
   - **Cache Hit**: If found, it creates a Blob URL and assigns it to the corresponding global variable.
   - **Cache Miss**: If not found, it fetches the file from the network, stores it in COS, and then creates the Blob URL.
   - Finally, the loader imports your application's entry point, which now seamlessly uses the cached assets.

## Requirements

- A browser with `Cross-Origin Storage` support (or a [browser extension](https://chromewebstore.google.com/detail/cross-origin-storage/denpnpcgjgikjpoglpjefakmdcbmlgih)).

## License

Apache 2.0
