// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import fs from 'fs';
import path from 'path';

/**
 * Ratchet: every admin page that saves something shows the shared bottom save bar
 * (`AdminSaveBar`, `EditorSaveBar`, or `AdminSettingsPage` with `onSave`), so a change is
 * handled the same way on every page: the bar appears when something changed, with Save and
 * Discard, and is gone when nothing changed.
 *
 * Pages that still have their own Save button are listed in BASELINE, with the step of the
 * rollout that converts them. The list may only shrink: a page that gains the bar must be
 * taken off it, and no new page may be added to it. Give the page the bar instead.
 */

const PAGES_DIR = path.resolve(__dirname, '../../../client/src/features/admin/pages');

/** A Save button, a submit button, a form submit handler or a shared save frame. */
const SAVE_CONTROL =
  /AdminSaveBar|EditorSaveBar|AdminSettingsPage|type="submit"|onSubmit=\{|onClick=\{[^}\n]*\b(?:handle)?[sS]ave[A-Za-z]*\b/;

/** The shared bar, directly or through the settings frame that renders it for `onSave`. */
const SAVE_BAR = /<(?:AdminSaveBar|EditorSaveBar)\b/;
const SETTINGS_FRAME_WITH_BAR = source =>
  source.includes('<AdminSettingsPage') && /onSave=\{/.test(source);

const SETTINGS = 'settings page (part 2 of the rollout)';
const CARDS = 'sections with their own Save (part 3 of the rollout)';
const OTHER = 'edit page, still to convert';

/** Pages with a save control and no bar yet. Shrink-only. */
const BASELINE = new Map([
  ['AdminAppsPage.jsx', `${OTHER}: app order draft (Save order)`],
  ['AdminAuthPage.jsx', SETTINGS],
  ['AdminBrowserExtensionPage.jsx', SETTINGS],
  ['AdminChatHistoryPage.jsx', SETTINGS],
  ['AdminCopilotAgentPage.jsx', SETTINGS],
  ['AdminCredentialsPage.jsx', OTHER],
  ['AdminFeaturesPage.jsx', SETTINGS],
  ['AdminFeedbackPage.jsx', SETTINGS],
  ['AdminInstallationPage.jsx', OTHER],
  ['AdminIntegrationBuilderPage.jsx', OTHER],
  ['AdminLocalizationPage.jsx', SETTINGS],
  ['AdminLoggingPage.jsx', CARDS],
  ['AdminMcpGatewayPage.jsx', SETTINGS],
  ['AdminNextcloudEmbedPage.jsx', SETTINGS],
  ['AdminOAuthServerPage.jsx', SETTINGS],
  ['AdminOfficeIntegrationPage.jsx', SETTINGS],
  ['AdminProjectEditPage.jsx', OTHER],
  ['AdminPromptsPage.jsx', `${OTHER}: global prompt variables`],
  ['AdminScheduledTasksPage.jsx', OTHER],
  ['AdminSecurityPage.jsx', CARDS],
  ['AdminTelemetryPage.jsx', SETTINGS],
  ['AdminVoiceInputPage.jsx', SETTINGS]
]);

const read = name => fs.readFileSync(path.join(PAGES_DIR, name), 'utf8');

function pageFiles() {
  return fs
    .readdirSync(PAGES_DIR)
    .filter(name => name.endsWith('.jsx'))
    .sort();
}

function pagesWithoutBar() {
  return pageFiles().filter(name => {
    const source = read(name);
    if (!SAVE_CONTROL.test(source)) return false;
    return !SAVE_BAR.test(source) && !SETTINGS_FRAME_WITH_BAR(source);
  });
}

describe('admin save bar coverage', () => {
  it('finds the admin pages', () => {
    expect(pageFiles().length).toBeGreaterThan(40);
  });

  it.each([
    'AdminGroupEditPage.jsx',
    'AdminUserEditPage.jsx',
    'AdminPromptEditPage.jsx',
    'AdminModelEditPage.jsx',
    'AdminAppEditPage.jsx',
    'AdminUICustomization.jsx',
    'AdminArtifactsPage.jsx'
  ])('%s shows the save bar', name => {
    const source = read(name);
    expect(SAVE_BAR.test(source) || SETTINGS_FRAME_WITH_BAR(source)).toBe(true);
  });

  it('recognizes a page with its own Save button', () => {
    expect(SAVE_CONTROL.test(read('AdminTelemetryPage.jsx'))).toBe(true);
    expect(SAVE_BAR.test(read('AdminTelemetryPage.jsx'))).toBe(false);
  });

  it('every admin page that saves shows the save bar (or is baselined)', () => {
    const missing = pagesWithoutBar().filter(name => !BASELINE.has(name));
    // Give the page `<AdminSaveBar>` (see AdminGroupEditPage): it appears only while there
    // are unsaved changes, with Save and Discard.
    expect(missing).toEqual([]);
  });

  it('the baseline only shrinks: every entry still lacks the bar', () => {
    const without = new Set(pagesWithoutBar());
    const converted = [...BASELINE.keys()].filter(name => !without.has(name));
    // A page listed here has the bar now: remove it from BASELINE.
    expect(converted).toEqual([]);
  });
});
