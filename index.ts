import type { Plugin } from 'vite';
import type { OutputChunk } from 'rollup';
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

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const loaderPath = path.resolve(__dirname, './loader.js'); // loader.js is copied to dist/ during build
  let config: any;

  const cwdRequire = createRequire(path.join(process.cwd(), 'index.js'));
  const esbuildRequire = createRequire(import.meta.url);
  const esbuild = esbuildRequire('esbuild');

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

      for (const item of includeArray) {
        const pkgName = getPackageName(item);
        if (pkgName) {
          try {
            cwdRequire.resolve(pkgName);
            const externalPatterns = [pkgName, `${pkgName}/*`];
            for (const pattern of externalPatterns) {
              if (!externalArray.includes(pattern)) {
                console.log(
                  `COS Plugin: [MAGIC] Externalizing pattern "${pattern}" (matched from ${item})`
                );
                externalArray.push(pattern);
              }
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
          /<script\s+[^>]*type=["']module["'][^>]*src=["'][^"']+["'][^>]*><\/script>/gi,
          '<!-- Entry script disabled by COS Plugin -->'
        );
      },
    },

    async generateBundle(_options, bundle: Record<string, any>) {
      const managedChunks: Record<string, OutputChunk> = {};
      let mainChunk: OutputChunk | null = null;
      const htmlAssets: any[] = [];

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
        if (fileName.endsWith('.html') && chunk.type === 'asset') {
          htmlAssets.push(chunk);
        }
      }

      const externalToFileName: Record<string, string> = {};

      // Handle Magic externals
      for (const item of includeArray) {
        const pkgName = getPackageName(item);
        if (!pkgName) continue;

        try {
          let pkgPath = '';
          try {
            const mainPath = cwdRequire.resolve(pkgName);
            let currentDir = path.dirname(mainPath);
            let pkgJsonPath = '';
            while (currentDir !== path.parse(currentDir).root) {
              const candidate = path.join(currentDir, 'package.json');
              if (fs.existsSync(candidate)) {
                pkgJsonPath = candidate;
                break;
              }
              currentDir = path.dirname(currentDir);
            }

            if (pkgJsonPath) {
              const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
              const pkgDir = path.dirname(pkgJsonPath);

              if (pkgJson.module) {
                pkgPath = path.resolve(pkgDir, pkgJson.module);
              } else if (pkgJson.exports?.['.']?.import) {
                pkgPath = path.resolve(pkgDir, pkgJson.exports['.'].import);
              } else if (pkgJson.exports?.import) {
                pkgPath = path.resolve(pkgDir, pkgJson.exports.import);
              }
            }

            if (!pkgPath) {
              pkgPath = mainPath;
            }
          } catch (e) {
            pkgPath = cwdRequire.resolve(pkgName);
          }

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

          // Always use .js extension
          const ext = '.js';
          const fileName = path.join(
            config.build.assetsDir,
            `${pkgName}-${hash.slice(0, 8)}${ext}`
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
            code: Buffer.from(content).toString('utf-8'),
            name: item,
          } as any;

          // Mapping for import rewriting
          externalToFileName[pkgName] = fileName;
        } catch (e) {
          // Not a magic package or couldn't resolve
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

        // Inject loader and inlined manifest into all HTML assets
        if (htmlAssets.length > 0) {
          let loaderCode: string;
          try {
            loaderCode = fs.readFileSync(loaderPath, 'utf-8');
          } catch (e) {
            console.error('COS Plugin: Failed to read loader.js', e);
            return;
          }
          loaderCode = loaderCode.replace(
            '__COS_MANIFEST__',
            JSON.stringify(manifest, null, 2)
          );
          for (const htmlAsset of htmlAssets) {
            let htmlSource = htmlAsset.source as string;
            htmlSource = htmlSource.replace(
              /<link\s+[^>]*rel=["']modulepreload["'][^>]*>/gi,
              '<!-- modulepreload disabled by COS Plugin -->'
            );
            htmlAsset.source = htmlSource.replace(
              '<head>',
              () => `<head>\n<script id="cos-loader">${loaderCode}</script>`
            );
          }
        }
      }
    },
  };
}
