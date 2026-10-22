// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Scans a running iHub with axe-core, signed in as the default local admin,
 * and prints which pages have which violations. Used by the a11y-audit skill.
 *
 *   BASE_URL=http://localhost:5173 PAGES=/prompts,/admin/apps THEMES=light,dark \
 *     node .claude/skills/a11y-audit/scan.mjs out.json
 *
 * Environment:
 *   BASE_URL         default http://localhost:5173
 *   PAGES            comma list of routes; default a small set of user and admin pages
 *   THEMES           light,dark (default light). Dark is forced by setting the
 *                    `dark` class and data-theme on <html> when the app did not apply it
 *                    (admin pages do not read the stored preference).
 *   CHROMIUM_PATH    use this browser binary instead of Playwright's own (needed in
 *                    sandboxes where the pinned Playwright browser is not installed)
 *   TEST_ADMIN_USERNAME / TEST_ADMIN_PASSWORD   default admin / password123
 *
 * The result file holds, per page, every violation with its impact, plus the
 * critical/serious counts per rule (`blocking`) in the shape KNOWN_VIOLATIONS in
 * tests/e2e/accessibility.spec.js uses. Repeat the scan and take the highest count
 * per page and rule when pinning a baseline: list-backed pages render differently
 * per load.
 *
 * The auth API allows 50 requests per 15 minutes. This script logs in once.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

// Resolve from the repository root, whatever the current directory is.
const require = createRequire(path.join(process.cwd(), 'package.json'));
const { chromium } = require('playwright-core');
const AxeBuilder = require('@axe-core/playwright').default;

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const THEMES = (process.env.THEMES || 'light').split(',');
const PAGES = (process.env.PAGES || '/apps,/apps/chat,/prompts,/chats,/admin,/admin/apps,/admin/users')
  .split(',')
  .map(p => p.trim())
  .filter(Boolean);
const outFile = process.argv[2];

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox']
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

let status = 0;
for (let i = 0; i < 30 && status !== 200; i++) {
  status = (
    await page.request.post(`${BASE}/api/auth/local/login`, {
      data: {
        username: process.env.TEST_ADMIN_USERNAME || 'admin',
        password: process.env.TEST_ADMIN_PASSWORD || 'password123'
      }
    })
  ).status();
  if (status === 429) throw new Error('Login is rate limited (50 per 15 min); restart the server.');
  if (status !== 200) await page.waitForTimeout(1000);
}
if (status !== 200) throw new Error(`Login failed (${status})`);

// A fresh contents/ starts the setup wizard; skip it so pages render normally.
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
const skip = page.getByText("Skip, I'll configure later");
if (await skip.count()) {
  await skip.click();
  await page.waitForTimeout(1200);
}

const result = {};
for (const theme of THEMES) {
  await page.addInitScript(t => {
    try {
      localStorage.setItem('ih-dark-mode', t);
    } catch {
      /* storage unavailable */
    }
  }, theme);
  for (const route of PAGES) {
    const key = `${theme} ${route}`;
    try {
      await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(500);
      const ack = page.getByRole('button', { name: 'I understand' });
      if (await ack.count()) await ack.click();
      if (theme === 'dark') {
        await page.evaluate(() => {
          document.documentElement.classList.add('dark');
          document.documentElement.setAttribute('data-theme', 'dark');
        });
      }
      const res = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
        .analyze();
      result[key] = {
        pathname: new URL(page.url()).pathname,
        violations: res.violations.map(v => ({
          id: v.id,
          impact: v.impact,
          count: v.nodes.length,
          samples: v.nodes.slice(0, 3).map(n => {
            const d = n.any?.[0]?.data || {};
            return v.id === 'color-contrast'
              ? `${d.fgColor} on ${d.bgColor} = ${d.contrastRatio}: ${n.html.slice(0, 100)}`
              : n.html.slice(0, 120);
          })
        })),
        blocking: Object.fromEntries(
          res.violations
            .filter(v => v.impact === 'critical' || v.impact === 'serious')
            .map(v => [v.id, v.nodes.length])
        )
      };
    } catch (e) {
      result[key] = { error: e.message.slice(0, 100) };
    }
  }
}
await browser.close();

if (outFile) fs.writeFileSync(outFile, JSON.stringify(result, null, 1));
for (const [key, r] of Object.entries(result)) {
  if (r.error) console.log(key.padEnd(34), 'ERROR', r.error);
  else if (r.pathname !== key.split(' ')[1])
    console.log(key.padEnd(34), `REDIRECTED to ${r.pathname}`);
  else
    console.log(
      key.padEnd(34),
      r.violations.map(v => `${v.id}[${v.impact}]x${v.count}`).join(', ') || 'ok'
    );
}
