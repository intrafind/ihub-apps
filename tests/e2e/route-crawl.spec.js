// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';

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
    const login = await context.request.post('/api/auth/local/login', { data: ADMIN });
    expect(login.ok()).toBeTruthy();

    const problems = [];
    // Pages whose own request answered 404, and where the link to each was found: another
    // spec running next to this one may delete a project or prompt between the link and the visit.
    const notFound = new Set();
    const foundOn = new Map();

    /** Load one page in a fresh tab (a long-lived tab runs out of resources) and return its links. */
    async function visit(key) {
      const page = await context.newPage();
      let expectedFailures = 0;
      page.on('response', response => {
        const url = new URL(response.url());
        // `includes`, not `startsWith`: a page the client takes for a base path calls `/<segment>/api/...`.
        if (!url.pathname.includes('/api/')) return;
        const status = response.status();
        const method = response.request().method();
        if (status >= 400 && isExpected(method, url.pathname, status)) expectedFailures++;
        else if (status >= 400) {
          problems.push(`${key}: ${method} ${url.pathname} -> ${status}`);
          if (status === 404 && method === 'GET') notFound.add(key);
        }
      });
      page.on('pageerror', error => problems.push(`${key}: exception: ${error.message}`));
      page.on('console', message => {
        if (message.type() !== 'error') return;
        const text = message.text();
        if (IGNORED_CONSOLE.some(re => re.test(text))) return;
        // The client logs a failed request it handles itself; the response above decides.
        if (expectedFailures && /^(API Error|Error loading|Failed to)/.test(text)) return;
        problems.push(`${key}: console.error: ${text.slice(0, 200)}`);
      });
      try {
        await page.goto(key, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle').catch(() => {});
        return await internalLinks(page);
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
      for (const href of await visit(key)) {
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
