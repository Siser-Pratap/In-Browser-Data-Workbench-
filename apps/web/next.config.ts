import { createRequire } from 'node:module';

import type { NextConfig } from 'next';

const require_ = createRequire(import.meta.url);

/**
 * DuckDB-WASM's multi-threaded build needs `SharedArrayBuffer`, which browsers
 * only expose to cross-origin-isolated pages. That isolation is what these two
 * headers buy — without them DuckDB silently falls back to the single-threaded
 * bundle and large queries get much slower.
 *
 * The cost is that every cross-origin subresource must opt in via CORP/CORS.
 * We self-host the WASM bundle (see `scripts/copy-duckdb.mjs`) partly for that
 * reason: a CDN that doesn't send the right headers would simply fail to load.
 */
const crossOriginIsolation = [
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: '/:path*', headers: crossOriginIsolation }];
  },
  webpack(config) {
    // DuckDB ships .wasm and worker bundles; let webpack emit them as assets
    // rather than trying to parse them.
    config.module.rules.push({
      test: /\.wasm$/,
      type: 'asset/resource',
    });

    // Monaco's package exports map appends `.js` to every subpath, so its
    // stylesheets are unreachable by package specifier — see
    // src/lib/editor/monaco-sql.ts. Resolving the package's own entry and
    // walking up to the file keeps this working under pnpm's symlinked layout,
    // where a hardcoded node_modules path would not.
    config.resolve.alias = {
      ...config.resolve.alias,
      'monaco-codicon-modifiers.css': require_
        .resolve('monaco-editor/editor/editor.api.js')
        .replace(
          /esm[/\\]vs[/\\]editor[/\\]editor\.api\.js$/,
          'esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css',
        ),
    };

    return config;
  },
};

export default nextConfig;
