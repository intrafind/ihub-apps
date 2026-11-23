// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The words of the access views: why a group gets an item (by name or through
 * a wildcard, own or inherited) and the reasons of an access check. Checked
 * against the English messages, so a key that is missing fails here.
 */

import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';
import {
  MODEL_CAUSE_KEYS,
  NO_MODELS_KEY,
  REASON_KEYS,
  ROUTE_KEYS,
  ITEM_KEYS,
  coveredByWildcard,
  formatSentence,
  groupNamer,
  primaryRoute,
  reasonSentence,
  routeSentence,
  wildcardSentences
} from '../../../client/src/features/admin/components/access/accessExplanation';

const lookup = (messages, key) => key.split('.').reduce((node, part) => node?.[part], messages);
const t = (key, values = {}) =>
  String(lookup(en, key) ?? key).replace(/{{(\w+)}}/g, (_, name) => values[name] ?? `{{${name}}}`);

// The shipped shape: users → authenticated (both `*`), hr inherits users.
const VIEW = {
  groups: [
    {
      id: 'users',
      name: 'Users',
      effective: true,
      via: [
        { groupId: 'users', kind: 'wildcard', path: ['users'] },
        { groupId: 'authenticated', kind: 'wildcard', path: ['users', 'authenticated'] }
      ]
    },
    {
      id: 'hr',
      name: 'HR',
      effective: true,
      via: [
        { groupId: 'hr', kind: 'explicit', path: ['hr'] },
        { groupId: 'users', kind: 'wildcard', path: ['hr', 'users'] }
      ]
    },
    {
      id: 'authenticated',
      name: 'Authenticated',
      effective: true,
      implicit: true,
      via: [{ groupId: 'authenticated', kind: 'wildcard', path: ['authenticated'] }]
    },
    { id: 'kiosk', name: 'Kiosk', effective: false, via: [] }
  ]
};

describe('message keys', () => {
  it.each([
    ...Object.values(ITEM_KEYS),
    ...Object.values(ROUTE_KEYS),
    ...Object.values(REASON_KEYS),
    ...Object.values(MODEL_CAUSE_KEYS),
    NO_MODELS_KEY
  ])('%s exists in English and German', key => {
    expect(typeof lookup(en, key)).toBe('string');
    expect(typeof lookup(de, key)).toBe('string');
  });
});

describe('wildcardSentences', () => {
  it('says which groups get the item through "all", with the inheritance chain', () => {
    const lines = wildcardSentences(VIEW, 'apps').map(sentence => formatSentence(sentence, t));
    expect(lines).toEqual([
      'Everyone in Users sees this through “all apps”.',
      'Everyone in HR sees this through “all apps” (inherited from Users: HR → Users).',
      'Everyone in Authenticated sees this through “all apps”.'
    ]);
  });

  it('says nothing for a view without wildcard routes', () => {
    expect(wildcardSentences({ groups: [VIEW.groups[3]] }, 'apps')).toEqual([]);
    expect(wildcardSentences(null, 'apps')).toEqual([]);
    expect(coveredByWildcard({ groups: [VIEW.groups[3]] })).toBe(false);
    expect(coveredByWildcard(VIEW)).toBe(true);
  });
});

describe('routeSentence', () => {
  const nameOf = groupNamer(VIEW.groups);

  it('words an inherited wildcard the way the review asked for', () => {
    const sentence = routeSentence({
      groupName: 'Users',
      route: VIEW.groups[0].via[1],
      type: 'models',
      nameOf
    });
    expect(formatSentence(sentence, t)).toBe(
      'Everyone in Users sees this through “all models” (inherited from Authenticated: Users → Authenticated).'
    );
  });

  it('words an own explicit grant, and takes the first route as primary', () => {
    const route = primaryRoute(VIEW.groups[1]);
    expect(route.kind).toBe('explicit');
    expect(formatSentence(routeSentence({ groupName: 'HR', route, type: 'apps', nameOf }), t)).toBe(
      'HR is granted this by name.'
    );
  });
});

describe('reasonSentence', () => {
  const nameOf = groupNamer(VIEW.groups);

  it('lists the routes of a grant below it', () => {
    const sentence = reasonSentence(
      {
        code: 'granted',
        status: 'ok',
        routes: [
          { groupId: 'authenticated', kind: 'wildcard', path: ['hr', 'users', 'authenticated'] }
        ]
      },
      { type: 'apps', nameOf }
    );
    expect(formatSentence(sentence, t)).toBe('A group grants it:');
    expect(sentence.details.map(detail => formatSentence(detail, t))).toEqual([
      'Everyone in HR sees this through “all apps” (inherited from Authenticated: HR → Users → Authenticated).'
    ]);
  });

  it('names why each model drops out of a chat app', () => {
    const sentence = reasonSentence(
      {
        code: 'noUsableModel',
        status: 'blocked',
        models: [
          { id: 'claude', cause: 'disabled' },
          { id: 'gpt', cause: 'notGranted' }
        ]
      },
      { type: 'apps', nameOf }
    );
    expect(sentence.details.map(detail => formatSentence(detail, t))).toEqual([
      'claude is disabled.',
      'gpt is not granted to their groups.'
    ]);
  });

  it('words a feature that is off and ignores an unknown code', () => {
    const sentence = reasonSentence(
      { code: 'featureOff', status: 'blocked', featureId: 'experimentalX' },
      { type: 'apps', nameOf }
    );
    expect(formatSentence(sentence, t)).toBe(
      'The required feature “experimentalX” is off (Features).'
    );
    expect(reasonSentence({ code: 'somethingNew' }, { type: 'apps', nameOf })).toBeNull();
  });
});
