import type { Plugin } from 'vite';
import type { OutputBundle, OutputChunk } from 'rollup';
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
  // When built, this file is in dist/index.js, but loader.js is in the root
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const loaderPath = path.resolve(__dirname, './loader.js');
  let config: any;

  return {
    name: 'vite-plugin-cos',
    apply: 'build',
    enforce: 'post',

    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },

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

    async generateBundle(_options, bundle: OutputBundle) {
      const managedChunks: Record<string, OutputChunk> = {};
      let mainChunk: OutputChunk | null = null;
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
        const chunkInfo: Record<string, { globalVar: string, chunk: OutputChunk }> = {};

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
        const allChunks = Object.values(bundle).filter((c): c is OutputChunk => c.type === 'chunk');

        // Step 2: Rewrite ALL imports that point to chunks in the bundle to use bare specifiers.
        // We use the fileName (e.g. 'assets/vendor-react.js') as a bare specifier.
        // This avoids issues with non-hierarchical base URLs (like blob: or data:).
        // The Import Map will then map these bare specifiers to either COS Data URL shims
        // or absolute paths on the server.
        for (const targetChunk of allChunks) {
          for (const fileName in bundle) {
            const chunk = bundle[fileName];
            if (chunk.type !== 'chunk') continue;

            const chunkBasename = fileName.split('/').pop()!;
            const escapedName = chunkBasename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            // Find relative imports that point to this chunk
            const pattern = `import\\s*(?:(?:\\{\\s*([^}]+)\\s*\\}|\\*\\s+as\\s+([^\\s]+)|([^\\s\\{\\}]+))\\s*from\\s*)?['"]\\.\\/${escapedName}['"];?`;
            const importRegex = new RegExp(pattern, 'g');

            if (importRegex.test(targetChunk.code)) {
              // Use the fileName itself as a bare specifier
              const bareSpecifier = fileName;

              targetChunk.code = targetChunk.code.replace(importRegex, (_match: string, named?: string, namespace?: string, defaultImport?: string) => {
                if (named) {
                  return `import {${named}} from "${bareSpecifier}";`;
                } else if (namespace) {
                  return `import * as ${namespace} from "${bareSpecifier}";`;
                } else if (defaultImport) {
                  return `import ${defaultImport} from "${bareSpecifier}";`;
                } else {
                  return `import "${bareSpecifier}";`;
                }
              });
            }
          }
        }

        // Step 3 (Removed): Replaced by unified Step 2 bare-specifier rewriting.


        // Step 4: Calculate final hashes and build manifest for ALL chunks
        const manifest: Record<string, any> = {};
        const base = config.base.endsWith('/') ? config.base : config.base + '/';

        for (const fileName in bundle) {
          const chunk = bundle[fileName];
          if (chunk.type !== 'chunk') continue;

          if (chunkInfo[fileName]) {
            const { globalVar } = chunkInfo[fileName];
            const finalHash = crypto.createHash('sha256').update(chunk.code).digest('hex');

            // Detect if the chunk has a default export
            const hasDefault = /export\s+\{\s*([^}]+\s+as\s+)?default\s*\}/.test(chunk.code) ||
              /export\s+default\s+/.test(chunk.code);

            manifest[fileName] = {
              fileName: fileName,
              file: `${base}${fileName}`,
              hash: finalHash,
              globalVar: globalVar,
              hasDefault
            };
          } else {
            // Unmanaged chunk - still include in manifest so it can be mapped in Import Map
            manifest[fileName] = {
              fileName: fileName,
              file: `${base}${fileName}`,
              unmanaged: true
            };
          }
        }


        manifest['index'] = {
          file: `${config.base.endsWith('/') ? config.base : config.base + '/'}${mainChunk.fileName}`
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
