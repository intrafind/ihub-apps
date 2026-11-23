import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { SHARE_ID, mockSharedChatWithArtifacts } from './helpers/sharedChatWithArtifacts.js';

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
 * @param {Object} [options]
 * @param {string[]} [options.exclude] - Selectors of parts axe does not look at.
 *   For a part that an open layer covers; the caller says why at the call.
 */
async function expectNoBlockingViolations(page, label, known = {}, { exclude = [] } = {}) {
  const scanner = exclude.reduce(
    (builder, selector) => builder.exclude(selector),
    createAxeScanner(page)
  );
  const results = await scanner.analyze();
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
// The first sign-in that the API itself refused (anything but a proxy 502/503/504
// while the server starts). Kept so the later tests fail with that answer at
// once instead of retrying the login until the auth API's limit answers 429
// for every test for the next 15 minutes.
let adminLoginFailure;

/**
 * Signs in as the default local admin so the page's context carries the auth
 * cookie. The dev server is up before the API behind its proxy, which answers
 * 502 until then; keep trying while it starts. Any other refusal is final and
 * reported with the API's answer.
 *
 * @param {import('@playwright/test').Page} page - Playwright page object
 */
async function signInAsAdmin(page) {
  if (adminCookies) {
    await page.context().addCookies(adminCookies);
    return;
  }
  if (adminLoginFailure) throw new Error(adminLoginFailure);
  const credentials = {
    username: process.env.TEST_ADMIN_USERNAME || 'admin',
    password: process.env.TEST_ADMIN_PASSWORD || 'password123'
  };
  const deadline = Date.now() + 60_000;
  let last = null;
  while (Date.now() < deadline) {
    const response = await page.request.post('/api/auth/local/login', { data: credentials });
    const status = response.status();
    if (status === 200) {
      adminCookies = await page.context().cookies();
      return;
    }
    const body = (await response.text().catch(() => '')).slice(0, 500);
    last = `Admin login answered HTTP ${status}${body ? `: ${body}` : ''}`;
    // The API behind the dev proxy is not up yet.
    if (status !== 502 && status !== 503 && status !== 504) {
      adminLoginFailure = last;
      throw new Error(last);
    }
    await page.waitForTimeout(1_500);
  }
  adminLoginFailure = `Admin login did not succeed within 60 s (last answer: ${last || 'none'})`;
  throw new Error(adminLoginFailure);
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
  '/admin/browser-extension': { 'button-name': 1, label: 1 },
  '/admin/feedback': { 'select-name': 1 },
  '/admin/telemetry': { label: 4 },
  '/admin/backup': { label: 1 },
  '/admin/tools/ocr-ai': { label: 1 },
  '/admin/tools/jobs': { label: 1 }
};

// The app editor with every group of its form expanded (see the test
// "Accessibility — the app editor" below). A plain load of the editor shows two
// of its eight groups, and axe does not look into a collapsed one, so the
// editor is not in the lists above: its counts are measured with everything
// open. They may only shrink.
const KNOWN_APP_EDITOR_VIOLATIONS = { label: 7, 'select-name': 4 };

// Pages that currently have no critical or serious violation. They are held at
// zero, so a regression anywhere in this list fails the pull request. Together
// with KNOWN_VIOLATIONS this covers every route reachable from the user and admin
// navigation without opening a dialog or editing a record.
const CLEAN_PAGES = [
  '/projects',
  '/admin/projects',
  // UI Customization opens on the Branding tab; the Disclaimer page has its own route.
  '/admin/ui',
  '/admin/disclaimer',
  // A shipped project, so a fresh contents/ has it.
  '/admin/projects/ihub-documentation',
  '/apps',
  '/tasks',
  '/workflows',
  '/start',
  // Settings → Integrations: the user's integrations with their identity state.
  '/settings/integrations',
  '/admin/providers',
  '/admin/prompts',
  '/admin/skills',
  '/admin/workflows',
  '/admin/agents',
  '/admin/agents/approvals',
  '/admin/agents/inboxes',
  '/admin/agents/runs',
  '/admin/marketplace',
  '/admin/mcp/gateway',
  '/admin/credentials',
  '/admin/integrations',
  // The integration builder (Add manually), which replaced the Tools page.
  '/admin/integrations/builder/new',
  // A built-in installation a fresh contents/ ships: its own page.
  '/admin/integrations/websearch',
  '/admin/integrations/jira',
  '/admin/office-integration',
  '/admin/nextcloud-embed',
  '/admin/localization',
  '/admin/pages',
  '/admin/shortlinks',
  '/admin/logging',
  '/admin/system-resources',
  '/admin/usage',
  '/admin/chat-history',
  '/admin/scheduled-tasks',
  '/admin/voice-input',
  '/admin/audit-log',
  '/admin/changelog',
  '/admin/features',
  '/admin/security',
  '/admin/artifacts',
  '/admin/eu-ai-act',
  '/admin/updates',
  '/admin/advanced',
  '/admin/models/new',
  // "New app" opens on its Start screen; its other states are scanned below.
  '/admin/apps/new'
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

// The action detail of an installed integration (#2974): the drawer over the
// installation page, opened by its `?action=` link on a built-in installation
// a fresh contents/ ships, with every section (schema table, overrides, the
// generated test form) rendered.
test.describe('Accessibility — the integration action detail', () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAdmin(page);
  });

  test('has no critical or serious violations when open', async ({ page }) => {
    test.setTimeout(150_000);
    await gotoSettled(page, '/admin/integrations/ihub?action=list_scheduled_tasks');
    const drawer = page.getByTestId('integration-action-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId('action-test-panel')).toBeVisible();
    await expectNoBlockingViolations(page, 'Integration action detail');
  });
});

// "New app" (concepts/app-builder-rework-2026-11): one page with two screens,
// Start and Essentials, and several states a plain load does not show. Each is
// opened the way an author opens it and held at zero.
test.describe('Accessibility — the New app page', () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAdmin(page);
    // The first-run disclaimer would cover the page and take every click.
    await page.addInitScript(() => {
      window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
    });
  });

  /** The Start screen, loaded and settled. */
  async function openStart(page) {
    await gotoSettled(page, '/admin/apps/new');
    await expect(page.getByRole('heading', { level: 1, name: 'New app' })).toBeVisible();
  }

  /** The Essentials screen of an empty start. */
  async function openEssentials(page) {
    await openStart(page);
    await page.getByRole('button', { name: 'Start empty' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Describe your app' })).toBeVisible();
  }

  test('Start: the other ways to start and the app picker', async ({ page }) => {
    test.setTimeout(150_000);
    await openStart(page);
    await page.getByRole('button', { name: 'Other ways to start' }).click();
    await expect(page.getByRole('button', { name: 'Create a link app' })).toBeVisible();
    await expectNoBlockingViolations(page, 'New app — other ways to start');

    await page.getByRole('button', { name: 'Copy an existing app' }).click();
    const picker = page.getByRole('dialog');
    await expect(
      picker.getByRole('heading', { name: 'Which app do you want to copy?' })
    ).toBeVisible();
    await expect(picker.getByRole('button').nth(1)).toBeVisible();
    await expectNoBlockingViolations(page, 'New app — app picker');
  });

  test('Essentials: empty, with details and tips open, the icon list, after a failed submit', async ({
    page
  }) => {
    test.setTimeout(150_000);
    await openEssentials(page);
    await expectNoBlockingViolations(page, 'New app — Essentials');

    await page.getByRole('button', { name: 'More details' }).click();
    await expect(page.getByRole('textbox', { name: 'App ID' })).toBeVisible();
    await page.getByRole('button', { name: 'Tips for good instructions' }).click();
    await expectNoBlockingViolations(page, 'New app — Essentials, details and tips open');

    // The icon list opens over the page and covers two colour swatches except
    // for a strip at their upper edge. While the list is open, a layer above
    // the page takes every click beside it, so that strip is no target: a
    // click on it closes the list and changes no colour. axe compares a
    // control only with neighbours of the same positioning and does not see
    // that layer (it is fixed), so it would report the strip as too small a
    // target. The colour group is therefore left out of this one scan; every
    // other scan of the screen includes it.
    const iconButton = page.getByRole('button', { name: /^Icon/ });
    const iconSearch = page.getByPlaceholder('Search icons…');
    const colours = page.getByRole('group', { name: 'Color' });
    await iconButton.click();
    await expect(iconSearch).toBeVisible();
    const orange = await colours.getByRole('button', { name: 'Orange' }).boundingBox();
    await page.mouse.click(orange.x + orange.width / 2, orange.y + 1);
    await expect(iconSearch).toBeHidden();
    await expect(colours.getByRole('button', { name: 'Indigo' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await iconButton.click();
    await expect(iconSearch).toBeVisible();
    await expectNoBlockingViolations(
      page,
      'New app — icon list',
      {},
      {
        exclude: ['[role="group"]:has(button[aria-label="Orange"])']
      }
    );
    await page.keyboard.press('Escape');
    await expect(iconSearch).toBeHidden();

    // Nothing typed: every required field is marked and named in the summary.
    await page.getByRole('button', { name: 'Create and test' }).click();
    await expect(page.getByText('3 fields need your attention.')).toBeVisible();
    await expectNoBlockingViolations(page, 'New app — Essentials with errors');
  });

  test('Essentials: a template, a link app, and the question before input is lost', async ({
    page
  }) => {
    test.setTimeout(150_000);
    await openStart(page);
    await page.getByRole('button', { name: /^Translator/ }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Adjust the template' })
    ).toBeVisible();
    await expectNoBlockingViolations(page, 'New app — Essentials from a template');

    await page.getByRole('textbox', { name: 'Name' }).fill('Accessibility check');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Discard this app?');
    await expectNoBlockingViolations(page, 'New app — discard dialog');
    await dialog.getByRole('button', { name: 'Discard', exact: true }).click();

    await page.getByRole('button', { name: 'Other ways to start' }).click();
    await page.getByRole('button', { name: 'Create a link app' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Set up your link app' })
    ).toBeVisible();
    await expectNoBlockingViolations(page, 'New app — Essentials for a link app');
  });

  test('a draft from a description: the failure message and the draft notice', async ({ page }) => {
    test.setTimeout(150_000);
    await openStart(page);
    const description = page.getByRole('textbox', { name: 'Your description' });
    // The box is there when a model is. In CI the suite's own server has the stub
    // model (tests/config/e2e-llm-stub.mjs), so a missing box is a failure there
    // and not a skip, which the workflow would report as green. A reused dev
    // server may have no model.
    if (process.env.CI) {
      await expect(description).toBeVisible();
    } else {
      test.skip(
        !(await description.isVisible()),
        'No AI model on this server, so the page offers no draft'
      );
    }
    const prepare = page.getByRole('button', { name: 'Prepare draft' });

    // The stub answers a plain description with a sentence, which is no draft.
    await description.fill('An app that summarizes a text.');
    await prepare.click();
    await expect(page.getByText("The AI's draft could not be used. Try again.")).toBeVisible();
    await expectNoBlockingViolations(page, 'New app — draft failed');

    // The marker makes the stub answer with the draft of an app.
    await description.fill('Rewrite a text in a chosen tone. e2e-app-json');
    await prepare.click();
    await expect(page.getByRole('heading', { level: 1, name: 'Check your draft' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /^Web search/ })).toBeVisible();
    await expectNoBlockingViolations(page, 'New app — draft notice');
  });
});

// The app editor (concepts/app-builder-rework-2026-11, section 3.5): its form
// has eight groups, of which two are open on a plain load. axe does not look
// into a collapsed group, so a scan of the plain page would miss most of the
// form. "Expand all" opens every group; that state is what is measured.
test.describe('Accessibility — the app editor', () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAdmin(page);
    await page.addInitScript(() => {
      window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
    });
  });

  test('has no new critical or serious violations with every group expanded', async ({ page }) => {
    test.setTimeout(150_000);
    await gotoSettled(page, '/admin/apps/chat');
    const headers = page.locator('[id^="app-group-"][id$="-header"]');
    await expect(headers).toHaveCount(8);
    await page.getByRole('button', { name: 'Expand all' }).click();
    await expect(
      page.locator('[id^="app-group-"][id$="-header"][aria-expanded="true"]')
    ).toHaveCount(8);
    // The access group loads its groups after it opens.
    await expect(page.getByTestId('content-access-section')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectNoBlockingViolations(
      page,
      'App editor — every group expanded',
      KNOWN_APP_EDITOR_VIOLATIONS
    );
  });

  // "Create a link app" ends in an editor with two groups, whose configuration
  // card (the website address and how it opens) no chat app shows. Held at zero.
  for (const [kind, appId] of [
    ['a link app', 'external-website-intrafind'],
    ['an embedded website', 'embedded-website-wikipedia']
  ]) {
    test(`has no critical or serious violations in the editor of ${kind}`, async ({ page }) => {
      test.setTimeout(150_000);
      await gotoSettled(page, `/admin/apps/${appId}`);
      const headers = page.locator('[id^="app-group-"][id$="-header"]');
      await expect(headers).toHaveCount(2);
      await page.getByRole('button', { name: 'Expand all' }).click();
      await expect(
        page.locator('[id^="app-group-"][id$="-header"][aria-expanded="true"]')
      ).toHaveCount(2);
      await expect(page.getByTestId('content-access-section')).toBeVisible();
      await page.waitForLoadState('networkidle');
      // Every control of the card has a name of its own, not its placeholder.
      await expect(page.getByRole('textbox', { name: /^(Redirect URL|Iframe URL)/ })).toBeVisible();
      await expectNoBlockingViolations(page, `App editor — ${kind}, every group expanded`);
    });
  }

  // WCAG 2.2, 2.4.11 Focus Not Obscured: the save bar sticks to the bottom of
  // the form's scroll area, which is where a browser scrolls a newly focused
  // control to. The bar reserves its height there, so no control reached with
  // Tab lies entirely under it; on a phone the bar wraps to several rows.
  for (const viewport of [
    { width: 1440, height: 800 },
    { width: 360, height: 640 }
  ]) {
    test(`the save bar covers no focused field at ${viewport.width}px`, async ({ page }) => {
      test.setTimeout(150_000);
      await page.setViewportSize(viewport);
      await gotoSettled(page, '/admin/apps/chat');
      await page.getByRole('button', { name: 'Expand all' }).click();
      await expect(page.getByTestId('content-access-section')).toBeVisible();
      await page.waitForLoadState('networkidle');

      const name = page.locator('[data-field="name"] input').first();
      await name.fill('A name that was changed');
      const bar = page.getByRole('region', { name: 'Save changes' });
      await expect(bar).toBeVisible();

      const covered = [];
      let reached = 0;
      for (let step = 0; step < 160; step += 1) {
        await page.keyboard.press('Tab');
        const state = await page.evaluate(() => {
          const active = document.activeElement;
          const region = document.querySelector('[role="region"][aria-label="Save changes"]');
          if (!active || active === document.body || !region) return null;
          if (region.contains(active)) return { inBar: true };
          const rect = active.getBoundingClientRect();
          const barTop = region.getBoundingClientRect().top;
          return {
            inBar: false,
            hidden: rect.height > 0 && rect.top >= barTop - 1,
            what: `${active.tagName.toLowerCase()}#${active.id || active.name || '?'}`
          };
        });
        if (!state) continue;
        // The bar's own buttons come after the form: every field was passed.
        if (state.inBar) break;
        reached += 1;
        if (state.hidden) covered.push(state.what);
      }
      expect(reached).toBeGreaterThan(40);
      expect(covered, 'controls that got the focus entirely under the save bar').toEqual([]);
    });
  }

  test('has no critical or serious violations with the test panel open', async ({ page }) => {
    test.setTimeout(150_000);
    await gotoSettled(page, '/admin/apps/chat');
    await page.getByRole('button', { name: 'Test', exact: true }).click();
    await expect(page.getByRole('complementary', { name: 'Test app' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectNoBlockingViolations(page, 'App editor — test panel open');
  });
});

// The conversation of the app editor (#3898, concepts/app-builder-rework-2026-11/
// 04-chat-builder-implementation-plan.md, 3.2): `?view=conversation` shows it in
// place of the form, with the test chat beside it. The preview feature
// `appBuilderChat` ships switched off, so the test switches it on, creates the
// app it changes, and puts both back. The model stub answers the
// `e2e-revise-*` markers (tests/config/e2e-llm-stub.mjs). Each state is held
// at zero: the first message with its chips, a question, a change card, and
// the "Applied" line with Undo.
test.describe('Accessibility — the app conversation', () => {
  const APP_ID = 'a11y-conversation-check';
  let featureWasOn;

  test.beforeEach(async ({ page }) => {
    await signInAsAdmin(page);
    await page.addInitScript(() => {
      window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
    });
    const features = await page.request.get('/api/admin/features');
    featureWasOn = (await features.json()).features?.find(f => f.id === 'appBuilderChat')?.enabled;
    await page.request.put('/api/admin/features', { data: { appBuilderChat: true } });
    await page.request.delete(`/api/admin/apps/${APP_ID}`);
    const created = await page.request.post('/api/admin/apps?origin=blank', {
      data: {
        id: APP_ID,
        name: { en: 'Accessibility conversation check' },
        description: { en: 'Changed in the conversation of the editor.' },
        system: { en: 'You answer in one sentence.' },
        color: '#4F46E5',
        icon: 'chat-bubbles',
        enabled: false
      }
    });
    expect(created.status(), await created.text()).toBe(201);
  });

  test.afterEach(async ({ page }) => {
    await page.request.delete(`/api/admin/apps/${APP_ID}`);
    if (featureWasOn !== true) {
      await page.request.put('/api/admin/features', { data: { appBuilderChat: false } });
    }
  });

  test('has no critical or serious violations: start, a question, a change, applied', async ({
    page
  }) => {
    test.setTimeout(150_000);
    await gotoSettled(page, `/admin/apps/${APP_ID}?view=conversation`);
    const panel = page.getByTestId('conversation-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Test app' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectNoBlockingViolations(page, 'App conversation — start');

    const composer = panel.getByRole('textbox', { name: 'Tell the builder what to change' });
    const ask = async text => {
      await composer.fill(text);
      await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/api/admin/apps/_revise')),
        composer.press('Enter')
      ]);
    };

    await ask('Make it more formal. e2e-revise-question');
    const question = panel.getByRole('radiogroup', { name: 'Who reads the answers of this app?' });
    await expect(question).toBeVisible();
    await question.getByRole('radio', { name: 'Something else' }).check();
    await expect(panel.getByRole('textbox', { name: 'Your answer' })).toBeVisible();
    await expectNoBlockingViolations(page, 'App conversation — a question');

    await ask('e2e-revise-system');
    const card = panel.getByTestId('change-card');
    await expect(card.getByRole('button', { name: 'Apply' })).toBeEnabled();
    await expectNoBlockingViolations(page, 'App conversation — a change card');

    await card.getByRole('button', { name: 'Apply' }).click();
    await expect(card.getByTestId('change-applied')).toBeFocused();
    await expect(card.getByRole('button', { name: 'Undo' })).toBeEnabled();
    await expectNoBlockingViolations(page, 'App conversation — applied, with Undo');
  });
});

// Personal apps (concepts/app-builder-rework-2026-11/02-personal-apps.md, 11.10):
// the apps page with its scope chips, "New app" and the editor for a user, the
// chat notice of an app someone else owns, and the admin tab. The feature
// ships switched off and a fresh contents/ has no personal app, so the tests
// switch it on, create what they scan, and put both back. Every screen is held
// at zero.
test.describe('Accessibility — personal apps', () => {
  // Each test switches the feature on and off again: one after the other, in
  // one worker, so that no test switches it off under another one.
  test.describe.configure({ mode: 'serial' });

  const NAME = 'Accessibility check app';
  let featureWasOn;
  let ownAppId;
  let foreignAppId;
  let foreign;

  test.beforeEach(async ({ page, playwright, baseURL }) => {
    test.setTimeout(150_000);
    await signInAsAdmin(page);
    await page.addInitScript(() => {
      window.localStorage.setItem('ihub-disclaimer-acknowledged', 'true');
    });
    const features = await page.request.get('/api/admin/features');
    featureWasOn = (await features.json()).features?.find(f => f.id === 'userApps')?.enabled;
    await page.request.put('/api/admin/features', { data: { userApps: true } });

    const content = name => ({
      language: 'en',
      origin: 'blank',
      name: { en: name },
      description: { en: 'Rewrites a text in a friendlier tone.' },
      system: { en: 'You rewrite the text the user sends. Keep every fact.' },
      variables: [{ name: 'tone', label: { en: 'Tone' }, type: 'string', required: false }],
      starterPrompts: [{ title: { en: 'Rewrite an email' }, message: { en: 'Rewrite this.' } }]
    });
    // One app of the signed-in administrator, to edit and share.
    const own = await page.request.post('/api/apps', { data: content(NAME) });
    expect(own.status(), await own.text()).toBe(201);
    ownAppId = (await own.json()).id;
    // One app of the default user, shared with nobody: the administrator reads
    // it as someone who does not own it, with the notice.
    foreign = await playwright.request.newContext({ baseURL });
    const login = await foreign.post('/api/auth/local/login', {
      data: { username: 'user', password: 'password123' }
    });
    expect(login.status(), await login.text()).toBe(200);
    const other = await foreign.post('/api/apps', { data: content(`${NAME} of a colleague`) });
    expect(other.status(), await other.text()).toBe(201);
    foreignAppId = (await other.json()).id;
  });

  test.afterEach(async ({ page }) => {
    for (const id of [ownAppId, foreignAppId]) {
      if (id) await page.request.delete(`/api/admin/user-apps/${id}`);
    }
    ownAppId = foreignAppId = null;
    await foreign?.dispose();
    if (featureWasOn !== true) {
      await page.request.put('/api/admin/features', { data: { userApps: false } });
    }
  });

  test('the apps page: the scope chips, "My apps" with a tile and its menu', async ({ page }) => {
    await gotoSettled(page, '/apps');
    const chips = page.getByRole('radiogroup', { name: 'Which apps to show' });
    await expect(chips.getByRole('radio')).toHaveCount(3);
    await expectNoBlockingViolations(page, 'Apps page — with personal apps');

    await page.getByTestId('apps-scope-mine').click();
    await expect(page.getByTestId('apps-scope-mine')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('user-app-badge').first()).toBeVisible();
    // The chip changes colour with a transition; scan the colours it ends on.
    await page.waitForTimeout(500);
    await expectNoBlockingViolations(page, 'Apps page — My apps');

    await page.getByRole('button', { name: `Actions for "${NAME}"` }).click();
    await expect(page.getByRole('menuitem', { name: 'Share' })).toBeVisible();
    await expectNoBlockingViolations(page, 'Apps page — the menu of a tile');
    await page.keyboard.press('Escape');

    // Nothing shared with the administrator: the empty state of that chip.
    await page.getByTestId('apps-scope-shared').click();
    await expect(page.getByTestId('user-apps-empty')).toBeVisible();
    await page.waitForTimeout(500);
    await expectNoBlockingViolations(page, 'Apps page — Shared with me, empty');
  });

  test('"New app" for a user: Start and Essentials', async ({ page }) => {
    await gotoSettled(page, '/apps/new');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('textbox', { name: 'Your description' })).toBeVisible();
    await expectNoBlockingViolations(page, 'New personal app — Start');

    await page.getByRole('button', { name: 'Start empty' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Describe your app' })).toBeVisible();
    await expect(page.getByText('Only you can see the app until you share it.')).toBeVisible();
    await expectNoBlockingViolations(page, 'New personal app — Essentials');

    // After a submit with empty fields: the messages next to the fields.
    await page.getByRole('button', { name: 'Create and test' }).click();
    await expectNoBlockingViolations(page, 'New personal app — Essentials after a failed submit');
  });

  test('the editor: every group open, the menu, and the hand-over and share dialogs', async ({
    page
  }) => {
    await gotoSettled(page, `/apps/${ownAppId}/edit`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByTestId('user-app-state')).toHaveText('Only you');
    // Open every group of the form: axe does not look into a collapsed one.
    for (let closed = 0; closed < 12; closed++) {
      const header = page.locator('main button[aria-expanded="false"][aria-controls]').first();
      if (!(await header.count())) break;
      await header.click();
    }
    await expect(page.getByTestId('user-app-extras')).toBeVisible();
    await expectNoBlockingViolations(page, 'Personal app editor — every group open');

    const more = page.locator('main button[aria-haspopup]').first();
    await more.click();
    await expect(page.getByRole('menuitem', { name: 'Hand over' })).toBeVisible();
    await expectNoBlockingViolations(page, 'Personal app editor — the menu');

    await page.getByRole('menuitem', { name: 'Hand over' }).click();
    await expect(page.getByPlaceholder('Search people')).toBeVisible();
    await expectNoBlockingViolations(page, 'Personal app editor — hand over');
    await page.keyboard.press('Escape');

    await gotoSettled(page, `/apps/${ownAppId}/edit?dialog=share`);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(`Share "${NAME}"`);
    await expectNoBlockingViolations(page, 'Personal app editor — share dialog');
  });

  test('the chat of an app someone else owns: the notice, collapsed, and the instructions', async ({
    page
  }) => {
    await gotoSettled(page, `/apps/${foreignAppId}`);
    const notice = page.getByTestId('personal-app-notice');
    await expect(notice).toContainText('owns this app. Administrators have not checked it.');
    await expectNoBlockingViolations(page, 'Personal app chat — the notice');

    await notice.getByRole('button', { name: 'Show instructions' }).click();
    await expect(page.getByTestId('personal-app-instructions')).toBeVisible();
    await expectNoBlockingViolations(page, 'Personal app chat — the instructions');
    await page.keyboard.press('Escape');

    await notice.getByRole('button', { name: 'Show less' }).click();
    await expect(notice.getByRole('button', { name: /Personal app by/ })).toBeVisible();
    await expectNoBlockingViolations(page, 'Personal app chat — the notice collapsed');
    // Remembered per app for the tab: put it back for whoever reads the page next.
    await notice.getByRole('button', { name: /Personal app by/ }).click();
  });

  test('the admin tab: the list, the menu of a row, the settings and the switch-off dialog', async ({
    page
  }) => {
    await gotoSettled(page, '/admin/apps?tab=personal');
    const row = page.getByRole('row').filter({ hasText: `${NAME} of a colleague` });
    await expect(row).toBeVisible();
    await expectNoBlockingViolations(page, 'Admin — personal apps');

    await page.getByText('Personal app settings').click();
    await expect(page.locator('#user-app-settings-allowPublish')).toBeVisible();
    await expectNoBlockingViolations(page, 'Admin — personal app settings');
    await page.getByText('Personal app settings').click();

    await row.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem').first()).toBeVisible();
    await expectNoBlockingViolations(page, 'Admin — the menu of a personal app');
    await page.getByRole('menuitem', { name: 'Switch off', exact: true }).click();
    const dialog = page.getByRole('dialog').or(page.getByRole('alertdialog')).first();
    await expect(dialog).toBeVisible();
    await expectNoBlockingViolations(page, 'Admin — switch a personal app off');
  });

  test('the admin offer and take-over dialogs, the receiver of an offer, publishing and the retired app', async ({
    page
  }) => {
    const settingsBefore = await (await page.request.get('/api/admin/user-apps/_settings')).json();
    const setPublish = allowPublish =>
      page.request.put('/api/admin/user-apps/_settings', { data: { sharing: { allowPublish } } });
    let companyAppId = null;
    try {
      expect((await setPublish(true)).status()).toBe(200);

      // Admin: the offer dialog with people listed, and the take-over dialog. Someone
      // to list besides the owner and the administrator, who are never offered.
      const users = Object.values(
        (await (await page.request.get('/api/admin/auth/users')).json()).users || {}
      );
      if (!users.some(user => user.username === 'e2e-a11y-receiver')) {
        const created = await page.request.post('/api/admin/auth/users', {
          data: {
            username: 'e2e-a11y-receiver',
            password: 'receiver-a11y-pass-1',
            name: 'Demo Receiver',
            email: 'receiver@example.com',
            internalGroups: ['users'],
            active: true
          }
        });
        expect(created.ok(), await created.text()).toBe(true);
      }
      await gotoSettled(page, '/admin/apps?tab=personal');
      const row = page.getByRole('row').filter({ hasText: `${NAME} of a colleague` });
      await row.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Offer to a new owner' }).click();
      const offer = page.getByRole('dialog');
      await offer.getByRole('searchbox', { name: 'Find a person' }).fill('Demo');
      await expect(offer.getByRole('radio').first()).toBeVisible();
      await expectNoBlockingViolations(page, 'Admin — offer a personal app, people listed');
      await page.keyboard.press('Escape');

      await row.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Take over as app…' }).click();
      await expect(page.getByLabel('App ID')).toBeVisible();
      await expectNoBlockingViolations(page, 'Admin — take a personal app over as an app');
      await page.keyboard.press('Escape');

      // The receiver of an offer: the colleague offers their app to the administrator.
      const adminId = (await (await page.request.get(`/api/apps/${ownAppId}`)).json()).owner.id;
      const foreignApp = await (await foreign.get(`/api/apps/${foreignAppId}`)).json();
      const offered = await foreign.put(`/api/apps/${foreignAppId}/owner-offer`, {
        data: { ownerId: adminId },
        headers: { 'If-Match': `"${foreignApp.revision}"` }
      });
      expect(offered.status(), await offered.text()).toBe(200);
      await gotoSettled(page, `/apps/${foreignAppId}/edit`);
      await expect(page.getByTestId('user-app-offer')).toBeVisible();
      await expectNoBlockingViolations(page, 'Personal app editor — the receiver of an offer');

      // The owner publishes an app without tools: the dialog, then the page of the retired app.
      await gotoSettled(page, `/apps/${ownAppId}/edit`);
      await page.getByRole('button', { name: 'More' }).click();
      await page.getByRole('menuitem', { name: 'Publish' }).click();
      const publish = page.getByRole('alertdialog');
      await expect(publish).toContainText(`Publish "${NAME}"`);
      await expectNoBlockingViolations(page, 'Personal app editor — publish dialog');
      const [published] = await Promise.all([
        page.waitForResponse(response => response.url().endsWith(`/${ownAppId}/_publish`)),
        publish.getByRole('button', { name: 'Publish' }).click()
      ]);
      expect(published.status(), await published.text()).toBe(200);
      companyAppId = (await published.json()).publishedAs?.appId ?? null;
      await expect(page.getByText('This app is now a company app.')).toBeVisible();
      await expectNoBlockingViolations(page, 'Personal app — the page of a retired app');
    } finally {
      if (companyAppId) await page.request.delete(`/api/admin/apps/${companyAppId}`);
      await setPublish(settingsBefore?.sharing?.allowPublish === true);
    }
  });
});

// axe's WCAG tag set does not include the landmark rules (they are best
// practices), so they are run explicitly: a screen-reader user navigates by
// landmark, and a second <main> (or an unlabelled duplicate) makes that list
// ambiguous.
// The workspace pane of a chat (concept "Workspace Pane for Artifacts, Files and Sources"),
// over a shared chat whose share routes are intercepted (see helpers/sharedChatWithArtifacts.js):
// no model, no stored chat needed. Docked it is a labelled region next to the chat with a
// separator; full screen it is the same region; below 1024px it is a modal sheet.
test.describe('Accessibility — the workspace pane', () => {
  test('has no critical or serious violations docked: the Files index, a file, a menu', async ({
    page
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockSharedChatWithArtifacts(page);
    await page.goto(`/share/${SHARE_ID}`);
    await page.getByTestId('open-artifacts').click();
    const files = page.getByRole('region', { name: 'Workspace: Files' });
    await expect(files.getByRole('listitem')).toHaveCount(3);
    await expect(page.getByRole('separator', { name: 'Resize workspace' })).toBeVisible();
    await expectNoBlockingViolations(page, 'Workspace pane — Files index');

    await files.getByRole('button', { name: /src\/index\.js/ }).click();
    const viewer = page.getByRole('region', { name: 'Workspace: src/index.js' });
    await expect(viewer.getByLabel('Content of src/index.js')).toBeVisible();
    await expectNoBlockingViolations(page, 'Workspace pane — artifact');

    await viewer.getByRole('button', { name: 'More actions' }).click();
    await expect(viewer.getByRole('menu')).toBeVisible();
    await expectNoBlockingViolations(page, 'Workspace pane — menu');
  });

  test('has no critical or serious violations in full screen', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockSharedChatWithArtifacts(page);
    await page.goto(`/share/${SHARE_ID}`);
    await page.getByTestId('generated-file-open').filter({ hasText: 'src/index.js' }).click();
    await page.getByRole('button', { name: 'Full screen' }).click();
    const viewer = page.getByRole('region', { name: 'Workspace: src/index.js' });
    await expect(viewer).toHaveAttribute('data-state', 'full');
    await expect(viewer.getByLabel('Content of src/index.js')).toBeVisible();
    await expectNoBlockingViolations(page, 'Workspace pane — full screen');
  });

  test('is a modal sheet below 1024px with no critical or serious violations', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockSharedChatWithArtifacts(page);
    await page.goto(`/share/${SHARE_ID}`);
    await page.getByTestId('generated-file-open').filter({ hasText: 'src/index.js' }).click();
    const sheet = page.getByRole('dialog', { name: 'Workspace: src/index.js' });
    await expect(sheet).toHaveAttribute('aria-modal', 'true');
    await expect(sheet.getByLabel('Content of src/index.js')).toBeVisible();
    await expectNoBlockingViolations(page, 'Workspace pane — sheet');
  });
});

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
    '/admin/security',
    '/admin/eu-ai-act'
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
