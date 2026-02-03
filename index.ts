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

        const managedChunkNames = new Set(Object.keys(managedChunks));
        const chunksNeededInImportMap = new Set<string>(managedChunkNames);

        // Transitively find all unmanaged chunks that managed chunks depend on.
        // These MUST be in the Import Map so that Blob URLs can find them via bare specifiers.
        const queue = Array.from(managedChunkNames);
        while (queue.length > 0) {
          const currentName = queue.shift()!;
          const chunk = bundle[currentName] as OutputChunk;
          if (!chunk) continue;
          [...chunk.imports, ...chunk.dynamicImports].forEach(dep => {
            if (!chunksNeededInImportMap.has(dep)) {
              chunksNeededInImportMap.add(dep);
              const depChunk = bundle[dep];
              if (depChunk && depChunk.type === 'chunk' && !managedChunkNames.has(dep)) {
                queue.push(dep);
              }
            }
          });
        }

        // Step 2: Rewrite imports to use bare specifiers where required.
        for (const targetChunk of allChunks) {
          const importerDir = path.dirname(targetChunk.fileName);

          // Iterate over all chunks in the bundle to find and rewrite relative imports
          // which point to managed chunks or which originate from managed chunks.
          for (const depFileName in bundle) {
            const depChunk = bundle[depFileName];
            if (!depChunk || depChunk.type !== 'chunk') continue;

            // Calculate the exact relative path Rollup likely used
            let relPath = path.relative(importerDir, depFileName);
            if (!relPath.startsWith('.')) relPath = './' + relPath;
            const escapedRelPath = relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            // 1. Regex for static imports: import ... from "./path/to/dep.js"
            const staticPattern = `import\\s*(?:(?:\\{\\s*([^}]+)\\s*\\}|\\*\\s+as\\s+([^\\s]+)|([^\\s\\{\\}]+))\\s*from\\s*)?['"]${escapedRelPath}['"];?`;
            const staticRegex = new RegExp(staticPattern, 'g');

            // 2. Regex for dynamic imports: import("./path/to/dep.js")
            const dynamicPattern = `import\\s*\\(\\s*['"]${escapedRelPath}['"]\\s*\\)`;
            const dynamicRegex = new RegExp(dynamicPattern, 'g');

            // 3. Regex for exports: export ... from "./path/to/dep.js"
            const exportPattern = `export\\s*(?:(?:\\{\\s*([^}]+)\\s*\\}|\\*\\s*(?:as\\s+([^\\s]+))?))\\s*from\\s*['"]${escapedRelPath}['"];?`;
            const exportRegex = new RegExp(exportPattern, 'g');

            const isDepManaged = managedChunkNames.has(depFileName);
            const isTargetManaged = managedChunkNames.has(targetChunk.fileName);

            // We rewrite if the destination is managed (to hit the COS shim)
            // OR if the target is managed (to escape the blob: sandbox).
            if (isDepManaged || isTargetManaged) {
              const bareSpecifier = depFileName;

              // Rewrite static imports
              targetChunk.code = targetChunk.code.replace(staticRegex, (_match: string, named?: string, namespace?: string, defaultImport?: string) => {
                if (named) return `import {${named}} from "${bareSpecifier}";`;
                if (namespace) return `import * as ${namespace} from "${bareSpecifier}";`;
                if (defaultImport) return `import ${defaultImport} from "${bareSpecifier}";`;
                return `import "${bareSpecifier}";`;
              });

              // Rewrite dynamic imports
              targetChunk.code = targetChunk.code.replace(dynamicRegex, () => `import("${bareSpecifier}")`);

              // Rewrite exports
              targetChunk.code = targetChunk.code.replace(exportRegex, (_match: string, named?: string, namespace?: string) => {
                if (named) return `export {${named}} from "${bareSpecifier}";`;
                if (namespace) return `export * as ${namespace} from "${bareSpecifier}";`;
                return `export * from "${bareSpecifier}";`;
              });
            }
          }
        }


        // Step 4: Calculate final hashes and build manifest for required chunks
        const manifest: Record<string, any> = {};
        const base = config.base.endsWith('/') ? config.base : config.base + '/';

        for (const fileName in bundle) {
          const chunk = bundle[fileName];
          if (chunk.type !== 'chunk') continue;

          // Only include in manifest if managed or required by a managed chunk
          if (chunksNeededInImportMap.has(fileName)) {
            if (managedChunkNames.has(fileName)) {
              const { globalVar } = chunkInfo[fileName];
              const finalHash = crypto.createHash('sha256').update(chunk.code).digest('hex');

              // Detect if the chunk has a default export using Rollup's reliable metadata
              const hasDefault = chunk.exports.includes('default');

              manifest[fileName] = {
                fileName: fileName,
                file: `${base}${fileName}`,
                hash: finalHash,
                globalVar: globalVar,
                hasDefault
              };
            } else {
              // Unmanaged chunk needed for Import Map resolution
              manifest[fileName] = {
                fileName: fileName,
                file: `${base}${fileName}`,
                unmanaged: true
              };
            }
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
