/**
 * Copy the DuckDB-WASM bundles out of node_modules into `public/duckdb/`.
 *
 * DuckDB ships several builds (mvp / eh / coi) and picks one at runtime based
 * on what the browser supports. They must be served from our own origin: the
 * app sets COEP `require-corp` for SharedArrayBuffer, so a CDN that doesn't
 * send `Cross-Origin-Resource-Policy` would be blocked outright. Self-hosting
 * also means the workbench keeps working offline, which matters for a tool
 * whose whole pitch is that your data never leaves the machine.
 *
 * Runs from `predev` and `prebuild`; `public/duckdb/` is gitignored.
 */
import { cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/*
 * The DuckDB *engine* version inside the pinned `@duckdb/duckdb-wasm` release,
 * and the loadable extensions we self-host. DuckDB fetches extensions from
 * `{repo}/v{ENGINE_VERSION}/wasm_eh/{name}.duckdb_extension.wasm` at runtime;
 * mirroring that layout under public/ and pointing the engine at it (see
 * engine.ts `custom_extension_repository`) keeps imports working with no CDN
 * call — required for offline use and consistent with "nothing leaves the
 * browser". `json` backs both JSON and Excel import; bump this in lockstep with
 * the duckdb-wasm pin.
 */
const ENGINE_VERSION = 'v1.1.1'; // @duckdb/duckdb-wasm@1.29.0
// `json` backs JSON and Excel import; `parquet` backs Parquet. Both are
// autoloadable extensions in this DuckDB — pointing the engine at our mirror
// (engine.ts) means it looks *here* for every extension, so any format that
// autoloads one must be mirrored or its import hangs on a 404.
const EXTENSIONS = ['json', 'parquet'];
const EXTENSION_PLATFORM = 'wasm_eh';
const EXTENSION_REPO = 'https://extensions.duckdb.org';

// Resolved by path rather than `require.resolve`: the package's `exports` map
// doesn't expose ./package.json, and its dist/ isn't exported either.
const distDir = join(process.cwd(), 'node_modules', '@duckdb', 'duckdb-wasm', 'dist');
const outDir = join(process.cwd(), 'public', 'duckdb');

try {
  await stat(distDir);
} catch {
  console.error(`DuckDB dist not found at ${distDir} — run \`pnpm install\` first.`);
  process.exit(1);
}

await mkdir(outDir, { recursive: true });

// The .wasm binaries and the worker entry points DuckDB loads at runtime.
// Source maps and the bundler-facing .mjs/.cjs builds stay in node_modules.
const wanted = (name) =>
  name.endsWith('.wasm') || (name.endsWith('.worker.js') && !name.endsWith('.map'));

const entries = await readdir(distDir);
const copied = [];
for (const entry of entries) {
  if (!wanted(entry)) continue;
  await cp(join(distDir, entry), join(outDir, entry));
  copied.push(entry);
}

if (copied.length === 0) {
  console.error('No DuckDB bundles found in', distDir);
  process.exit(1);
}
console.log(`Copied ${copied.length} DuckDB assets to public/duckdb/`);

// Self-host the loadable extensions, mirroring the repository's path layout so
// the engine's autoloader finds them on our own origin. Downloaded once and
// cached; a network hiccup at build time isn't fatal (the CDN remains the
// fallback at runtime), but a successful mirror is what makes offline work.
const extDir = join(outDir, 'extensions', ENGINE_VERSION, EXTENSION_PLATFORM);
await mkdir(extDir, { recursive: true });

for (const name of EXTENSIONS) {
  const file = `${name}.duckdb_extension.wasm`;
  const dest = join(extDir, file);
  try {
    await stat(dest);
    console.log(`Extension ${name} already present`);
    continue;
  } catch {
    // Not cached yet — fetch it.
  }
  const url = `${EXTENSION_REPO}/${ENGINE_VERSION}/${EXTENSION_PLATFORM}/${file}`;
  const ok = await download(url, dest);
  if (ok) console.log(`Downloaded extension ${name} from ${url}`);
  else
    console.warn(
      `Could not download the ${name} extension; the runtime will fall back ` +
        `to the CDN for it. Re-run once the network is available to self-host it.`,
    );
}

/** Fetch to a file, with a couple of retries — the CDN occasionally blips. */
async function download(url, dest, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await writeFile(dest, Buffer.from(await response.arrayBuffer()));
      return true;
    } catch {
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  return false;
}
