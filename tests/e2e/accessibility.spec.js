import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Accessibility End-to-End Tests
 *
 * Scans key pages for WCAG 2.2 Level AA violations using axe-core.
 * These tests catch automatically detectable accessibility issues such as
 * missing alt text, insufficient color contrast, missing form labels,
 * incorrect ARIA attribute usage, and (new in WCAG 2.2) insufficient target
 * sizes.
 *
 * Tags used:
 *   wcag2a    — WCAG 2.0 Level A
 *   wcag2aa   — WCAG 2.0 Level AA
 *   wcag21a   — WCAG 2.1 Level A
 *   wcag21aa  — WCAG 2.1 Level AA
 *   wcag22a   — WCAG 2.2 Level A
 *   wcag22aa  — WCAG 2.2 Level AA
 *
 * Only "critical" and "serious" impact violations cause test failure.
 * "moderate" and "minor" violations are logged for awareness but do not
 * block the build.
 *
 * @see https://www.w3.org/TR/WCAG22/
 * @see https://github.com/dequelabs/axe-core
 */

/** WCAG 2.2 AA rule tags passed to every AxeBuilder scan. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

/**
 * Creates a pre-configured AxeBuilder instance targeting WCAG 2.1 AA.
 *
 * @param {import('@playwright/test').Page} page - Playwright page object
 * @returns {AxeBuilder} Configured axe builder ready to call `.analyze()`
 */
function createAxeScanner(page) {
  return new AxeBuilder({ page }).withTags(WCAG_TAGS);
}

/**
 * Filters axe violations to only those with critical or serious impact.
 *
 * @param {Array<import('axe-core').Result>} violations - Full violation list from axe scan
 * @returns {Array<import('axe-core').Result>} Violations that should cause test failure
 */
function getBlockingViolations(violations) {
  return violations.filter(v => v.impact === 'critical' || v.impact === 'serious');
}

/**
 * Builds a human-readable summary of violations for test failure messages.
 *
 * @param {Array<import('axe-core').Result>} violations - Violation list to summarize
 * @returns {string} Formatted multi-line summary
 */
function formatViolationSummary(violations) {
  return violations
    .map(v => {
      const nodes = v.nodes.map(n => `    - ${n.html}`).join('\n');
      return `  [${v.impact}] ${v.id}: ${v.help}\n    Rule: ${v.helpUrl}\n    Elements:\n${nodes}`;
    })
    .join('\n\n');
}

/**
 * Scans the current page and fails on critical/serious violations, logging
 * every violation for awareness.
 *
 * @param {import('@playwright/test').Page} page - Playwright page object
 * @param {string} label - Page name used in logs and failure messages
 * @param {Record<string, number>} [known] - axe rule → number of elements this
 *   page is known to fail it on. Up to that many are logged but not failed;
 *   one more element, or any other rule, fails the test.
 */
async function expectNoBlockingViolations(page, label, known = {}) {
  const results = await createAxeScanner(page).analyze();
  const blocking = getBlockingViolations(results.violations).filter(
    v => v.nodes.length > (known[v.id] ?? 0)
  );

  if (results.violations.length > 0) {
    console.log(
      `[a11y] ${label} — ${results.violations.length} total violation(s):\n` +
        formatViolationSummary(results.violations)
    );
  }

  for (const [id, baseline] of Object.entries(known)) {
    const now = results.violations.find(v => v.id === id)?.nodes.length ?? 0;
    if (now < baseline) {
      console.log(
        `[a11y] ${label} — ${id} now fails on ${now} element(s), ${baseline} known. ` +
          'Lower it in KNOWN_VIOLATIONS so the fixed ones cannot come back unnoticed.'
      );
    }
  }

  expect(
    blocking,
    `${label} has ${blocking.length} critical/serious a11y violation(s) beyond its known ` +
      `ones (${JSON.stringify(known)}):\n` +
      formatViolationSummary(blocking)
  ).toEqual([]);
}

test.describe('Accessibility — WCAG 2.2 AA Compliance', () => {
  // "/" is the start page (greeting, default-app input, featured apps) and
  // "/apps" the apps browser; both are user-facing entry points.
  for (const [label, path] of [
    ['Start page', '/'],
    ['Apps browser', '/apps']
  ]) {
    test.describe(label, () => {
      test('should not have critical or serious accessibility violations', async ({ page }) => {
        await page.goto(path);
        await page.waitForLoadState('networkidle');

        const results = await createAxeScanner(page).analyze();

        const blocking = getBlockingViolations(results.violations);

        // Log all violations for awareness regardless of severity
        if (results.violations.length > 0) {
          console.log(
            `[a11y] ${label} — ${results.violations.length} total violation(s):\n` +
              formatViolationSummary(results.violations)
          );
        }

        expect(
          blocking,
          `${label} has ${blocking.length} critical/serious a11y violation(s):\n` +
            formatViolationSummary(blocking)
        ).toEqual([]);
      });
    });
  }

  test.describe('Login page', () => {
    test('should not have critical or serious accessibility violations', async ({ page }) => {
      await page.goto('/login');
      await page.waitForLoadState('networkidle');

      const results = await createAxeScanner(page).analyze();

      const blocking = getBlockingViolations(results.violations);

      if (results.violations.length > 0) {
        console.log(
          `[a11y] Login page — ${results.violations.length} total violation(s):\n` +
            formatViolationSummary(results.violations)
        );
      }

      expect(
        blocking,
        `Login page has ${blocking.length} critical/serious a11y violation(s):\n` +
          formatViolationSummary(blocking)
      ).toEqual([]);
    });
  });

  test.describe('Admin page', () => {
    test('should not have critical or serious accessibility violations', async ({ page }) => {
      // The admin page may redirect to login when authentication is required.
      // Navigate and check whether we actually landed on the admin page.
      const response = await page.goto('/admin');
      await page.waitForLoadState('networkidle');

      const currentUrl = page.url();

      // Skip the scan if we were redirected away from admin (auth required).
      const isAdminPage =
        currentUrl.includes('/admin') &&
        !currentUrl.includes('/login') &&
        !currentUrl.includes('/auth');

      if (!isAdminPage) {
        test.skip(true, 'Admin page requires authentication — skipping a11y scan');
        return;
      }

      // Additional guard: if the server returned a non-success status, skip.
      if (response && response.status() >= 400) {
        test.skip(true, `Admin page returned HTTP ${response.status()} — skipping a11y scan`);
        return;
      }

      const results = await createAxeScanner(page).analyze();

      const blocking = getBlockingViolations(results.violations);

      if (results.violations.length > 0) {
        console.log(
          `[a11y] Admin page — ${results.violations.length} total violation(s):\n` +
            formatViolationSummary(results.violations)
        );
      }

      expect(
        blocking,
        `Admin page has ${blocking.length} critical/serious a11y violation(s):\n` +
          formatViolationSummary(blocking)
      ).toEqual([]);
    });
  });
});

/**
 * A fresh contents/ shows the first-run disclaimer, a modal dialog that holds
 * keyboard focus until it is acknowledged (and remembers the answer). Keyboard
 * tests have to get past it, or Tab never reaches the page behind it.
 *
 * @param {import('@playwright/test').Page} page - Playwright page object
 */
async function acknowledgeDisclaimer(page) {
  const acknowledge = page.getByRole('button', { name: 'I understand' });
  if (await acknowledge.isVisible().catch(() => false)) {
    await acknowledge.click();
    await expect(acknowledge).toBeHidden();
  }
}

/**
 * Opens a page and waits for it to settle. Admin pages call the admin API many
 * times, which has a per-minute request limit; a sweep over dozens of admin pages
 * from one address can reach it, and the page then shows "Too many ... requests"
 * instead of its content. That says nothing about the page, so wait out the
 * limit's window and load it again.
 *
 * @param {import('@playwright/test').Page} page - Playwright page object
 * @param {string} path - Route to open
 */
async function gotoSettled(page, path) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    // Let list-backed pages finish rendering before they are scanned.
    await page.waitForTimeout(500);
    const rateLimited = await page
      .getByText(/too many .{0,40}requests/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (!rateLimited) return;
    await page.waitForTimeout(20_000);
  }
}

// The auth API allows 50 requests per 15 minutes, and this file signs in for
// dozens of pages. Sign in once per worker process and reuse the session cookies.
let adminCookies;

/**
 * Signs in as the default local admin so the page's context carries the auth
 * cookie. The dev server is up before the API behind its proxy, which answers
 * 502 until then; keep trying while it starts.
 *
 * @param {import('@playwright/test').Page} page - Playwright page object
 */
async function signInAsAdmin(page) {
  if (adminCookies) {
    await page.context().addCookies(adminCookies);
    return;
  }
  const credentials = {
    username: process.env.TEST_ADMIN_USERNAME || 'admin',
    password: process.env.TEST_ADMIN_PASSWORD || 'password123'
  };
  await expect
    .poll(
      async () =>
        (await page.request.post('/api/auth/local/login', { data: credentials })).status(),
      { message: 'Admin login', timeout: 60_000, intervals: [1_000, 2_000] }
    )
    .toBe(200);
  adminCookies = await page.context().cookies();
}

// Critical/serious violations a page still has, as axe rule → number of failing
// elements (the highest count seen over repeated scans of a fresh contents/,
// which is what CI runs; list-backed pages render a little differently per
// load). They are logged on every run; one more failing element, or any other
// rule, fails the test. Pages that are not listed here have none. When a fix
// lowers a count, the log says so: lower the number, or delete the entry at zero.
//   label              - form control with no label (admin forms)
//   select-name        - <select> with no label (admin forms, canvas)
//   button-name        - icon-only button with no accessible name
//   label-title-only   - control labelled only by its title/placeholder
//   aria-valid-attr-value - tab whose aria-controls points at a panel that is not rendered
const KNOWN_VIOLATIONS = {
  '/apps/chat/canvas': { 'select-name': 1 },
  '/admin/auth': { label: 12 },
  '/admin/oauth': { 'aria-valid-attr-value': 1 },
  '/admin/oauth/clients': { 'aria-valid-attr-value': 1 },
  '/admin/oauth/connections': { 'aria-valid-attr-value': 1 },
  '/admin/oauth/server': { 'aria-valid-attr-value': 1 },
  '/admin/mcp/servers': { 'button-name': 4 },
  '/admin/browser-extension': { 'button-name': 1, label: 1 },
  '/admin/ui': { 'select-name': 5 },
  '/admin/usage': { 'select-name': 1 },
  '/admin/feedback': { 'select-name': 1 },
  '/admin/telemetry': { label: 4 },
  '/admin/backup': { label: 1 },
  '/admin/tools/ocr-ai': { label: 1 },
  '/admin/tools/jobs': { label: 1 },
  '/admin/apps/new': { 'label-title-only': 1, label: 19, 'select-name': 8 }
};

// Pages that currently have no critical or serious violation. They are held at
// zero, so a regression anywhere in this list fails the pull request. Together
// with KNOWN_VIOLATIONS this covers every route reachable from the user and admin
// navigation without opening a dialog or editing a record.
const CLEAN_PAGES = [
  '/projects',
  '/admin/projects',
  // A shipped project, so a fresh contents/ has it: the view and the edit page.
  '/admin/projects/ihub-documentation',
  '/admin/projects/ihub-documentation/edit',
  '/apps',
  '/tasks',
  '/workflows',
  '/start',
  '/admin/providers',
  '/admin/prompts',
  '/admin/tools',
  '/admin/skills',
  '/admin/workflows',
  '/admin/agents',
  '/admin/agents/approvals',
  '/admin/agents/inboxes',
  '/admin/agents/runs',
  '/admin/marketplace',
  '/admin/mcp/gateway',
  '/admin/a2a/agents',
  '/admin/credentials',
  '/admin/integrations',
  '/admin/integrations/installed',
  '/admin/integrations/jira',
  '/admin/integrations/people-directories',
  '/admin/integrations/people-directories/new',
  '/admin/office-integration',
  '/admin/nextcloud-embed',
  '/admin/localization',
  '/admin/pages',
  '/admin/shortlinks',
  '/admin/logging',
  '/admin/system-resources',
  '/admin/chat-history',
  '/admin/scheduled-tasks',
  '/admin/voice-input',
  '/admin/audit-log',
  '/admin/changelog',
  '/admin/features',
  '/admin/security',
  '/admin/updates',
  '/admin/advanced',
  '/admin/models/new'
];

// Most of the product sits behind a login: the chat UI, the prompt library and
// the admin pages. These scans sign in as the default local admin that a fresh
// contents/ ships (CLAUDE.md, "Default Local Admin"); override with
// TEST_ADMIN_USERNAME / TEST_ADMIN_PASSWORD against other environments.
test.describe('Accessibility — signed-in pages (WCAG 2.2 AA)', () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAdmin(page);
  });

  for (const [label, path] of [
    ['Chat app', '/apps/chat'],
    ['Prompt library', '/prompts'],
    ['Chat history', '/chats'],
    ['Admin overview', '/admin'],
    ['Admin apps', '/admin/apps'],
    ['Admin models', '/admin/models'],
    ['Admin users', '/admin/users'],
    ['Admin groups', '/admin/groups']
  ]) {
    test(`${label} should not have critical or serious accessibility violations`, async ({
      page
    }) => {
      test.setTimeout(150_000);
      await gotoSettled(page, path);
      expect(new URL(page.url()).pathname, `${label} redirected away from ${path}`).toBe(path);

      await expectNoBlockingViolations(page, label, KNOWN_VIOLATIONS[path]);
    });
  }

  // Every other route, so a new violation on any of them is caught, not only on
  // the handful of pages above. Pages in KNOWN_VIOLATIONS may not get worse.
  for (const path of [...CLEAN_PAGES, ...Object.keys(KNOWN_VIOLATIONS)]) {
    test(`${path} should not have new critical or serious accessibility violations`, async ({
      page
    }) => {
      // Room for waiting out the admin API's request limit (see gotoSettled).
      test.setTimeout(150_000);
      await gotoSettled(page, path);
      expect(new URL(page.url()).pathname, `${path} redirected away`).toBe(path);

      await expectNoBlockingViolations(page, path, KNOWN_VIOLATIONS[path]);
    });
  }
});

// A user project page: personal projects ship switched off and a fresh
// contents/ has no user project, so the test switches the feature on, creates
// one, scans its page, and puts both back.
test.describe('Accessibility — a user project page', () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAdmin(page);
  });

  test('/projects/:id should not have critical or serious accessibility violations', async ({
    page
  }) => {
    test.setTimeout(150_000);
    const features = await page.request.get('/api/admin/features');
    const wasOn = (await features.json()).features?.find(f => f.id === 'userProjects')?.enabled;
    await page.request.put('/api/admin/features', { data: { userProjects: true } });
    let projectId = null;
    try {
      const created = await page.request.post('/api/projects', {
        data: { name: 'Accessibility check', instructions: 'Answer briefly.' }
      });
      expect(created.status(), await created.text()).toBe(201);
      projectId = (await created.json()).id;
      const path = `/projects/${projectId}`;
      await gotoSettled(page, path);
      expect(new URL(page.url()).pathname).toBe(path);
      await expectNoBlockingViolations(page, 'User project page');
    } finally {
      if (projectId) await page.request.delete(`/api/projects/${projectId}`);
      if (wasOn !== true) {
        await page.request.put('/api/admin/features', { data: { userProjects: false } });
      }
    }
  });
});

// axe's WCAG tag set does not include the landmark rules (they are best
// practices), so they are run explicitly: a screen-reader user navigates by
// landmark, and a second <main> (or an unlabelled duplicate) makes that list
// ambiguous.
test.describe('Accessibility — landmarks', () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAdmin(page);
  });

  for (const path of [
    '/apps',
    '/prompts',
    '/admin',
    '/admin/apps',
    '/admin/marketplace',
    '/admin/security'
  ]) {
    test(`${path} has exactly one main landmark and no ambiguous duplicates`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expect(new URL(page.url()).pathname).toBe(path);

      await expect(page.locator('main, [role="main"]')).toHaveCount(1);

      const results = await new AxeBuilder({ page })
        .withRules([
          'landmark-one-main',
          'landmark-no-duplicate-main',
          'landmark-main-is-top-level',
          'landmark-unique'
        ])
        .analyze();
      expect(
        results.violations,
        `${path} landmark problems:\n${formatViolationSummary(results.violations)}`
      ).toEqual([]);
    });
  }
});

// The skip links are the keyboard user's way past the navigation. index.html
// injects a <base> element, which once turned a bare href="#main-content" into
// a navigation to the app root: the link took the user off the page instead of
// into its content. These tests press the real keys against the real DOM.
test.describe('Accessibility — skip links', () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAdmin(page);
  });

  for (const [label, path, linkName, targetId] of [
    ['App pages', '/prompts', /skip to main content/i, 'main-content'],
    ['Admin pages', '/admin/apps', /skip to content/i, 'admin-main-content']
  ]) {
    test(`${label}: the skip link is the first Tab stop and moves focus into the content`, async ({
      page
    }) => {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await acknowledgeDisclaimer(page);
      // Start from the top of the document, as a keyboard user does after loading the page.
      await page.goto(path);
      await page.waitForLoadState('networkidle');

      await page.keyboard.press('Tab');
      const skipLink = page.getByRole('link', { name: linkName });
      await expect(skipLink).toBeFocused();
      await expect(skipLink).toBeVisible();

      await page.keyboard.press('Enter');

      expect(new URL(page.url()).pathname, 'the skip link must not navigate away').toBe(path);
      await expect(page.locator(`#${targetId}`)).toBeFocused();
    });
  }
});
