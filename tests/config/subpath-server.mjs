// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Runs iHub the way it runs behind a reverse proxy on a path prefix, for the
 * subpath suite (`playwright.subpath.config.js`).
 *
 * - The production server (`NODE_ENV=production`) serves the built client
 *   (`client/dist`, build it first: `cd client && npm run build`), on its own
 *   `contents-subpath/` seeded like the e2e contents (`e2e-contents.mjs`).
 * - A small proxy in front of it plays the reverse proxy: it answers only under
 *   `PREFIX` (default `/ihub`), strips the prefix and sets `X-Forwarded-Prefix`, as
 *   docs/production-reverse-proxy-guide.md describes. Anything outside the prefix is
 *   a 404, so a link that forgets the prefix does not work here, as it would not in
 *   production.
 *
 * Environment: SUBPATH_PREFIX (/ihub), SUBPATH_PORT (5174, the public port),
 * SUBPATH_APP_PORT (3100), E2E_LLM_PORT (8979).
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareE2eContents } from './e2e-contents.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREFIX = (process.env.SUBPATH_PREFIX || '/ihub').replace(/\/$/, '');
const PUBLIC_PORT = Number(process.env.SUBPATH_PORT) || 5174;
const APP_PORT = Number(process.env.SUBPATH_APP_PORT) || 3100;
const LLM_PORT = Number(process.env.E2E_LLM_PORT) || 8979;
const CONTENTS_DIR = path.join(root, 'contents-subpath');

const built = path.join(root, 'client', 'dist');
if (!fs.existsSync(path.join(built, 'index.html'))) {
  console.error('client/dist is missing: run `cd client && npm run build` first.');
  process.exit(1);
}

process.chdir(root);
process.env.CONTENTS_DIR = CONTENTS_DIR;
await prepareE2eContents({ root, contentsDir: CONTENTS_DIR, llmPort: LLM_PORT });

// The production server serves `<root>/public`; with APP_ROOT_DIR it takes another
// root, so the repository gets no extra directory (the rest of it is linked in).
const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-subpath-'));
fs.cpSync(built, path.join(appRoot, 'public'), { recursive: true });
// The rest of the repository (shared/i18n, docs, ...) is read from the same root.
for (const entry of fs.readdirSync(root)) {
  if (entry.startsWith('.') || entry === 'public' || entry.startsWith('contents')) continue;
  fs.symlinkSync(path.join(root, entry), path.join(appRoot, entry));
}
process.on('exit', () => fs.rmSync(appRoot, { recursive: true, force: true }));

const app = spawn(process.execPath, ['server/server.js'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'production',
    WORKERS: '1',
    HOST: '127.0.0.1',
    PORT: String(APP_PORT),
    CONTENTS_DIR,
    APP_ROOT_DIR: appRoot,
    TELEMETRY_ENABLED: 'false'
  }
});

const proxy = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url !== PREFIX && !url.startsWith(`${PREFIX}/`) && !url.startsWith(`${PREFIX}?`)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end(`Not found: ${url} is outside ${PREFIX}`);
    return;
  }
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: APP_PORT,
      method: req.method,
      path: url.slice(PREFIX.length) || '/',
      headers: { ...req.headers, 'x-forwarded-prefix': PREFIX }
    },
    upstreamRes => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );
  upstream.on('error', () => {
    res.writeHead(502);
    res.end('upstream not ready');
  });
  req.pipe(upstream);
});
proxy.listen(PUBLIC_PORT, '127.0.0.1', () => {
  console.log(`subpath proxy: http://127.0.0.1:${PUBLIC_PORT}${PREFIX}/ -> :${APP_PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    app.kill(signal);
    proxy.close();
  });
}
app.on('exit', code => process.exit(code ?? 0));
