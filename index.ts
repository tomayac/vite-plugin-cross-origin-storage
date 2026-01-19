import type { Plugin } from 'vite';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createFilter } from '@rollup/pluginutils';

export interface CosPluginOptions {
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

export default function cosPlugin(options: CosPluginOptions = {}): Plugin {
  const filter = createFilter(options.include || ['**/*'], options.exclude);

  // Resolve loader path relative to this file
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const loaderPath = path.resolve(__dirname, 'loader.js');

  return {
    name: 'vite-plugin-cos',
    apply: 'build',
    enforce: 'post',

    transformIndexHtml: {
      order: 'post',
      handler(html) {
        // Disable standard entry script to let the COS loader handle it
        return html.replace(
          /<script\s+[^>]*type=["']module["'][^>]*src=["'][^"']*index[^"']*["'][^>]*><\/script>/gi,
          '<!-- Entry script disabled by COS Plugin -->'
        );
      }
    },

    async generateBundle(_options, bundle) {
      const managedChunks: Record<string, any> = {};
      let mainChunk: any = null;
      let htmlAsset: any = null;

      for (const fileName in bundle) {
        const chunk = bundle[fileName];
        if (chunk.type === 'chunk') {
          if (chunk.isEntry) {
            mainChunk = chunk;
          } else {
            // Apply filter to determine if this chunk should be managed by COS
            if (filter(fileName)) {
              managedChunks[fileName] = chunk;
            }
          }
        }
        if (fileName === 'index.html' && chunk.type === 'asset') {
          htmlAsset = chunk;
        }
      }

      if (mainChunk) {
        // Step 1: Assign stable global variables to managed chunks
        // We do this BEFORE calculating hashes because the global variable names
        // are needed for import rewriting, which changes the code, which changes the hash.
        const chunkInfo: Record<string, { globalVar: string, chunk: any }> = {};

        for (const fileName in managedChunks) {
          // We use a hash of the filename to ensure it's a valid JS identifier and relatively short
          // detailed: using filename hash creates a stable identifier for the lifetime of the file path
          const nameHash = crypto.createHash('sha256').update(fileName).digest('hex').substring(0, 8);
          chunkInfo[fileName] = {
            globalVar: `__COS_CHUNK_${nameHash}__`,
            chunk: managedChunks[fileName]
          };
        }

        // Collect ALL chunks to rewrite imports in them
        const allChunks = Object.values(bundle).filter(c => c.type === 'chunk');

        // Step 2: Rewrite imports TO managed chunks in ALL chunks
        // This modifies the importers to look for the global variable (Blob URL)
        for (const targetChunk of allChunks) {
          for (const fileName in chunkInfo) {
            // Avoid self-reference
            if (targetChunk.fileName === fileName) continue;

            const { globalVar } = chunkInfo[fileName];
            const chunkBasename = fileName.split('/').pop()!;
            const escapedName = chunkBasename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Regex to find static imports of the managed chunk
            const pattern = `import\\s*\\{([^}]+)\\}\\s*from\\s*['"]\\.\\/${escapedName}['"];?`;
            const importRegex = new RegExp(pattern, 'g');

            if (importRegex.test(targetChunk.code)) {
              // Calculate relative path for fallback (in case COS loading fails or is unavailable)
              // targetChunk.fileName is the importer (e.g. "assets/index.js")
              // fileName is the importee (e.g. "assets/vendor.js")
              // We need "./vendor.js", not "./assets/vendor.js"
              let relativePath = path.relative(path.dirname(targetChunk.fileName), fileName);
              if (!relativePath.startsWith('.')) {
                relativePath = `./${relativePath}`;
              }

              targetChunk.code = targetChunk.code.replace(importRegex, (_match: string, bindings: string) => {
                const destructuringPattern = bindings.split(',').map(b => {
                  const parts = b.trim().split(/\s+as\s+/);
                  return parts.length === 2 ? `${parts[0]}:${parts[1]}` : parts[0];
                }).join(',');
                return `const {${destructuringPattern}}=await import(window.${globalVar}||"${relativePath}");`;
              });
            }
          }
        }

        // Step 3: Rewrite imports to UNMANAGED chunks in MANAGED chunks.
        // Managed chunks are loaded via Blob URLs. Relative imports fail in Blob URLs.
        // Absolute paths (e.g. "/assets/foo.js") work but depend on the app being at domain root.
        // To support subdirectories (and typical "base: './'" configs), we usage dynamic imports
        // with runtime URL resolution against `document.baseURI`.
        for (const fileName in managedChunks) {
          const chunk = managedChunks[fileName];
          // Check all imports designated by Rollup
          chunk.imports.forEach((importedFile: string) => {
            // If the importedFile is NOT in chunkInfo, it is unmanaged.
            if (!chunkInfo[importedFile]) {
              const importedBasename = importedFile.split('/').pop()!;
              const escapedName = importedBasename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

              // We need to match the full import statement to rewrite it to a destructuring assignment
              // Pattern: import { a as b, c } from "./foo.js";
              const pattern = `import\\s*\\{([^}]+)\\}\\s*from\\s*['"]\\.\\/${escapedName}['"];?`;
              const importRegex = new RegExp(pattern, 'g');

              if (importRegex.test(chunk.code)) {
                chunk.code = chunk.code.replace(importRegex, (_match: string, bindings: string) => {
                  const destructuringPattern = bindings.split(',').map(b => {
                    const parts = b.trim().split(/\s+as\s+/);
                    return parts.length === 2 ? `${parts[0]}:${parts[1]}` : parts[0];
                  }).join(',');
                  // Rewrite to dynamic import using document.baseURI to resolve the path correctly relative to the page
                  return `const {${destructuringPattern}}=await import(new URL("${importedFile}", document.baseURI).href);`;
                });
              }

              // Also handle side-effect imports if any? (Likely not for vendor chunks, but good to be safe?)
              // For now, focusing on named imports as that's what Rollup outputs for code splitting.
            }
          });
        }

        // Step 4: Calculate final hashes and build manifest
        // Now that code is modified (rewritten), we calculate the hash of the ACTUAL content that will be on disk.
        // This ensures that if the rewrite logic changes (e.g. absolute paths), the hash changes, busting the COS cache.
        const manifest: Record<string, any> = {};
        for (const fileName in chunkInfo) {
          const { chunk, globalVar } = chunkInfo[fileName];
          const finalHash = crypto.createHash('sha256').update(chunk.code).digest('hex');

          manifest[fileName] = {
            file: `/${fileName}`,
            hash: finalHash,
            globalVar: globalVar
          };
        }

        manifest['index'] = {
          file: `/${mainChunk.fileName}`
        };

        // Inject loader and inlined manifest into index.html
        if (htmlAsset) {
          try {
            let loaderCode = fs.readFileSync(loaderPath, 'utf-8');
            loaderCode = loaderCode.replace('__COS_MANIFEST__', JSON.stringify(manifest));

            let htmlSource = htmlAsset.source as string;

            // Remove modulepreload links to avoid double fetching keys we manage
            htmlSource = htmlSource.replace(
              /<link\s+[^>]*rel=["']modulepreload["'][^>]*>/gi,
              '<!-- modulepreload disabled by COS Plugin -->'
            );

            // Inject into head
            htmlAsset.source = htmlSource.replace(
              '<head>',
              () => `<head>\n<script id="cos-loader">${loaderCode}</script>`
            );
          } catch (e) {
            console.error('COS Plugin: Failed to read loader.js', e);
          }
        }
      }
    }
  };
}
