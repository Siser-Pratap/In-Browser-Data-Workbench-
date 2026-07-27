import type { NextConfig } from 'next';

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
    return config;
  },
};

export default nextConfig;
