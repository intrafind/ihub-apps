// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Who the publish dialog says will see the app (plan section 3.4): the pure
 * function `audienceText` and the dialog that prints its result.
 *
 * One test per row of the table, each with the view of the server as
 * `GET /api/admin/content-access/apps/{id}` returns it for that situation,
 * in English and German. In particular: a content admin reads "Everyone who
 * signs in can use this app." when that is so, never reads "No group can use
 * this app yet", and nobody reads the name of a group that every signed-in
 * user carries ("Authenticated").
 */

import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';
import {
  AUDIENCE_KEYS,
  audienceText,
  effectiveGroupNames
} from '../../../client/src/features/admin/components/app-editor/audienceText.js';

const mockI18n = i18next.createInstance();
const mockT = (...args) => mockI18n.t(...args);
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: mockI18n })
}));

const PublishDialog =
  require('../../../client/src/features/admin/components/app-editor/PublishDialog').default;

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en }, de: { translation: de } },
    interpolation: { escapeValue: false },
    parseMissingKeyHandler: key => `MISSING:${key}`
  });
});

beforeEach(async () => {
  await mockI18n.changeLanguage('en');
});

/** A row of the view, as `describeContentAccess` builds it. */
const row = (id, name, { effective = false, implicit = false, wildcard = false } = {}) => ({
  id,
  name,
  description: '',
  granted: effective && !wildcard,
  wildcard,
  inheritedFrom: [],
  effective,
  ...(implicit ? { implicit: true } : {})
});

/** What a full admin gets: every group, the implicit ones marked. */
const fullAdminView = ({ allSignedIn = false, anonymous = false, groups = [] } = {}) => ({
  type: 'apps',
  id: 'chat',
  scope: 'all',
  groups: [
    row('admin', 'Admin'),
    ...groups,
    row('authenticated', 'Authenticated', {
      effective: allSignedIn,
      wildcard: allSignedIn,
      implicit: true
    }),
    row('anonymous', 'Anonymous', { effective: anonymous, wildcard: anonymous, implicit: true })
  ],
  audience: { allSignedIn, anonymous }
});

/** What a content admin gets: the groups they manage, never an implicit one. */
const contentAdminView = ({ allSignedIn = false, anonymous = false, groups = [] } = {}) => ({
  type: 'apps',
  id: 'chat',
  scope: 'membership',
  groups,
  audience: { allSignedIn, anonymous }
});

const SALES = row('sales', 'Sales', { effective: true });
const USERS = row('users', 'Users', { effective: true });
const SUPPORT = row('support', 'Support');

/** The table of section 3.4, in its order of precedence. */
const ROWS = [
  {
    situation: 'anonymous access grants the app (full admin)',
    view: fullAdminView({ allSignedIn: true, anonymous: true, groups: [SALES] }),
    kind: 'everyone',
    en: 'Everyone can use this app, including people who are not signed in.',
    de: 'Alle können diese App nutzen, auch Personen, die nicht angemeldet sind.'
  },
  {
    situation: 'anonymous access grants the app (content admin)',
    view: contentAdminView({ allSignedIn: true, anonymous: true }),
    kind: 'everyone',
    en: 'Everyone can use this app, including people who are not signed in.',
    de: 'Alle können diese App nutzen, auch Personen, die nicht angemeldet sind.'
  },
  {
    situation: 'every signed-in user gets the app (full admin)',
    view: fullAdminView({ allSignedIn: true, groups: [SALES] }),
    kind: 'everyoneSignedIn',
    en: 'Everyone who signs in can use this app.',
    de: 'Alle, die sich anmelden, können diese App nutzen.'
  },
  {
    situation: 'every signed-in user gets the app (content admin without a group row)',
    view: contentAdminView({ allSignedIn: true }),
    kind: 'everyoneSignedIn',
    en: 'Everyone who signs in can use this app.',
    de: 'Alle, die sich anmelden, können diese App nutzen.'
  },
  {
    situation: 'a full admin, groups have access',
    view: fullAdminView({ groups: [USERS, SUPPORT, SALES] }),
    kind: 'groups',
    en: 'Members of these groups can use it: Users, Sales.',
    de: 'Mitglieder dieser Gruppen können sie nutzen: Users, Sales.'
  },
  {
    situation: 'a full admin, no group has access',
    view: fullAdminView({ groups: [SUPPORT] }),
    kind: 'noGroups',
    en: 'No group can use this app yet. Choose groups under "Who can use this app".',
    de: 'Noch darf keine Gruppe diese App nutzen. Wählen Sie Gruppen unter „Wer die App nutzen darf“.'
  },
  {
    situation: 'a content admin, groups they manage have access',
    view: contentAdminView({ groups: [SALES, SUPPORT] }),
    kind: 'groups',
    en: 'Members of these groups can use it: Sales. You see only the groups you manage. Other people may also be able to use it; ask an administrator.',
    de: 'Mitglieder dieser Gruppen können sie nutzen: Sales. Sie sehen nur die Gruppen, die Sie verwalten. Möglicherweise können weitere Personen sie nutzen; fragen Sie einen Administrator.'
  },
  {
    situation: 'a content admin, none of the groups they manage has access',
    view: contentAdminView({ groups: [SUPPORT] }),
    kind: 'noOwnGroups',
    en: 'None of the groups you manage can use this app yet. Other people may be able to use it; ask an administrator.',
    de: 'Keine der Gruppen, die Sie verwalten, darf diese App bisher nutzen. Möglicherweise können andere Personen sie nutzen; fragen Sie einen Administrator.'
  }
];

function renderDialog(view, props = {}) {
  render(
    <PublishDialog
      isOpen
      name="Plain-language summary"
      access={{ loading: false, failed: false, view }}
      onConfirm={() => {}}
      onCancel={() => {}}
      {...props}
    />
  );
  return screen.getByRole('alertdialog');
}

const sentenceOf = view => {
  const text = audienceText(view);
  return [mockT(text.key, text.values), text.noteKey && mockT(text.noteKey)]
    .filter(Boolean)
    .join(' ');
};

describe('audienceText: the table of the publish dialog', () => {
  test.each(ROWS)('$situation', ({ view, kind, en: english, de: german }) => {
    const text = audienceText(view);

    expect(text.kind).toBe(kind);
    expect(text.key).toBe(AUDIENCE_KEYS[kind]);
    expect(sentenceOf(view)).toBe(english);
    return mockI18n.changeLanguage('de').then(() => expect(sentenceOf(view)).toBe(german));
  });

  test('anonymous access comes before everything else, signed-in before the groups', () => {
    const groups = [SALES];

    expect(audienceText(fullAdminView({ anonymous: true, allSignedIn: true, groups })).kind).toBe(
      'everyone'
    );
    expect(audienceText(fullAdminView({ allSignedIn: true, groups })).kind).toBe(
      'everyoneSignedIn'
    );
    expect(audienceText(fullAdminView({ groups })).kind).toBe('groups');
  });

  test('a content admin never reads "No group can use this app yet"', () => {
    const views = [
      contentAdminView(),
      contentAdminView({ groups: [SUPPORT] }),
      contentAdminView({ groups: [SALES] }),
      contentAdminView({ allSignedIn: true }),
      contentAdminView({ anonymous: true, allSignedIn: true })
    ];

    for (const view of views) {
      expect(audienceText(view).kind).not.toBe('noGroups');
      expect(sentenceOf(view)).not.toMatch(/No group can use this app yet/);
    }
  });

  test('the name of a group that everybody carries is never printed', () => {
    // The implicit rows are effective here, yet they are not "these groups".
    const granted = fullAdminView({ groups: [SALES] });
    granted.groups = granted.groups.map(group =>
      group.implicit ? { ...group, effective: true } : group
    );
    granted.audience = { allSignedIn: false, anonymous: false };

    expect(effectiveGroupNames(granted)).toEqual(['Sales']);
    for (const view of [granted, ...ROWS.map(entry => entry.view)]) {
      expect(sentenceOf(view)).not.toMatch(/Authenticated|Anonymous/);
    }
  });

  test('a group without a name is named by its ID', () => {
    const view = fullAdminView({ groups: [{ ...SALES, name: '' }] });

    expect(audienceText(view).values).toEqual({ groups: 'sales' });
  });

  test('a view that does not say who can use the app gives no sentence', () => {
    expect(audienceText(null)).toBeNull();
    expect(audienceText(undefined)).toBeNull();
    expect(audienceText({})).toBeNull();
    // Without `audience` the rows alone would tell a content admin a wrong story.
    expect(audienceText({ scope: 'membership', groups: [] })).toBeNull();
    expect(audienceText({ scope: 'all', groups: [SALES] })).toBeNull();
    expect(
      audienceText({ scope: 'other', groups: [], audience: { allSignedIn: false } })
    ).toBeNull();
  });

  test('every key is a text in English and German', () => {
    const textOf = (bundle, key) => key.split('.').reduce((node, part) => node?.[part], bundle);

    for (const key of Object.values(AUDIENCE_KEYS)) {
      expect(typeof textOf(en, key)).toBe('string');
      expect(typeof textOf(de, key)).toBe('string');
    }
  });
});

describe('the publish dialog', () => {
  test.each(ROWS)('says it for: $situation', ({ view, kind, en: english }) => {
    const dialog = renderDialog(view);

    expect(dialog).toHaveTextContent('Publish "Plain-language summary"?');
    expect(dialog).toHaveTextContent('Who will see it');
    const audience = screen.getByTestId('publish-audience');
    expect(audience).toHaveAttribute('data-audience', kind);
    expect(audience).toHaveTextContent(english);
    expect(dialog).not.toHaveTextContent(/Authenticated|Anonymous/);
    expect(dialog).not.toHaveTextContent('MISSING:');
  });

  test.each(ROWS)('says it in German for: $situation', async ({ view, de: german }) => {
    await mockI18n.changeLanguage('de');

    const dialog = renderDialog(view);

    expect(dialog).toHaveTextContent('„Plain-language summary“ veröffentlichen?');
    expect(dialog).toHaveTextContent('Wer die App sehen wird');
    expect(screen.getByTestId('publish-audience')).toHaveTextContent(german);
    expect(dialog).not.toHaveTextContent('MISSING:');
  });

  test('a content admin with access for everyone reads that, not their group list', () => {
    const dialog = renderDialog(contentAdminView({ allSignedIn: true, groups: [SUPPORT] }));

    expect(dialog).toHaveTextContent('Everyone who signs in can use this app.');
    expect(dialog).not.toHaveTextContent(/None of the groups|No group can use/);
  });

  test('adds the two notes only when they are true', () => {
    const view = fullAdminView({ allSignedIn: true });
    const { publish } = en.admin.apps.edit;

    const plain = renderDialog(view);
    expect(plain).not.toHaveTextContent(publish.savesFirst);
    expect(plain).not.toHaveTextContent(publish.noModel);
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  test('says that unsaved changes are saved first and that no model is available', () => {
    const { publish } = en.admin.apps.edit;

    renderDialog(fullAdminView({ allSignedIn: true }), { savesFirst: true, noModel: true });

    const notes = screen.getAllByRole('listitem').map(item => item.textContent);
    expect(notes).toEqual([publish.savesFirst, publish.noModel]);
  });

  test('while the view is loading or could not be loaded, it says that and no audience', () => {
    const { unmount } = render(
      <PublishDialog
        isOpen
        name="Chat"
        access={{ loading: true, failed: false, view: null }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByTestId('publish-audience')).toHaveTextContent(
      en.admin.contentAccess.loading
    );
    unmount();

    renderDialog(null, { access: { loading: false, failed: true, view: null } });
    const audience = screen.getByTestId('publish-audience');
    expect(audience).toHaveTextContent(en.admin.contentAccess.loadError);
    expect(audience).not.toHaveAttribute('data-audience');
    // Publishing stays possible; the author was told what the page does not know.
    expect(screen.getByRole('button', { name: en.admin.apps.edit.publish.action })).toBeEnabled();
  });

  test('renders nothing while closed', () => {
    render(
      <PublishDialog
        isOpen={false}
        name="Chat"
        access={{ loading: false, failed: false, view: fullAdminView() }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
