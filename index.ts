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

        // Step 2: Rewrite imports TO managed chunks in ALL chunks
        // This modifies the importers to look for the global variable (Blob URL)
        for (const targetChunk of allChunks) {
          for (const fileName in chunkInfo) {
            // Avoid self-reference
            if (targetChunk.fileName === fileName) continue;

            const { globalVar } = chunkInfo[fileName];
            const chunkBasename = fileName.split('/').pop()!;
            const escapedName = chunkBasename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            // Robust regex to find static imports of the managed chunk
            // Handles:
            // import { a, b } from "./foo.js"
            // import * as x from "./foo.js"
            // import x from "./foo.js"
            // import "./foo.js"
            const pattern = `import\\s*(?:(?:\\{\\s*([^}]+)\\s*\\}|\\*\\s+as\\s+([^\\s]+)|([^\\s\\{\\}]+))\\s*from\\s*)?['"]\\.\\/${escapedName}['"];?`;
            const importRegex = new RegExp(pattern, 'g');

            if (importRegex.test(targetChunk.code)) {
              const base = config.base.endsWith('/') ? config.base : config.base + '/';
              const absoluteUrl = `new URL("${base}${fileName}", document.baseURI).href`;

              targetChunk.code = targetChunk.code.replace(importRegex, (_match: string, named?: string, namespace?: string, defaultImport?: string) => {
                const fallback = `await import(${absoluteUrl})`;

                if (named) {
                  const destructuringPattern = named.split(',').map(b => {
                    const parts = b.trim().split(/\s+as\s+/);
                    return parts.length === 2 ? `${parts[0]}:${parts[1]}` : parts[0];
                  }).join(',');
                  return `const {${destructuringPattern}}=await import(window.${globalVar}||${absoluteUrl});`;
                } else if (namespace) {
                  return `const ${namespace}=await import(window.${globalVar}||${absoluteUrl});`;
                } else if (defaultImport) {
                  return `const ${defaultImport}=(await import(window.${globalVar}||${absoluteUrl})).default;`;
                } else {
                  // Side-effect import
                  return `await import(window.${globalVar}||${absoluteUrl});`;
                }
              });
            }
          }
        }

        // Step 3: Rewrite imports to UNMANAGED chunks in MANAGED chunks.
        // Managed chunks are loaded via Blob URLs. Relative imports fail in Blob URLs.
        for (const fileName in managedChunks) {
          const chunk = managedChunks[fileName];
          chunk.imports.forEach((importedFile: string) => {
            if (!chunkInfo[importedFile]) {
              const importedBasename = importedFile.split('/').pop()!;
              const escapedName = importedBasename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

              const pattern = `import\\s*(?:(?:\\{\\s*([^}]+)\\s*\\}|\\*\\s+as\\s+([^\\s]+)|([^\\s\\{\\}]+))\\s*from\\s*)?['"]\\.\\/${escapedName}['"];?`;
              const importRegex = new RegExp(pattern, 'g');

              if (importRegex.test(chunk.code)) {
                const base = config.base.endsWith('/') ? config.base : config.base + '/';
                const absoluteUrl = `new URL("${base}${importedFile}", document.baseURI).href`;

                chunk.code = chunk.code.replace(importRegex, (_match: string, named?: string, namespace?: string, defaultImport?: string) => {
                  if (named) {
                    const destructuringPattern = named.split(',').map(b => {
                      const parts = b.trim().split(/\s+as\s+/);
                      return parts.length === 2 ? `${parts[0]}:${parts[1]}` : parts[0];
                    }).join(',');
                    return `const {${destructuringPattern}}=await import(${absoluteUrl});`;
                  } else if (namespace) {
                    return `const ${namespace}=await import(${absoluteUrl});`;
                  } else if (defaultImport) {
                    return `const ${defaultImport}=(await import(${absoluteUrl})).default;`;
                  } else {
                    return `await import(${absoluteUrl});`;
                  }
                });
              }
            }
          });
        }

        // Step 4: Calculate final hashes and build manifest
        // Now that code is modified (rewritten), we calculate the hash of the ACTUAL content that will be on disk.
        const manifest: Record<string, any> = {};
        for (const fileName in chunkInfo) {
          const { chunk, globalVar } = chunkInfo[fileName];
          const finalHash = crypto.createHash('sha256').update(chunk.code).digest('hex');

          // Detect if the chunk has a default export
          // Rollup typically outputs "export { name as default }" for default exports in ES modules
          const hasDefault = /export\s+\{\s*([^}]+\s+as\s+)?default\s*\}/.test(chunk.code) ||
            /export\s+default\s+/.test(chunk.code);

          const base = config.base.endsWith('/') ? config.base : config.base + '/';
          manifest[fileName] = {
            file: `${base}${fileName}`,
            hash: finalHash,
            globalVar: globalVar,
            hasDefault
          };
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
