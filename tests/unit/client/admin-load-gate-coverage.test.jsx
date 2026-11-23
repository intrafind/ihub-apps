// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps
/**
 * Ratchet: an admin screen that loads a configuration and saves it must not
 * offer Save after the load failed — it would write defaults over the stored
 * settings (ID-B1, IN-B1, IN-B6, OB-B1, OB-B2, PL-B3, CU-B5).
 *
 * Every file under client/src/features/admin that POSTs/PUTs/PATCHes a config
 * endpoint must load through `useAdminConfigLoad` (with `AdminLoadGate`) or
 * `useAdminResourceEditor` (with `AdminEditPageShell`), or be listed in
 * KNOWN_UNGATED with the reason it is safe. The list may only shrink: an entry
 * that now uses the hook, or no longer saves a config, fails the test until it
 * is removed.
 */
import fs from 'fs';
import path from 'path';

const ADMIN_ROOT = path.resolve(__dirname, '../../../client/src/features/admin');

/** Endpoints that hold configuration (as opposed to resources or actions). */
const CONFIG_URL = /config|settings|rate-limits|llm-timeouts|disclaimer/i;

/** A makeAdminApiCall('<url>', { … method: 'POST'|'PUT'|'PATCH' … }) call. */
const WRITE_CALL =
  /makeAdminApiCall\(\s*([`'"])([^`'"]*)\1\s*,\s*\{[^}]*?method:\s*['"](POST|PUT|PATCH)['"]/gs;

const GATED = /useAdminConfigLoad\(|useAdminResourceEditor\(/;

/**
 * Files that save a config without the shared hook, each with the reason a
 * failed load cannot save defaults. Shrink-only.
 */
const KNOWN_UNGATED = {
  'components/AdminUserPromptsTab.jsx': 'renders nothing until the settings loaded (`!draft`)',
  'components/AiAcknowledgementSettingsCard.jsx': 'form only once loaded (`form &&`)',
  'components/AiNoticeSettingsCard.jsx': 'form only once loaded (`notice && !loadFailed`)',
  'components/euAiAct/ProvenanceSettingsCard.jsx': 'form only once loaded (`!form`)',
  'pages/AdminAdvancedPage.jsx': 'switch disabled until loaded (`onboardingDisabled === null`)',
  'pages/AdminChatHistoryPage.jsx': 'renders a spinner until the settings loaded (`!settings`)',
  'pages/AdminDisclaimerPage.jsx': 'AdminLoadError instead of the form (`!draft`)',
  'pages/AdminLocalizationPage.jsx': 'Save disabled until loaded (`!loaded`)',
  'pages/AdminOAuthClientsPage.jsx': 'the only write flips one flag of a freshly read config',
  'pages/AdminPromptsPage.jsx': 'variables tab shows AdminLoadError until loaded',
  'pages/AdminScheduledTasksPage.jsx': 'settings card only once loaded (`settings &&`)'
};

function listSources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSources(full);
    return /\.(js|jsx)$/.test(entry.name) ? [full] : [];
  });
}

function configWriters() {
  return listSources(ADMIN_ROOT)
    .map(file => {
      const source = fs.readFileSync(file, 'utf8');
      const urls = [...source.matchAll(WRITE_CALL)]
        .map(match => match[2])
        .filter(url => CONFIG_URL.test(url));
      return {
        file: path.relative(ADMIN_ROOT, file).split(path.sep).join('/'),
        writesConfig: urls.length > 0,
        gated: GATED.test(source)
      };
    })
    .filter(entry => entry.writesConfig);
}

describe('admin config pages gate their form on a successful load', () => {
  const writers = configWriters();

  it('finds the config writers (sanity check of the scan)', () => {
    const files = writers.map(entry => entry.file);
    expect(files).toEqual(
      expect.arrayContaining([
        'pages/AdminAuthPage.jsx',
        'pages/AdminMcpGatewayPage.jsx',
        'pages/AdminTelemetryPage.jsx',
        'pages/AdminLoggingPage.jsx',
        'components/SSLConfig.jsx',
        'components/SsrfConfig.jsx',
        'components/CorsConfig.jsx',
        'components/CookieSettingsConfig.jsx',
        'components/ProxyConfig.jsx'
      ])
    );
  });

  it('every config writer uses the load hook or is a known, explained exception', () => {
    const ungated = writers
      .filter(entry => !entry.gated && !Object.hasOwn(KNOWN_UNGATED, entry.file))
      .map(entry => entry.file);
    expect(ungated).toEqual([]);
  });

  it('the exception list only shrinks', () => {
    const stale = Object.keys(KNOWN_UNGATED).filter(file => {
      const entry = writers.find(writer => writer.file === file);
      return !entry || entry.gated;
    });
    // Remove these from KNOWN_UNGATED: they are gated now or no longer save a config.
    expect(stale).toEqual([]);
  });

  it.each([
    'pages/AdminAuthPage.jsx',
    'pages/AdminMcpGatewayPage.jsx',
    'pages/AdminOfficeIntegrationPage.jsx',
    'pages/AdminBrowserExtensionPage.jsx',
    'pages/AdminCopilotAgentPage.jsx',
    'pages/AdminNextcloudEmbedPage.jsx',
    'pages/AdminTelemetryPage.jsx',
    'pages/AdminLoggingPage.jsx',
    'pages/AdminUICustomization.jsx',
    'components/SSLConfig.jsx',
    'components/SsrfConfig.jsx',
    'components/CorsConfig.jsx',
    'components/CookieSettingsConfig.jsx',
    'components/ProxyConfig.jsx'
  ])('%s renders AdminLoadGate and guards its saves', file => {
    const source = fs.readFileSync(path.join(ADMIN_ROOT, file), 'utf8');
    expect(source).toMatch(/useAdminConfigLoad\(/);
    expect(source).toMatch(/<AdminLoadGate\b/);
    // A section registered with the page's save bar returns `false` when it did not save.
    expect(source).toMatch(/if \(!ready(?: \|\| !\w+)?\) return(?: false)?;/);
  });
});
