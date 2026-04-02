import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Accessibility End-to-End Tests
 *
 * Scans key pages for WCAG 2.1 Level AA violations using axe-core.
 * These tests catch automatically detectable accessibility issues such as
 * missing alt text, insufficient color contrast, missing form labels, and
 * incorrect ARIA attribute usage.
 *
 * Tags used:
 *   wcag2a    — WCAG 2.0 Level A
 *   wcag2aa   — WCAG 2.0 Level AA
 *   wcag21a   — WCAG 2.1 Level A
 *   wcag21aa  — WCAG 2.1 Level AA
 *
 * Only "critical" and "serious" impact violations cause test failure.
 * "moderate" and "minor" violations are logged for awareness but do not
 * block the build.
 *
 * @see https://www.w3.org/TR/WCAG21/
 * @see https://github.com/dequelabs/axe-core
 */

/** WCAG 2.1 AA rule tags passed to every AxeBuilder scan. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

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

test.describe('Accessibility — WCAG 2.1 AA Compliance', () => {
  test.describe('Home / Apps list page', () => {
    test('should not have critical or serious accessibility violations', async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const results = await createAxeScanner(page).analyze();

      const blocking = getBlockingViolations(results.violations);

      // Log all violations for awareness regardless of severity
      if (results.violations.length > 0) {
        console.log(
          `[a11y] Home page — ${results.violations.length} total violation(s):\n` +
            formatViolationSummary(results.violations)
        );
      }

      expect(
        blocking,
        `Home page has ${blocking.length} critical/serious a11y violation(s):\n` +
          formatViolationSummary(blocking)
      ).toEqual([]);
    });
  });

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
