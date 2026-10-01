/**
 * Catalog items keep their `licenseUrl`.
 *
 * The admin marketplace links an item's license name to this URL, but Zod
 * strips undeclared keys, so the field has to be part of the item schema to
 * survive catalog validation.
 */

import { validateCatalog } from '../validators/catalogSchema.js';

const catalog = {
  name: 'Test Registry',
  items: [
    {
      type: 'app',
      name: 'chat',
      license: 'BSD-3-Clause-with-Mandatory-Attribution',
      licenseUrl: 'https://github.com/intrafind/ihub-marketplace/blob/main/LICENSE',
      source: { type: 'relative', path: 'apps/chat.json' }
    }
  ]
};

describe('catalog item licenseUrl', () => {
  test('keeps licenseUrl next to license', () => {
    const result = validateCatalog(catalog);

    expect(result.success).toBe(true);
    expect(result.data.items[0].license).toBe(catalog.items[0].license);
    expect(result.data.items[0].licenseUrl).toBe(catalog.items[0].licenseUrl);
  });

  test('accepts an item without licenseUrl', () => {
    const withoutUrl = structuredClone(catalog);
    delete withoutUrl.items[0].licenseUrl;

    expect(validateCatalog(withoutUrl).success).toBe(true);
  });

  test('rejects a licenseUrl that is not a URL', () => {
    const invalid = structuredClone(catalog);
    invalid.items[0].licenseUrl = 'see LICENSE file';

    expect(validateCatalog(invalid).success).toBe(false);
  });
});
