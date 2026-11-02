// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Every label of the admin sidebar exists in English and German. The client
 * falls back to the inline English default for a missing key without a word,
 * so a German admin would otherwise see an English sidebar and nothing would
 * report it. The keys are collected by building the navigation with a
 * recording `t`, so a section or item added later is covered too.
 */
import { getAdminNavSections } from '../../../client/src/features/admin/components/AdminSidebarNavData';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';

const lookup = (messages, key) => key.split('.').reduce((node, part) => node?.[part], messages);

/** Builds the sidebar with every page and feature visible and records each `t` call. */
function collectLabels() {
  const calls = new Map();
  const t = (key, fallback) => {
    calls.set(key, fallback);
    return typeof fallback === 'string' ? fallback : key;
  };
  getAdminNavSections({ t, showAdminPage: () => true, featureFlags: null });
  return calls;
}

const labels = collectLabels();

describe('admin sidebar labels', () => {
  it('collects the labels of every section and page', () => {
    expect(labels.size).toBeGreaterThanOrEqual(40);
    expect(
      [...labels.keys()].filter(key => key.startsWith('admin.sidebar.sections.'))
    ).toHaveLength(7);
  });

  it.each([...labels.entries()])('%s is translated into English and German', (key, fallback) => {
    const english = lookup(en, key);
    const german = lookup(de, key);
    expect(typeof english).toBe('string');
    expect(typeof german).toBe('string');
    expect(german.trim()).not.toBe('');
    // The English text is the inline default, so the English sidebar reads as before.
    expect(english).toBe(fallback);
  });
});
