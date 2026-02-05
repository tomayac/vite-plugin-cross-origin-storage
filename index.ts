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
      },
    },

    async generateBundle(_options, bundle: OutputBundle) {
      const managedChunks: Record<string, OutputChunk> = {};
      let mainChunk: OutputChunk | null = null;
      let htmlAsset: any = null;

      for (const fileName in bundle) {
        const chunk = bundle[fileName];
        if (chunk.type === 'chunk') {
          if (chunk.isEntry) {
            console.log(`COS Plugin: [ENTRY] ${fileName}`);
            mainChunk = chunk;
          } else {
            // Apply filter to determine if this chunk should be managed by COS
            const res = filter(fileName);
            console.log(
              `COS Plugin: [FILTER] ${fileName} -> ${res ? 'INCLUDE' : 'SKIP'}`
            );
            if (res) {
              managedChunks[fileName] = chunk;
            }
          }
        }
        if (fileName === 'index.html' && chunk.type === 'asset') {
          htmlAsset = chunk;
        }
      }

      if (mainChunk) {
        // Collect ALL chunks to rewrite imports in them
        const allChunks = Object.values(bundle).filter(
          (c): c is OutputChunk => c.type === 'chunk'
        );

        const managedChunkNames = new Set(Object.keys(managedChunks));

        const base = config.base.endsWith('/')
          ? config.base
          : config.base + '/';

        // Step 1: Assign stable global variables to managed chunks
        const managedChunkInfo: Record<
          string,
          { globalVar: string; chunk: OutputChunk }
        > = {};
        for (const fileName in managedChunks) {
          const nameHash = crypto
            .createHash('sha256')
            .update(fileName)
            .digest('hex')
            .substring(0, 8);
          managedChunkInfo[fileName] = {
            globalVar: `__COS_CHUNK_${nameHash}__`,
            chunk: managedChunks[fileName],
          };
        }

        // Step 2: Rewrite imports to use bare specifiers where required.
        // We only MUST rewrite imports that originate from a managed chunk (as they run in a Blob URL)
        // or that target a managed chunk (to redirect to the COS shim).
        for (const targetChunk of allChunks) {
          const isTargetManaged = managedChunkNames.has(targetChunk.fileName);
          const importerDir = path.dirname(targetChunk.fileName);

          for (const depFileName in bundle) {
            const depChunk = bundle[depFileName];
            if (!depChunk || depChunk.type !== 'chunk') continue;

            const isDepManaged = managedChunkNames.has(depFileName);

            // ONLY rewrite if the importer is a blob OR the dependency is a blob.
            // Relative imports between unmanaged chunks are left untouched.
            if (isTargetManaged || isDepManaged) {
              let relPath = path.relative(importerDir, depFileName);
              if (!relPath.startsWith('.')) relPath = './' + relPath;
              const escapedRelPath = relPath.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&'
              );

              // Relative path for Direct Data URL replacement in loader
              const bareSpecifier = `./${depFileName}`;

              // 1. Static imports/exports: (import|export) ... from "./path"
              // Uses a negative lookahead to ensure we don't match across multiple statements.
              // We use \b and \s* to handle minified code where spaces may be missing (e.g., import{...}from"./...").
              const staticPattern = `(import|export)\\b\\s*((?:(?!\\bimport\\b|\\bexport\\b)[\\s\\S])*?\\bfrom\\b\\s*)?['"]${escapedRelPath}['"]\\s*;?`;
              const staticRegex = new RegExp(staticPattern, 'g');

              targetChunk.code = targetChunk.code.replace(
                staticRegex,
                (match, keyword, fromPart) => {
                  return `${keyword}${fromPart ? ' ' + fromPart : ' '}"${bareSpecifier}";`;
                }
              );

              // 2. Dynamic imports: import("./path")
              const dynamicPattern = `import\\s*\\(\\s*['"]${escapedRelPath}['"]\\s*\\)`;
              const dynamicRegex = new RegExp(dynamicPattern, 'g');
              targetChunk.code = targetChunk.code.replace(
                dynamicRegex,
                () => `import("${bareSpecifier}")`
              );
            }
          }
        }

        // Step 4: Calculate final hashes and build manifest for MANAGED chunks only.
        const manifest: Record<string, any> = {};

        for (const fileName in managedChunkInfo) {
          const { chunk, globalVar } = managedChunkInfo[fileName];
          const finalHash = crypto
            .createHash('sha256')
            .update(chunk.code)
            .digest('hex');

          // Detect if the chunk has a default export using Rollup's reliable metadata
          const hasDefault = chunk.exports.includes('default');

          manifest[fileName] = {
            fileName: fileName,
            file: `${base}${fileName}`,
            hash: finalHash,
            globalVar: globalVar,
            hasDefault,
          };
        }

        const entryFileName = mainChunk.fileName;
        manifest['index'] = {
          fileName: entryFileName,
          file: `${base}${entryFileName}`,
        };

        // Inject loader and inlined manifest into index.html
        if (htmlAsset) {
          try {
            let loaderCode = fs.readFileSync(loaderPath, 'utf-8');
            loaderCode = loaderCode.replace(
              '__COS_MANIFEST__',
              JSON.stringify(manifest)
            );

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
    },
  };
}
