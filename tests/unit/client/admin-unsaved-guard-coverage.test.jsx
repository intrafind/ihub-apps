// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import fs from 'fs';
import path from 'path';

/**
 * Ratchet: every admin page that renders a save control guards against leaving
 * with unsaved changes, either by calling `useUnsavedChanges` itself or through
 * a frame that does (`AdminSettingsPage`, `AdminEditPageShell`,
 * `useAdminResourceEditor`).
 *
 * Pages that still miss the guard are listed in BASELINE. The list may only
 * shrink: a page that gains the guard must be taken off it, and no new page may
 * be added to it — give the page the guard instead.
 */

const PAGES_DIR = path.resolve(__dirname, '../../../client/src/features/admin/pages');

/** A Save button, a submit button, a form submit handler or a shared save frame. */
const SAVE_CONTROL =
  /AdminSaveBar|AdminEditPageShell|AdminSettingsPage|type="submit"|onSubmit=\{|onClick=\{[^}\n]*\b(?:handle)?[sS]ave[A-Za-z]*\b/;

/** The guard, directly or through a frame that calls it. */
const GUARD = /useUnsavedChanges|useAdminResourceEditor|AdminEditPageShell|AdminSettingsPage/;

/** Pages with a save control and no guard yet. Shrink-only. */
const BASELINE = new Map([
  // Not in the finding lists of the unsaved-guards PR; follow-ups.
  ['AdminAppsPage.jsx', 'app order draft (Save order)'],
  ['AdminPromptsPage.jsx', 'global prompt variables'],
  ['AdminOAuthCimdClientEditPage.jsx', 'CIMD client editor'],
  ['AdminOAuthServerPage.jsx', 'OAuth server settings']
]);

function pageFiles() {
  return fs
    .readdirSync(PAGES_DIR)
    .filter(name => name.endsWith('.jsx'))
    .sort();
}

function unguardedPages() {
  return pageFiles().filter(name => {
    const source = fs.readFileSync(path.join(PAGES_DIR, name), 'utf8');
    return SAVE_CONTROL.test(source) && !GUARD.test(source);
  });
}

describe('admin unsaved-changes guard coverage', () => {
  it('finds the admin pages', () => {
    expect(pageFiles().length).toBeGreaterThan(40);
  });

  it('recognizes a guarded page and a page with a save control', () => {
    const security = fs.readFileSync(path.join(PAGES_DIR, 'AdminSecurityPage.jsx'), 'utf8');
    expect(GUARD.test(security)).toBe(true);
    const logging = fs.readFileSync(path.join(PAGES_DIR, 'AdminLoggingPage.jsx'), 'utf8');
    expect(SAVE_CONTROL.test(logging)).toBe(true);
  });

  it('every admin page with a save control uses the unsaved-changes guard (or is baselined)', () => {
    const missing = unguardedPages().filter(name => !BASELINE.has(name));
    expect(missing).toEqual([]);
  });

  it('the baseline only shrinks: every entry still lacks the guard', () => {
    const unguarded = new Set(unguardedPages());
    const fixed = [...BASELINE.keys()].filter(name => !unguarded.has(name));
    // A page listed here has its guard now: remove it from BASELINE.
    expect(fixed).toEqual([]);
  });

  it.each([
    'AdminLoggingPage.jsx',
    'AdminTelemetryPage.jsx',
    'AdminChatHistoryPage.jsx',
    'AdminFeedbackPage.jsx',
    'AdminScheduledTasksPage.jsx',
    'AdminFeaturesPage.jsx',
    'AdminVoiceInputPage.jsx',
    'AdminSecurityPage.jsx',
    'AdminMcpGatewayPage.jsx',
    'AdminCredentialsPage.jsx',
    'AdminOfficeIntegrationPage.jsx',
    'AdminBrowserExtensionPage.jsx',
    'AdminCopilotAgentPage.jsx',
    'AdminNextcloudEmbedPage.jsx',
    'AdminInstallationPage.jsx',
    'AdminProviderCreatePage.jsx',
    'AdminLocalizationPage.jsx',
    'AdminDocumentTemplateEditPage.jsx',
    'WorkflowEditorPage.jsx'
  ])('%s is guarded', name => {
    const source = fs.readFileSync(path.join(PAGES_DIR, name), 'utf8');
    expect(GUARD.test(source)).toBe(true);
  });
});
