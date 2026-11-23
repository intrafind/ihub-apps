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
  /AdminSaveBar|EditorSaveBar|AdminSettingsPage|type="submit"|onSubmit=\{|onSave=\{|onClick=\{[^}]*[sS]ave[A-Za-z]*/;

/**
 * The shared bar, directly, as the one `SaveSectionsBar` of a page whose sections save on their
 * own, or through the settings frame that renders it for `onSave`.
 */
const SAVE_BAR = /<(?:AdminSaveBar|EditorSaveBar|SaveSectionsBar)\b/;
const SETTINGS_FRAME_WITH_BAR = source =>
  source.includes('<AdminSettingsPage') && /onSave=\{/.test(source);

/** Pages with a save control and no bar yet. Shrink-only. */
const BASELINE = new Map();

/**
 * Pages that match the save patterns without saving anything of their own: a dialog's
 * `onSave` only refreshes the list behind it.
 */
const NOT_EDIT_PAGES = new Map([
  ['AdminMarketplaceRegistriesPage.jsx', 'the Save belongs to a dialog; the page edits nothing'],
  [
    'AdminCredentialsPage.jsx',
    'a credential is edited in a modal dialog with its own Save; the page holds no draft'
  ]
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
    if (NOT_EDIT_PAGES.has(name) || !SAVE_CONTROL.test(source)) return false;
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
    'AdminArtifactsPage.jsx',
    'AdminSecurityPage.jsx'
  ])('%s shows the save bar', name => {
    const source = read(name);
    expect(SAVE_BAR.test(source) || SETTINGS_FRAME_WITH_BAR(source)).toBe(true);
  });

  it('a form around the save bar keeps Enter-to-save through ImplicitSubmit', () => {
    // The bar's Save sits outside the form, so a form without a submit button of its own
    // would stop saving on Enter. Group, prompt, model, user, page, provider, short link
    // and OAuth client are the pages this protects.
    const withoutIt = pageFiles().filter(name => {
      const source = read(name);
      const hasBar = SAVE_BAR.test(source);
      const hasForm = /<form\b/.test(source) && /onSubmit=\{/.test(source);
      return hasBar && hasForm && !/<ImplicitSubmit\b/.test(source);
    });
    expect(withoutIt).toEqual([]);
  });

  it('a page with the bar and a DualModeEditor gives it the saved value, so Reset follows Discard', () => {
    // Without `savedValue` the editor's Reset goes back to the value it was last switched
    // modes with, which after a Discard can be the very edit the admin threw away.
    const without = pageFiles().filter(name => {
      const source = read(name);
      return (
        SAVE_BAR.test(source) && /<DualModeEditor\b/.test(source) && !/savedValue=\{/.test(source)
      );
    });
    expect(without).toEqual([]);
  });

  it('recognizes a page with its own Save button', () => {
    expect(SAVE_CONTROL.test(read('AdminCredentialsPage.jsx'))).toBe(true);
    expect(SAVE_BAR.test(read('AdminCredentialsPage.jsx'))).toBe(false);
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
