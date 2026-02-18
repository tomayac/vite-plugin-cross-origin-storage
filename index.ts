import type { Plugin } from 'vite';
import type { OutputBundle, OutputChunk } from 'rollup';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createFilter } from '@rollup/pluginutils';
import { createRequire } from 'module';

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
  const filter =
    options.include || options.exclude
      ? createFilter(options.include || ['**/*'], options.exclude, {
          resolve: false,
        })
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

    config(config) {
      config.build = config.build || {};
      config.build.rollupOptions = config.build.rollupOptions || {};
      const external = config.build.rollupOptions.external || [];
      const externalArray = Array.isArray(external)
        ? external
        : typeof external === 'string'
          ? [external]
          : [];

      const include = options.include || ['**/*'];
      const includeArray = Array.isArray(include) ? include : [include];

      const require = createRequire(path.join(process.cwd(), 'index.js'));

      function getPackageName(item: string | RegExp): string | null {
        if (typeof item === 'string') {
          return item.startsWith('vendor-') ? item.replace('vendor-', '') : item;
        }
        if (item instanceof RegExp) {
          const source = item.source;
          const match = source.match(/vendor-([a-zA-Z0-9-@/]+?)(?:[-._]|\/|$)/);
          return match ? match[1] : null;
        }
        return null;
      }

      for (const item of includeArray) {
        const pkgName = getPackageName(item);
        if (pkgName) {
          try {
            // Check if it's an installed package
            require.resolve(pkgName);
            // Externalize the package and all its subpaths using a RegExp
            // This robustly prevents Vite from bundling any part of the package
            const pkgRegex = new RegExp(`^${pkgName}(?:/.*)?$`);
            if (!externalArray.some(e => e instanceof RegExp && e.source === pkgRegex.source)) {
              console.log(
                `COS Plugin: [MAGIC] Externalizing package and subpaths: ${pkgRegex} (matched from ${item})`
              );
              externalArray.push(pkgRegex);
            }
          } catch (e) {
            // Not a package, ignore
          }
        }
      }
      config.build.rollupOptions.external = externalArray;
    },

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
          }

          // Apply filter to determine if this chunk should be managed by COS
          // Check against both the full fileName and the chunk name for better usability
          const res = filter(fileName) || filter(chunk.name);
          console.log(
            `COS Plugin: [FILTER] ${fileName} (name: ${chunk.name}) -> ${
              res ? 'INCLUDE' : 'SKIP'
            }`
          );
          if (res) {
            managedChunks[fileName] = chunk;
          }
        }
        if (fileName === 'index.html' && chunk.type === 'asset') {
          htmlAsset = chunk;
        }
      }

      const externalToFileName: Record<string, string> = {};
      // Use process.cwd() to resolve from the project root
      const require = createRequire(path.join(process.cwd(), 'index.js'));
      const include = options.include || ['**/*'];
      const includeArray = Array.isArray(include) ? include : [include];

      function getPackageName(item: string | RegExp): string | null {
        if (typeof item === 'string') {
          return item.startsWith('vendor-') ? item.replace('vendor-', '') : item;
        }
        if (item instanceof RegExp) {
          const source = item.source;
          const match = source.match(/vendor-([a-zA-Z0-9-@/]+?)(?:[-._]|\/|$)/);
          return match ? match[1] : null;
        }
        return null;
      }

      // 1. Identify Magic Packages
      const magicPackages = new Set<string>();
      for (const item of includeArray) {
        const pkgName = getPackageName(item);
        if (pkgName) {
          try {
            require.resolve(pkgName);
            magicPackages.add(pkgName);
          } catch (e) {
            // Not a package, ignore
          }
        }
      }

      // 2. Discover all used specifiers for these packages
      const discoveredSpecifiers = new Set<string>();
      const allChunks = Object.values(bundle).filter(
        (c): c is OutputChunk => c.type === 'chunk'
      );

      for (const chunk of allChunks) {
        const allImports = [...chunk.imports, ...chunk.dynamicImports];
        for (const specifier of allImports) {
          // Check if the specifier belongs to a magic package
          for (const pkgName of magicPackages) {
            if (specifier === pkgName || specifier.startsWith(`${pkgName}/`)) {
              discoveredSpecifiers.add(specifier);
              break;
            }
          }
        }
      }

      // 3. Bundle each discovered specifier as a shared asset
      for (const specifier of discoveredSpecifiers) {
        try {
          const pkgPath = require.resolve(specifier);

          // Load esbuild via require for better ESM/CJS interop
          const esbuildRequire = createRequire(import.meta.url);
          const esbuild = esbuildRequire('esbuild');

          // Use esbuild to create a single self-contained ESM bundle
          const buildResult = await esbuild.build({
            entryPoints: [pkgPath],
            bundle: true,
            format: 'esm',
            minify: true,
            platform: 'browser',
            write: false, // Don't write to disk
            target: 'esnext',
            // Neutralize environment
            define: {
              'process.env.NODE_ENV': '"production"',
            },
          });

          const content = buildResult.outputFiles[0].contents;
          const hash = crypto
            .createHash('sha256')
            .update(content)
            .digest('hex');

          // Always use .js extension as we bundle everything into ESM
          const ext = '.js';
          // Sanitize specifier for filename
          const safeSpecifier = specifier.replace(/[/@]/g, '-').replace(/\.js$/, '');
          const fileName = path.join(
            config.build.assetsDir,
            `${safeSpecifier}-${hash.slice(0, 8)}${ext}`
          );

          this.emitFile({
            type: 'asset',
            fileName,
            source: content,
          });

          // Add to managed chunks so it's included in the manifest
          managedChunks[fileName] = {
            type: 'chunk',
            fileName,
            code: content.toString(),
            name: specifier,
          } as any;

          // Mapping for import rewriting
          externalToFileName[specifier] = fileName;
        } catch (e) {
          console.error(`COS Plugin: Failed to bundle magic specifier "${specifier}"`, e);
        }
      }

      if (mainChunk) {
        const managedChunkNames = new Set(Object.keys(managedChunks));
        const unmanagedDependencies = new Set<string>();

        const base = config.base.endsWith('/')
          ? config.base
          : config.base + '/';

        // Step 1: Rewrite imports to use bare specifiers where required.
        // We rewrite ALL imports that target a chunk in the bundle.
        // This ensures that even if a chunk isn't "managed" (stored in COS),
        // it can still be resolved by managed chunks (which run in Blob URLs).
        for (const targetChunk of allChunks) {
          const importerDir = path.dirname(targetChunk.fileName);

          // Get all direct dependencies of this chunk
          const deps = [...targetChunk.imports, ...targetChunk.dynamicImports];

          for (const depFileName of deps) {
            const depChunk = bundle[depFileName];
            if (!depChunk || depChunk.type !== 'chunk') continue;

            const isDepManaged = managedChunkNames.has(depFileName);

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

            if (!isDepManaged) {
              unmanagedDependencies.add(depFileName);
            }
          }

          // Step 1b: Rewrite imports for magic external dependencies
          for (const pkgName in externalToFileName) {
            // We use the emitted filename for the bare specifier
            const fileName = externalToFileName[pkgName];
            const bareSpecifier = `coschunk-${fileName.replace(/\//g, '-')}`;

            // 1. Static imports/exports
            const staticPattern = `(import|export)\\b\\s*((?:(?!\\bimport\\b|\\bexport\\b)[\\s\\S])*?\\bfrom\\b\\s*)?['"]${pkgName}['"]\\s*;?`;
            const staticRegex = new RegExp(staticPattern, 'g');

            targetChunk.code = targetChunk.code.replace(
              staticRegex,
              (match, keyword, fromPart) => {
                return `${keyword}${fromPart ? ' ' + fromPart : ' '}"${bareSpecifier}";`;
              }
            );

            // 2. Dynamic imports
            const dynamicPattern = `import\\s*\\(\\s*['"]${pkgName}['"]\\s*\\)`;
            const dynamicRegex = new RegExp(dynamicPattern, 'g');
            targetChunk.code = targetChunk.code.replace(
              dynamicRegex,
              () => `import("${bareSpecifier}")`
            );
          }
        }

        // Step 2: Ensure managed chunks can resolve unmanaged chunks they depend on.
        // Managed chunks run as Blob URLs, so they can't resolve root-relative paths.
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

        if (mainChunk && !managedChunkNames.has(mainChunk.fileName)) {
          unmanagedDependencies.add(mainChunk.fileName);
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
