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
 * @param {string[]} [knownRuleIds] - axe rules this page is known to violate;
 *   logged but not failed, so only a new kind of violation fails the test
 */
async function expectNoBlockingViolations(page, label, knownRuleIds = []) {
  const results = await createAxeScanner(page).analyze();
  const blocking = getBlockingViolations(results.violations).filter(
    v => !knownRuleIds.includes(v.id)
  );

  if (results.violations.length > 0) {
    console.log(
      `[a11y] ${label} — ${results.violations.length} total violation(s):\n` +
        formatViolationSummary(results.violations)
    );
  }

  const fixed = knownRuleIds.filter(id => !results.violations.some(v => v.id === id));
  if (fixed.length > 0) {
    console.log(
      `[a11y] ${label} — known violation(s) no longer found: ${fixed.join(', ')}. ` +
        'Remove them from KNOWN_VIOLATIONS so they cannot come back unnoticed.'
    );
  }

  expect(
    blocking,
    `${label} has ${blocking.length} critical/serious a11y violation(s):\n` +
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

// Most of the product sits behind a login: the chat UI, the prompt library and
// the admin pages. These scans sign in as the default local admin that a fresh
// contents/ ships (CLAUDE.md, "Default Local Admin"); override with
// TEST_ADMIN_USERNAME / TEST_ADMIN_PASSWORD against other environments.
test.describe('Accessibility — signed-in pages (WCAG 2.2 AA)', () => {
  test.beforeEach(async ({ page }) => {
    const response = await page.request.post('/api/auth/local/login', {
      data: {
        username: process.env.TEST_ADMIN_USERNAME || 'admin',
        password: process.env.TEST_ADMIN_PASSWORD || 'password123'
      }
    });
    expect(response.ok(), `Admin login failed with HTTP ${response.status()}`).toBeTruthy();
  });

  // Critical/serious violations these pages already had when the signed-in
  // scans were added (October 2026). They are logged on every run but only a
  // new kind of violation fails the test. Fix them and delete the entry; the
  // log says when one is gone.
  //   color-contrast     - low-contrast secondary text (mostly text-gray-400)
  //   label              - unlabelled file input / toggle checkbox
  //   nested-interactive - prompt cards are buttons containing buttons
  const KNOWN_VIOLATIONS = {
    '/apps/chat': ['color-contrast'],
    '/prompts': ['color-contrast', 'nested-interactive'],
    '/chats': ['color-contrast'],
    '/admin': ['color-contrast'],
    '/admin/apps': ['label'],
    '/admin/models': ['label'],
    '/admin/users': ['color-contrast', 'label'],
    '/admin/groups': ['color-contrast']
  };

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
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expect(new URL(page.url()).pathname, `${label} redirected away from ${path}`).toBe(path);

      await expectNoBlockingViolations(page, label, KNOWN_VIOLATIONS[path]);
    });
  }
});
