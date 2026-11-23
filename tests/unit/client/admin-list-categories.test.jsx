// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The category helpers of the admin Apps and Prompts lists: the same fallback
 * the end-user lists use, and no second "All" chip.
 */
import {
  APP_FALLBACK_CATEGORY,
  PROMPT_FALLBACK_CATEGORY,
  categoryChips,
  categoryDisplay,
  effectiveCategory
} from '../../../client/src/features/admin/utils/listCategories';

const categories = [
  { id: 'all', name: { en: 'All' } },
  { id: 'utility', name: { en: 'Utility' } },
  { id: 'creative', name: { en: 'Creative' } }
];
const localize = name => name?.en;

describe('effectiveCategory', () => {
  it('uses the item category, or the end-user list fallback', () => {
    expect(effectiveCategory({ category: 'creative' }, APP_FALLBACK_CATEGORY)).toBe('creative');
    expect(effectiveCategory({}, APP_FALLBACK_CATEGORY)).toBe('utility');
    expect(effectiveCategory({ category: '' }, PROMPT_FALLBACK_CATEGORY)).toBe('creative');
  });
});

describe('categoryChips', () => {
  it('leaves out the "all" entry of ui.json', () => {
    expect(categoryChips(categories).map(c => c.id)).toEqual(['utility', 'creative']);
  });

  it('tolerates a missing list', () => {
    expect(categoryChips(undefined)).toEqual([]);
  });
});

describe('categoryDisplay', () => {
  it('names the fallback category and marks it as one', () => {
    expect(categoryDisplay({}, categories, APP_FALLBACK_CATEGORY, localize)).toEqual({
      id: 'utility',
      label: 'Utility',
      isFallback: true
    });
  });

  it('names an own category, and shows an unknown one by its ID', () => {
    expect(
      categoryDisplay({ category: 'creative' }, categories, APP_FALLBACK_CATEGORY, localize)
    ).toEqual({ id: 'creative', label: 'Creative', isFallback: false });
    expect(
      categoryDisplay({ category: 'legal' }, categories, APP_FALLBACK_CATEGORY, localize).label
    ).toBe('legal');
  });
});
