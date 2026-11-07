// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Models and providers share one sidebar entry. It opens the models page, or the
 * providers page when only that one is allowed, and is hidden when neither is.
 */
import { getAdminNavSections } from '../../../client/src/features/admin/components/AdminSidebarNavData';

const t = (key, fallback) => (typeof fallback === 'string' ? fallback : key);

const entryFor = pages => {
  const sections = getAdminNavSections({
    t,
    showAdminPage: key => pages[key] !== false,
    featureFlags: { isEnabled: (_name, fallback) => fallback }
  });
  const items = sections.flatMap(section => section.items || []);
  return {
    models: items.find(item => item.key === 'models'),
    providers: items.find(item => item.key === 'providers')
  };
};

test('there is one entry for both pages and no separate Providers entry', () => {
  const { models, providers } = entryFor({});
  expect(providers).toBeUndefined();
  expect(models).toMatchObject({ href: '/admin/models', visible: true });
  expect(models.activeFor).toContain('/admin/providers');
});

test('with the models page hidden the entry opens the providers page', () => {
  const { models } = entryFor({ models: false });
  expect(models).toMatchObject({ href: '/admin/providers', visible: true });
});

test('with the providers page hidden it still opens the models page', () => {
  expect(entryFor({ providers: false }).models).toMatchObject({
    href: '/admin/models',
    visible: true
  });
});

test('with both hidden there is no entry', () => {
  expect(entryFor({ models: false, providers: false }).models).toBeUndefined();
});
