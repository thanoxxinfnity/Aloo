/**
 * ALOO — static export for the Android (Capacitor) build.
 * ===========================================================================
 * `next build` with `output: 'export'` refuses to run while API routes exist —
 * a static bundle has no server to run them on. The web build genuinely needs
 * those routes (they solve CORS and stream SSE), so we cannot simply delete
 * them.
 *
 * This script moves `pages/api` aside for the duration of the export and puts
 * it back afterwards. The restore runs in a `finally` plus process-signal
 * handlers, so an interrupted build can never leave the repo missing its API
 * routes — and a previous crashed run is recovered rather than clobbered.
 *
 * The native build reaches the providers directly instead — see lib/runtime.js.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = join(root, 'pages', 'api');
const stashDir = join(root, '.api-stash');

let stashed = false;

function restore() {
  if (stashed && existsSync(stashDir)) {
    renameSync(stashDir, apiDir);
    stashed = false;
    console.log('[build-static] Restored pages/api');
  }
}

// Even a SIGINT must not leave the repo mutilated.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    restore();
    process.exit(1);
  });
}

try {
  if (existsSync(stashDir)) {
    // A previous run died before restoring — recover rather than clobber.
    if (!existsSync(apiDir)) renameSync(stashDir, apiDir);
    else rmSync(stashDir, { recursive: true, force: true });
  }

  if (existsSync(apiDir)) {
    renameSync(apiDir, stashDir);
    stashed = true;
    console.log('[build-static] Stashed pages/api (a static export cannot host API routes)');
  }

  rmSync(join(root, 'out'), { recursive: true, force: true });
  rmSync(join(root, '.next'), { recursive: true, force: true });

  const result = spawnSync('npx', ['next', 'build'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ALOO_STATIC: '1' },
  });

  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else console.log('[build-static] Static bundle written to ./out');
} finally {
  restore();
}
