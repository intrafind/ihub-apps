#!/usr/bin/env node

/**
 * Tests for the App Navigator sidebar's grouping/filtering helpers (#1026).
 *
 * Run directly: `node client/src/shared/utils/appNavigatorGroups.test.js`.
 */

import {
  filterAppsForNavigator,
  groupAppsByCategory,
  OTHER_CATEGORY_ID
} from './appNavigatorGroups.js';

let failures = 0;
function check(label, cond, details) {
  if (!cond) failures += 1;
  console.log(`${cond ? '✅' : '❌'} ${label}`);
  if (!cond && details) console.log(`   ${details}`);
}

const apps = [
  {
    id: 'writer',
    name: { en: 'Story Writer' },
    description: { en: 'Creative writing helper' },
    category: 'writing'
  },
  {
    id: 'coder',
    name: { en: 'Code Helper' },
    description: { en: 'Assists with code' },
    category: 'coding'
  },
  {
    id: 'mystery',
    name: { en: 'Mystery App' },
    description: { en: 'No known category' },
    category: 'unknown-category'
  },
  { id: 'plain', name: { en: 'Plain App' }, description: { en: 'Has no category at all' } }
];

const categoryMeta = [
  { id: 'all', name: { en: 'All' }, color: '#000' },
  { id: 'coding', name: { en: 'Coding' }, color: '#10B981' },
  { id: 'writing', name: { en: 'Creative Writing' }, color: '#F59E0B' }
];

console.log('🧪 filterAppsForNavigator\n');

check(
  'empty search term returns all apps unchanged',
  filterAppsForNavigator(apps, '', 'en').length === apps.length
);

check(
  'matches by name (case-insensitive)',
  filterAppsForNavigator(apps, 'STORY', 'en')
    .map(a => a.id)
    .join(',') === 'writer'
);

check(
  'matches by description',
  filterAppsForNavigator(apps, 'assists', 'en')
    .map(a => a.id)
    .join(',') === 'coder'
);

check('no match returns empty array', filterAppsForNavigator(apps, 'zzz-nope', 'en').length === 0);

console.log('\n🧪 groupAppsByCategory\n');

const groupsNoOrder = groupAppsByCategory({ apps, categoryOrder: [], categoryMeta });

check(
  '"all" pseudo-category is never used as a real bucket',
  !groupsNoOrder.some(g => g.id === 'all')
);

check(
  'falls back to categoryMeta order when no explicit categoryOrder is given',
  groupsNoOrder
    .map(g => g.id)
    .slice(0, 2)
    .join(',') === 'coding,writing'
);

check(
  'apps with an unrecognized category id are bucketed into "other"',
  groupsNoOrder
    .find(g => g.id === OTHER_CATEGORY_ID)
    ?.apps.map(a => a.id)
    .sort()
    .join(',') === 'mystery,plain'
);

check(
  '"other" bucket is always last',
  groupsNoOrder[groupsNoOrder.length - 1].id === OTHER_CATEGORY_ID
);

const groupsWithOrder = groupAppsByCategory({
  apps,
  categoryOrder: ['writing', 'coding'],
  categoryMeta
});

check(
  'explicit categoryOrder overrides categoryMeta order',
  groupsWithOrder
    .map(g => g.id)
    .slice(0, 2)
    .join(',') === 'writing,coding'
);

check(
  'group carries through category name/color from categoryMeta (no duplicated metadata)',
  groupsWithOrder[0].name.en === 'Creative Writing' && groupsWithOrder[0].color === '#F59E0B'
);

const groupsAllUnknown = groupAppsByCategory({
  apps: [{ id: 'solo', name: { en: 'Solo' }, category: 'nope' }],
  categoryOrder: [],
  categoryMeta
});

check(
  'a single unrecognized category still produces one "other" group, not an empty result',
  groupsAllUnknown.length === 1 && groupsAllUnknown[0].id === OTHER_CATEGORY_ID
);

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
