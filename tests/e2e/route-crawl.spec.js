// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';
import { createConsoleFilter } from './helpers/consoleFilter.js';

/**
 * End-to-end: crawl the app as the default admin and fail on anything that
 * breaks while pages load.
 *
 * Starts at the home page and the admin overview, follows every in-app link it
 * finds (breadth first, navigation only — nothing is clicked that is not a link),
 * and records, for each page:
 *   - an API response with a status of 400 or more that the page did not expect,
 *   - an uncaught exception on the page,
 *   - a `console.error`.
 *
 * This is the check for the class of bug a server refactor leaves in a client:
 * a renamed route, a changed response shape, a key that is no longer sent. Each
 * of them makes a page request something the server no longer answers, or throw
 * while it renders the answer — and nobody notices until that page is opened.
 *
 * Signs in with `admin` / `password123`, which a fresh `contents/` ships with.
 * `tests/config/e2e-server.mjs` runs the app on its own contents directory.
 */

const ADMIN = { username: 'admin', password: 'password123' };

// The path prefix the app is served under (`/ihub` for the subpath suite, see
// tests/config/subpath-server.mjs); empty at the root. Pages are crawled by their
// path without it, so a page is `/admin` on both deployments.
const BASE = (process.env.CRAWL_BASE_PATH || '').replace(/\/$/, '');

/**
 * Root-relative links in page content that leave a deployment prefix: the Markdown
 * link renderer emits `/pages/x` unchanged, so under `/ihub` it opens `/pages/x` (404
 * at the proxy). Known, tracked in #3485; they are logged, any other one fails.
 */
const KNOWN_LINKS_OUTSIDE_BASE = ['/pages/privacy', '/pages/nda-guide'];

// Enough to reach every admin page and a sample of detail pages, few enough to
// finish in a couple of minutes.
const MAX_PAGES = 120;

// The documentation viewer links to dozens of pages that share one renderer;
// a few cover it without using up the budget for the admin pages.
const MAX_DOC_PAGES = 6;

/**
 * Responses that are part of normal operation and not a defect.
 * Each entry: [method pattern, URL pattern, status list, why].
 */
const EXPECTED_FAILURES = [
  [/^GET$/, /\/api\/auth\/status/, [401], 'status probe before sign-in'],
  [
    /^GET$/,
    /\/api\/admin\/integrations\/installed\//,
    [400, 404],
    'the app editor probes the installations an app names; one that is not installed is shown as such'
  ],
  [
    /^GET$/,
    /\/api\/apps\/(?:iassistant|ifinder-search|people-directory|skill-builder)$/,
    [404],
    'apps that belong to an integration are hidden until it is installed'
  ],
  [
    /^GET$/,
    /\/api\/admin\/oauth\/(?:connections|clients)$/,
    [400],
    'OAuth clients are not enabled on a fresh install'
  ],
  [
    /./,
    /\/api\/user-skills\/marketplace/,
    [502, 503, 504],
    'the remote registry is switched off in e2e'
  ],
  [
    /./,
    /\/api\/admin\/marketplace\/registries\/[^/]+\/(?:status|refresh)/,
    [502, 503, 504],
    'no registry reachable in e2e'
  ]
];

/** Console errors that are not defects (resource noise from the browser itself). */
const IGNORED_CONSOLE = [
  /Failed to load resource/, // the failed response is reported with its URL instead
  /favicon/,
  /Download the React DevTools/
];

const isExpected = (method, url, status) =>
  EXPECTED_FAILURES.some(
    ([m, u, statuses]) => m.test(method) && u.test(url) && statuses.includes(status)
  );

function internalLinks(page) {
  return page.$$eval('a[href]', anchors =>
    anchors
      .map(a => a.getAttribute('href'))
      .filter(href => href && href.startsWith('/') && !href.startsWith('//'))
  );
}

/** Links that are not pages of the app (API, downloads, uploads, docs, sign-out). */
const SKIP_LINK =
  /^\/(api|uploads|assets|docs|s|share|teams|oauth|logout)(\/|$)|\.(zip|crx|xml|json|pdf|png|svg|csv)(\?|$)/;

test.describe('Route crawl', () => {
  test.setTimeout(10 * 60 * 1000);

  test('no page fails an API call, throws or logs an error', async ({ context }) => {
    // The first-visit disclaimer would sit over every page.
    await context.addInitScript(() => {
      window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
    });
    const login = await context.request.post(`${BASE}/api/auth/local/login`, { data: ADMIN });
    expect(login.ok()).toBeTruthy();

    const problems = [];
    // Pages whose own request answered 404, and where the link to each was found: another
    // spec running next to this one may delete a project or prompt between the link and the visit.
    const notFound = new Set();
    const foundOn = new Map();

    /** Load one page in a fresh tab (a long-lived tab runs out of resources) and return its links. */
    async function visit(key) {
      const page = await context.newPage();
      const consoleFilter = createConsoleFilter(IGNORED_CONSOLE);
      page.on('response', response => {
        const url = new URL(response.url());
        // `includes`, not `startsWith`: a page the client takes for a base path calls `/<segment>/api/...`.
        if (!url.pathname.includes('/api/')) return;
        const status = response.status();
        const method = response.request().method();
        if (status >= 400 && isExpected(method, url.pathname, status)) {
          consoleFilter.expectFailure(url.pathname);
        } else if (status >= 400) {
          problems.push(`${key}: ${method} ${url.pathname} -> ${status}`);
          if (status === 404 && method === 'GET') notFound.add(key);
        }
      });
      page.on('pageerror', error => problems.push(`${key}: exception: ${error.message}`));
      page.on('console', message => {
        if (message.type() !== 'error') return;
        const text = message.text();
        if (consoleFilter.excuses(text)) return;
        problems.push(`${key}: console.error: ${text.slice(0, 200)}`);
      });
      try {
        await page.goto(`${BASE}${key}`, { waitUntil: 'domcontentloaded' });
        if (BASE && !new URL(page.url()).pathname.startsWith(BASE)) {
          problems.push(`${key}: ended up at ${new URL(page.url()).pathname}, outside ${BASE}`);
        }
        await page.waitForLoadState('networkidle').catch(() => {});
        const hrefs = await internalLinks(page);
        if (!BASE) return hrefs;
        // Under a prefix every root-relative link must carry it, or it leaves the app.
        const inApp = [];
        for (const href of hrefs) {
          if (href === BASE || href.startsWith(`${BASE}/`))
            inApp.push(href.slice(BASE.length) || '/');
          else if (KNOWN_LINKS_OUTSIDE_BASE.includes(href)) {
            console.log(`known (#3485): ${key} links ${href} without ${BASE}`);
          } else problems.push(`${key}: link ${href} ignores the base path ${BASE}`);
        }
        return inApp;
      } finally {
        await page.close();
      }
    }

    const queue = ['/', '/admin'];
    const seen = new Set();
    let docPages = 0;
    while (queue.length && seen.size < MAX_PAGES) {
      const key = queue.shift().split('#')[0];
      if (seen.has(key)) continue;
      if (key.startsWith('/admin/docs/') && ++docPages > MAX_DOC_PAGES) continue;
      seen.add(key);
      const links = await visit(key);
      // The audit log lists what happened to things that may be gone since (another spec
      // deletes the projects and prompts it creates); a link there can rightly 404.
      if (key.startsWith('/admin/audit-log')) continue;
      for (const href of links) {
        const clean = href.split('#')[0].split('?')[0];
        if (clean && !SKIP_LINK.test(clean) && !seen.has(clean)) {
          queue.push(clean);
          if (!foundOn.has(clean)) foundOn.set(clean, key);
        }
      }
    }

    console.log(`crawled ${seen.size} pages`);
    expect(seen.size, 'the crawl found almost nothing to visit').toBeGreaterThan(20);

    // A page that 404ed because the thing it shows was deleted meanwhile is not a defect:
    // look at the page that linked to it again — if the link is gone, drop the failure.
    const vanished = new Set();
    for (const key of notFound) {
      const source = foundOn.get(key);
      const links = source ? await visit(source) : [key];
      if (!links.some(href => href.split('#')[0].split('?')[0] === key)) vanished.add(key);
    }
    if (vanished.size) console.log(`ignored, deleted while crawling: ${[...vanished].join(', ')}`);
    const failures = [...new Set(problems)].filter(line => !vanished.has(line.split(': ')[0]));
    expect(failures, 'failures while loading pages').toEqual([]);
  });
});
