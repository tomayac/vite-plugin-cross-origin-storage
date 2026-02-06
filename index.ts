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
  const filter = (options.include || options.exclude)
    ? createFilter(options.include || ['**/*'], options.exclude, { resolve: false })
    : () => true;

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
            // Check against both the full fileName and the chunk name for better usability
            const res = filter(fileName) || filter(chunk.name);
            console.log(
              `COS Plugin: [FILTER] ${fileName} (name: ${chunk.name}) -> ${res ? 'INCLUDE' : 'SKIP'}`
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
        const unmanagedDependencies = new Set<string>();

        const base = config.base.endsWith('/')
          ? config.base
          : config.base + '/';

        // Step 1: Rewrite imports to use bare specifiers where required.
        // We only MUST rewrite imports that originate from a managed chunk (as they run in a Blob URL)
        // or that target a managed chunk (to redirect to the COS shim).
        for (const targetChunk of allChunks) {
          const isTargetManaged = managedChunkNames.has(targetChunk.fileName);
          const importerDir = path.dirname(targetChunk.fileName);

          // Get all direct dependencies of this chunk
          const deps = [...targetChunk.imports, ...targetChunk.dynamicImports];

          for (const depFileName of deps) {
            const depChunk = bundle[depFileName];
            if (!depChunk || depChunk.type !== 'chunk') continue;

            const isDepManaged = managedChunkNames.has(depFileName);

            // ONLY rewrite if the importer is managed OR the dependency is managed.
            // If the importer is a blob, it MUST use bare specifiers for everything.
            // If the dependency is a blob, everyone MUST use bare specifiers to access it.
            if (isTargetManaged || isDepManaged) {
              let relPath = path.relative(importerDir, depFileName);
              if (!relPath.startsWith('.')) relPath = './' + relPath;
              const escapedRelPath = relPath.replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&'
              );

              // Truly Bare specifier for Import Map mapping.
              const bareSpecifier = `coschunk-${depFileName.replace(/\//g, '-')}`;

              // 1. Static imports/exports: (import|export) ... from "./path"
              const staticPattern = `(import|export)\\b\\s*((?:(?!\\bimport\\b|\\bexport\\b)[\\s\\S])*?\\bfrom\\b\\s*)?['"]${escapedRelPath}['"]\\s*;?`;
              const staticRegex = new RegExp(staticPattern, 'g');

              targetChunk.code = targetChunk.code.replace(staticRegex, (match, keyword, fromPart) => {
                return `${keyword}${fromPart ? ' ' + fromPart : ' '}"${bareSpecifier}";`;
              });

              // 2. Dynamic imports: import("./path")
              const dynamicPattern = `import\\s*\\(\\s*['"]${escapedRelPath}['"]\\s*\\)`;
              const dynamicRegex = new RegExp(dynamicPattern, 'g');
              targetChunk.code = targetChunk.code.replace(
                dynamicRegex,
                () => `import("${bareSpecifier}")`
              );

              if (!isDepManaged) {
                unmanagedDependencies.add(depFileName);
              }
            }
          }
        }

        // Step 2: Ensure managed chunks can resolve unmanaged chunks they depend on.
        // Managed chunks run as Data URLs, so they can't resolve root-relative paths.
        // We include these unmanaged dependencies in the manifest so the loader can
        // add them to the import map with fully qualified URLs.

        // Step 3: Calculate final hashes and build manifest for MANAGED chunks only.
        const manifest: Record<string, any> = {
          base,
          entry: mainChunk.fileName,
          chunks: {},
        };

        for (const fileName in managedChunks) {
          const chunk = managedChunks[fileName];
          const finalHash = crypto
            .createHash('sha256')
            .update(chunk.code)
            .digest('hex');

          manifest.chunks[fileName] = finalHash;
        }

        manifest.unmanaged = Array.from(unmanagedDependencies);

        // Inject loader and inlined manifest into index.html
        if (htmlAsset) {
          try {
            let loaderCode = fs.readFileSync(loaderPath, 'utf-8');
            loaderCode = loaderCode.replace(
              '__COS_MANIFEST__',
              JSON.stringify(manifest, null, 2)
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
