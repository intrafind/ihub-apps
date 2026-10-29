// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Admin → Integrations → People directories (concept
 * concepts/2026-10-28 People Directory Search (LDAP and Entra).md, §6).
 *
 * Signs in as the default local admin a fresh contents/ ships (CLAUDE.md,
 * "Default Local Admin"; override with TEST_ADMIN_USERNAME / TEST_ADMIN_PASSWORD).
 *
 *   - The shipped, disabled `x500bund` entry is switched on and off again
 *     against the real server, so the switch, the PUT and the "People search"
 *     app offer work end to end. It leaves the entry as it found it.
 *   - Everything else runs against `page.route` mocks of the people directory
 *     API, so it neither changes contents/ nor needs an LDAP server: a sign-in
 *     provider for "Use for people search", a plain-text directory for the
 *     warning badge, and a canned connection-test report.
 *   - axe-core scans the list, the certificate tab and the editor for critical
 *     and serious WCAG 2.2 AA violations, as tests/e2e/accessibility.spec.js does.
 *
 * Run: npx playwright test --config tests/config/playwright.config.js \
 *        tests/e2e/people-directories.spec.js --project=chromium
 */

const LIST = '/admin/integrations/people-directories';
const API = '/api/admin/people-directories';

/** WCAG 2.2 AA rule tags, the same set the accessibility spec scans with. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

/** The shipped external directory, as GET returns it. */
const X500 = {
  id: 'x500bund',
  enabled: false,
  type: 'ldap',
  url: 'ldaps://x500.bund.de:636',
  baseDn: 'o=Bund,c=DE',
  preset: 'ivbb',
  bind: { mode: 'anonymous' },
  units: true,
  allowPlaintext: false,
  tlsCa: ['pca-1-verwaltung-23'],
  maxResults: 25,
  timeoutMs: 8000,
  concurrency: 2,
  requestDelayMs: 0,
  groups: ['authenticated'],
  dataFlow: 'external',
  name: { en: 'Federal directory (IVBB)', de: 'Verzeichnisdienst des Bundes (IVBB)' },
  description: {
    en: 'Public directory of German federal authorities. External service.',
    de: 'Öffentliches Verzeichnis der Bundesbehörden. Externer Dienst.'
  }
};

/** An internal directory still reached over plain ldap://. */
const LEGACY = {
  id: 'legacy',
  enabled: true,
  type: 'ldap',
  url: 'ldap://ldap.corp.local:389',
  baseDn: 'dc=corp,dc=local',
  preset: 'openldap',
  allowPlaintext: true,
  allowedHosts: ['ldap.corp.local'],
  groups: ['authenticated'],
  dataFlow: 'internal',
  name: { en: 'Legacy directory', de: 'Altes Verzeichnis' }
};

/** An LDAP sign-in provider, as platform.json holds it and as GET summarises it. */
const CORP_PROVIDER = {
  name: 'corp-ad',
  displayName: 'Corporate AD',
  url: 'ldaps://dc.corp.local:636',
  preset: 'activeDirectory',
  baseDn: 'dc=corp,dc=local',
  adminDn: 'cn=svc-ihub,ou=services,dc=corp,dc=local',
  adminPasswordRef: 'corp-ad-bind',
  defaultGroups: [],
  sessionTimeoutMinutes: 480
};
const CORP_PROVIDER_SUMMARY = {
  name: 'corp-ad',
  displayName: 'Corporate AD',
  url: 'ldaps://dc.corp.local:636',
  host: 'dc.corp.local',
  baseDn: 'dc=corp,dc=local',
  preset: 'activeDirectory',
  starttls: false,
  hasBindAccount: true
};

/** A connection test that failed on the certificate, after a successful sample search would map one person. */
const TEST_REPORT = {
  success: false,
  message: 'The certificate of x500.bund.de is not trusted.',
  summary: { ok: 2, warn: 0, fail: 1, durationMs: 120 },
  steps: [
    {
      id: 'configuration',
      label: 'Effective configuration',
      status: 'ok',
      message: 'ldaps://x500.bund.de:636, preset "ivbb", people under o=Bund,c=DE',
      durationMs: 1
    },
    {
      id: 'network',
      label: 'Address check (SSRF)',
      status: 'ok',
      message: 'x500.bund.de resolves to a public address',
      durationMs: 12
    },
    {
      id: 'connect',
      label: 'Connect',
      status: 'fail',
      message: 'issuer "PCA-1-Verwaltung-23" is not trusted (UNABLE_TO_GET_ISSUER_CERT)',
      hints: ['Add the issuer to the certificate store and to tlsCa.'],
      details: {
        host: 'x500.bund.de',
        port: 636,
        missingIssuer: 'C=DE\nO=PKI-1-Verwaltung\nCN=PCA-1-Verwaltung-23',
        certificateChain: [
          {
            subject: 'C=DE\nO=Bund\nCN=x500.bund.de',
            issuer: 'C=DE\nO=PKI-1-Verwaltung\nCN=CA IVBB Deutsche Telekom AG 23',
            validFrom: 'Dec  3 00:00:00 2025 GMT',
            validTo: 'Dec  3 23:59:59 2026 GMT',
            fingerprint256: 'AB:CD:EF:01:23:45:67:89'
          }
        ]
      },
      durationMs: 80
    }
  ],
  results: [
    {
      directory: 'x500bund',
      personId: 'cn=Mustermann Erika,l=Karlsruhe,ou=MRI,o=Bund,c=DE',
      name: 'Erika Mustermann',
      firstName: 'Erika',
      lastName: 'Mustermann',
      salutation: 'Frau',
      academicTitle: 'Dr.',
      jobTitle: 'Vertreterin des Präsidenten',
      department: 'Leitung',
      organization: 'MRI',
      location: 'Karlsruhe',
      email: 'erika.mustermann@example.org',
      phone: '0721 0000 - 300',
      fax: null,
      mobile: null,
      managerId: null
    }
  ]
};

// The auth API allows 50 requests per 15 minutes; sign in once per worker and
// reuse the session cookies (as tests/e2e/accessibility.spec.js does).
let adminCookies;

/**
 * Signs in as the default local admin. The dev server is up before the API
 * behind its proxy, which answers 502 until then; keep trying while it starts.
 *
 * @param {import('@playwright/test').Page} page
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

/**
 * A fresh contents/ shows the first-run disclaimer, a modal dialog that holds
 * focus until it is acknowledged; get past it.
 *
 * @param {import('@playwright/test').Page} page
 */
async function acknowledgeDisclaimer(page) {
  const acknowledge = page.getByRole('button', { name: 'I understand' });
  if (await acknowledge.isVisible().catch(() => false)) {
    await acknowledge.click();
    await expect(acknowledge).toBeHidden();
  }
}

/**
 * Opens a page, waits for it to settle and gets past the disclaimer. The admin
 * API has a per-minute request limit, which a run right after other specs can
 * reach; the page then says "Too many ... requests" instead of showing its
 * content. Wait out the limit's window and load the page again (as
 * gotoSettled in tests/e2e/accessibility.spec.js does).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} path
 */
async function open(page, path) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await acknowledgeDisclaimer(page);
    const rateLimited = await page
      .getByText(/too many .{0,40}requests/i)
      .first()
      .isVisible()
      .catch(() => false);
    if (!rateLimited) return;
    await page.waitForTimeout(20_000);
  }
}

/**
 * What the server would resolve for a directory, enough for the list page.
 * @param {Object} directory
 */
function summarize(directory) {
  const url = directory.url || (directory.authProvider ? CORP_PROVIDER_SUMMARY.url : '');
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    host = '';
  }
  return {
    sourceType: directory.authProvider ? 'authProvider' : 'direct',
    source: directory.authProvider || host,
    preset: directory.preset || (directory.authProvider ? 'activeDirectory' : 'openldap'),
    transport: url.startsWith('ldaps://')
      ? 'ldaps'
      : url.startsWith('ldap://')
        ? directory.starttls
          ? 'starttls'
          : 'plaintext'
        : 'unknown',
    external: directory.dataFlow === 'external',
    problems: [],
    warnings: []
  };
}

/**
 * Serves the people directory list from memory: GET returns it, PUT replaces
 * it, POST /test answers with `testReport`. Presets and the certificate store
 * still come from the server, read-only.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Object} options
 * @param {Object[]} options.directories - Initial list
 * @param {Object[]} [options.ldapProviders] - Sign-in providers to offer
 * @param {Object} [options.testReport] - Response of the connection test
 * @returns {Promise<{state: {directories: Object[]}, puts: Object[], tests: Object[]}>}
 */
async function mockDirectoriesApi(page, { directories, ldapProviders = [], testReport }) {
  const recorded = { state: { directories: structuredClone(directories) }, puts: [], tests: [] };
  await page.route(
    url => new URL(url).pathname.endsWith(API),
    async route => {
      const request = route.request();
      if (request.method() === 'PUT') {
        const body = request.postDataJSON();
        recorded.puts.push(body);
        recorded.state.directories = body.directories;
        return route.fulfill({ json: { success: true, directories: body.directories } });
      }
      return route.fulfill({
        json: {
          directories: recorded.state.directories,
          effective: Object.fromEntries(
            recorded.state.directories.map(directory => [directory.id, summarize(directory)])
          ),
          ldapProviders,
          peopleSearchApp: { id: 'people-directory', exists: true, enabled: false }
        }
      });
    }
  );
  await page.route(
    url => new URL(url).pathname.endsWith(`${API}/test`),
    async route => {
      recorded.tests.push(route.request().postDataJSON());
      return route.fulfill({ json: testReport || TEST_REPORT });
    }
  );
  return recorded;
}

/**
 * Scans the page and fails on critical or serious WCAG 2.2 AA violations.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} label - Page name for the failure message
 */
async function expectNoBlockingViolations(page, label) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const blocking = results.violations.filter(
    violation => violation.impact === 'critical' || violation.impact === 'serious'
  );
  const summary = blocking
    .map(
      violation =>
        `  [${violation.impact}] ${violation.id}: ${violation.help}\n` +
        violation.nodes.map(node => `    - ${node.html}`).join('\n')
    )
    .join('\n');
  expect(blocking, `${label} has critical/serious a11y violations:\n${summary}`).toEqual([]);
}

test.describe('Admin people directories', () => {
  test.beforeEach(async ({ page }) => {
    // Room for waiting out the admin API's request limit (see open).
    test.setTimeout(150_000);
    await signInAsAdmin(page);
  });

  test('the shipped x500bund entry can be switched on and off again', async ({ page }) => {
    await open(page, LIST);
    const toggle = page.getByRole('switch', { name: 'Federal directory (IVBB)' });
    await expect(toggle).toBeVisible();
    // A previous run that stopped half-way may have left it on.
    if ((await toggle.getAttribute('aria-checked')) === 'true') {
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
    }

    const switchedOn = page.waitForResponse(
      response => response.url().endsWith(API) && response.request().method() === 'PUT'
    );
    await toggle.click();
    expect((await switchedOn).status()).toBe(200);
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('"Federal directory (IVBB)" is on.')).toBeVisible();

    // The shipped People search app is disabled: the page offers it, and
    // nothing happens without a click. Leave the app as it is.
    const notNow = page.getByRole('button', { name: 'Not now' });
    if (await notNow.isVisible().catch(() => false)) await notNow.click();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByText('"Federal directory (IVBB)" is off.')).toBeVisible();

    const stored = await (await page.request.get(API)).json();
    expect(stored.directories.find(directory => directory.id === 'x500bund').enabled).toBe(false);
  });

  test('the list marks plain-text and external directories, and offers the app', async ({
    page
  }) => {
    const api = await mockDirectoriesApi(page, { directories: [X500, LEGACY] });
    let toggledApp = null;
    await page.route('**/api/admin/apps/people-directory/_toggle', async route => {
      toggledApp = route.request().postDataJSON();
      return route.fulfill({ json: { success: true } });
    });
    await open(page, LIST);

    const federalRow = page.getByRole('listitem').filter({ hasText: 'Federal directory (IVBB)' });
    await expect(federalRow.getByText('External', { exact: true })).toBeVisible();
    await expect(federalRow.getByText('Plain text', { exact: true })).toHaveCount(0);
    const legacyRow = page.getByRole('listitem').filter({ hasText: 'Legacy directory' });
    await expect(legacyRow.getByText('Plain text', { exact: true })).toBeVisible();
    await expect(legacyRow.getByText('External', { exact: true })).toHaveCount(0);

    await page.getByRole('switch', { name: 'Federal directory (IVBB)' }).click();
    await expect(page.getByRole('switch', { name: 'Federal directory (IVBB)' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(api.puts).toHaveLength(1);
    expect(api.puts[0].directories.map(d => [d.id, d.enabled])).toEqual([
      ['x500bund', true],
      ['legacy', true]
    ]);

    await page.getByRole('button', { name: 'Enable app' }).click();
    await expect(page.getByText('The "People search" app is on.')).toBeVisible();
    expect(toggledApp).toEqual({ enabled: true });
  });

  test('"Use for people search" on a sign-in provider creates a directory', async ({ page }) => {
    // The authentication page shows LDAP providers only while LDAP sign-in is on.
    await page.route('**/api/admin/configs/platform', async route => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const platform = await response.json();
      return route.fulfill({
        response,
        json: { ...platform, ldapAuth: { enabled: true, providers: [CORP_PROVIDER] } }
      });
    });
    const api = await mockDirectoriesApi(page, {
      directories: [X500],
      ldapProviders: [CORP_PROVIDER_SUMMARY]
    });

    await open(page, '/admin/auth');
    await page
      .getByRole('link', { name: /Use for people search/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/admin\/integrations\/people-directories\/new\?/);

    await expect(page.getByLabel('ID', { exact: true })).toHaveValue('corp-ad');
    await expect(page.getByLabel('Reuse a sign-in provider')).toBeChecked();
    await expect(page.getByLabel('Sign-in provider', { exact: true })).toHaveValue('corp-ad');
    await expect(page.getByLabel('Name (EN)')).toHaveValue('Corporate AD');
    await page
      .getByLabel('Description (EN)')
      .fill('Employees of our company: name, e-mail, phone, department, manager.');

    await expectNoBlockingViolations(page, 'People directory editor (sign-in provider)');

    await page.getByRole('button', { name: 'Save directory' }).click();
    await expect(page).toHaveURL(new RegExp(`${LIST}$`));
    await expect(page.getByText('Directory "corp-ad" saved.')).toBeVisible();

    expect(api.puts).toHaveLength(1);
    const saved = api.puts[0].directories.find(directory => directory.id === 'corp-ad');
    expect(saved).toEqual({
      id: 'corp-ad',
      enabled: true,
      type: 'ldap',
      authProvider: 'corp-ad',
      groups: ['authenticated'],
      dataFlow: 'internal',
      name: { en: 'Corporate AD', de: 'Corporate AD' },
      description: { en: 'Employees of our company: name, e-mail, phone, department, manager.' }
    });
    const row = page.getByRole('listitem').filter({ hasText: 'Corporate AD' });
    await expect(row.getByText('Sign-in provider corp-ad')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Corporate AD' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  test('the test panel sends the unsaved form and shows the report', async ({ page }) => {
    const api = await mockDirectoriesApi(page, { directories: [X500] });
    await open(page, `${LIST}/x500bund`);

    await page.getByRole('textbox', { name: 'Base DN' }).fill('ou=MRI,o=Bund,c=DE');
    await page.getByLabel('Name to search for (optional)').fill('Mustermann');
    await page.getByRole('button', { name: 'Test', exact: true }).click();

    await expect(page.getByText('Connection test', { exact: true })).toBeVisible();
    await expect(
      page.getByText(/issuer "PCA-1-Verwaltung-23" is not trusted \(UNABLE/)
    ).toBeVisible();
    await expect(
      page.getByText(/The issuer "PCA-1-Verwaltung-23" is not trusted\. Get/)
    ).toBeVisible();
    await expect(page.getByText('AB:CD:EF:01:23:45:67:89', { exact: true })).toBeVisible();
    const people = page.getByRole('table', { name: 'Mapped results (1)' });
    await expect(people.getByText('Vertreterin des Präsidenten')).toBeVisible();
    await expect(people.getByText('Karlsruhe')).toBeVisible();

    expect(api.tests).toHaveLength(1);
    expect(api.tests[0].query).toBe('Mustermann');
    expect(api.tests[0].directory).toMatchObject({
      id: 'x500bund',
      url: 'ldaps://x500.bund.de:636',
      baseDn: 'ou=MRI,o=Bund,c=DE',
      tlsCa: ['pca-1-verwaltung-23']
    });
    // Testing saves nothing.
    expect(api.puts).toHaveLength(0);

    await expectNoBlockingViolations(page, 'People directory editor with test report');
  });

  test('the editor warns about plain text until it is allowed', async ({ page }) => {
    await mockDirectoriesApi(page, { directories: [LEGACY] });
    await open(page, `${LIST}/legacy`);
    await expect(page.getByText('Plain text', { exact: true })).toBeVisible();
    const allow = page.getByLabel('Allow plain-text connections (ldap:// without StartTLS)');
    await expect(allow).toBeChecked();
    await allow.uncheck();
    await expect(
      page.getByText(/iHub refuses the connection until plain text is allowed here/)
    ).toBeVisible();
  });

  test('list, certificates tab and editor have no critical or serious a11y violations', async ({
    page
  }) => {
    await mockDirectoriesApi(page, {
      directories: [X500, LEGACY],
      ldapProviders: [CORP_PROVIDER_SUMMARY]
    });

    await open(page, LIST);
    await expect(page.getByRole('switch', { name: 'Legacy directory' })).toBeVisible();
    await expectNoBlockingViolations(page, 'People directories list');

    await page.getByRole('tab', { name: 'Certificates' }).click();
    await expect(page).toHaveURL(/tab=certificates/);
    await expect(page.getByRole('heading', { name: 'Certificates in the store' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectNoBlockingViolations(page, 'People directory certificates');

    // Arrow keys move between the tabs.
    await page.getByRole('tab', { name: 'Certificates' }).press('ArrowLeft');
    await expect(page.getByRole('tab', { name: 'Directories' })).toBeFocused();
    await expect(page.getByRole('tab', { name: 'Directories' })).toHaveAttribute(
      'aria-selected',
      'true'
    );

    await open(page, `${LIST}/new`);
    await expect(page.getByRole('heading', { name: 'Add people directory' })).toBeVisible();
    await expectNoBlockingViolations(page, 'New people directory');

    await open(page, `${LIST}/x500bund`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Federal directory (IVBB)');
    await expectNoBlockingViolations(page, 'People directory editor (direct)');
  });
});
