import { defineConfig } from 'vite';

/**
 * The PHP build we ship, written the way the `@php-wasm/web-X-Y` package
 * names spell it. Keep in sync with PHP_VERSION in src/php-worker.js.
 */
const SHIPPED_PHP_BUILD = '8-4';

/**
 * Vite plugin: keep the production bundle small.
 *
 * `@php-wasm/web` contains a `switch` that dynamically imports *every* PHP
 * build it knows about (5.2 … 8.5). Rollup follows each of those imports and
 * would copy ~40 MB of .wasm per version into dist/. We only ever load one
 * version, so every other build is resolved to an empty stub module here.
 *
 * The same trick drops the 30 MB ICU data file and the `.so` bundles, which
 * are only used by the optional `intl` extension that this app never loads.
 */
function stubUnusedPhpAssets() {
  const STUB_ID = '\0php-wasm-stub';
  const phpBuildPackage = /^@php-wasm\/web-(\d-\d)$/;
  const optionalAsset = /(icu\.dat|\.so)(\?url)?$/;

  return {
    name: 'stub-unused-php-wasm-assets',
    enforce: 'pre',
    async resolveId(id, importer) {
      const match = id.match(phpBuildPackage);
      if (match && match[1] !== SHIPPED_PHP_BUILD) return STUB_ID;
      if (optionalAsset.test(id)) return STUB_ID;

      // The PHP loader does `import wasmUrl from './php_8_4.wasm'`. Turn that
      // into an explicit `?url` import so Vite emits the file as an asset and
      // hands back its URL — consistently in dev, build, and worker bundles.
      if (id.endsWith('.wasm')) {
        const resolved = await this.resolve(id, importer, { skipSelf: true });
        if (resolved) return `${resolved.id}?url`;
      }
      return null;
    },
    load(id) {
      if (id !== STUB_ID) return null;
      return `
        export default '';
        export function getPHPLoaderModule() {
          throw new Error('This PHP build is not bundled with PHP Terminal Trainer.');
        }
        export function getIntlExtensionPath() {
          throw new Error('The intl extension is not bundled with PHP Terminal Trainer.');
        }
      `;
    },
  };
}

export default defineConfig({
  plugins: [stubUnusedPhpAssets()],

  // These binary files are imported by @php-wasm/web with `import` syntax.
  // Telling Vite they are assets makes the import resolve to a URL.
  // (This list comes straight from the @php-wasm/web README.)
  assetsInclude: [/\.dat$/, /\.wasm$/, /\.so$/, /\.la$/],

  optimizeDeps: {
    // @php-wasm/web must not be pre-bundled: its .wasm/.dat imports have to
    // go through the plugin above. Its dependencies, however, include
    // CommonJS packages (e.g. `ini`), which only work in the browser when
    // Vite pre-bundles them — so they are listed explicitly in `include`.
    exclude: ['@php-wasm/web'],
    include: [
      '@php-wasm/universal',
      '@php-wasm/web-service-worker',
      '@php-wasm/fs-journal',
      '@php-wasm/logger',
      '@php-wasm/util',
      '@wp-playground/common',
      'wasm-feature-detect',
    ],
  },

  worker: {
    // The PHP runtime uses dynamic import() inside the worker, which only
    // works with ES-module workers.
    format: 'es',
    // Plugins listed in `plugins` above only apply to workers in dev;
    // for production builds the worker bundle needs them here as well.
    plugins: () => [stubUnusedPhpAssets()],
  },

  build: {
    target: 'esnext',
    // The PHP runtime JS glue is a few MB; the warning is expected.
    chunkSizeWarningLimit: 4000,
  },
});
