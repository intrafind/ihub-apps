// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  buildItemChanges,
  draftFromItem,
  isEditableItem
} from '../../../client/src/features/projects/utils/projectItems';

describe('editing a link item', () => {
  const url = { kind: 'url', name: 'Docs', ref: { url: 'https://a.example', maxContentLength: 9 } };

  test('only link kinds can be edited', () => {
    for (const kind of ['url', 'page', 'ifinder-document', 'ifinder-query']) {
      expect(isEditableItem({ kind })).toBe(true);
    }
    for (const kind of ['upload', 'office365', 'project-item', undefined]) {
      expect(isEditableItem({ kind })).toBe(false);
    }
    expect(isEditableItem(null)).toBe(false);
  });

  test('an untouched draft changes nothing', () => {
    expect(buildItemChanges(url, draftFromItem(url))).toEqual({ changes: null, error: null });
  });

  test('a new address is sent with the limits the dialog does not show', () => {
    const draft = { ...draftFromItem(url), url: ' https://b.example ' };
    expect(buildItemChanges(url, draft).changes).toEqual({
      ref: { url: 'https://b.example', maxContentLength: 9 }
    });
  });

  test('a new name is sent alone, a cleared name is ignored', () => {
    expect(buildItemChanges(url, { ...draftFromItem(url), name: 'Handbook' }).changes).toEqual({
      name: 'Handbook'
    });
    expect(buildItemChanges(url, { ...draftFromItem(url), name: '  ' }).changes).toBeNull();
  });

  test('an invalid address is refused with a code', () => {
    expect(buildItemChanges(url, { ...draftFromItem(url), url: 'ftp://x' }).error).toBe(
      'urlInvalid'
    );
  });

  test('an emptied search profile is dropped from an iFinder reference', () => {
    const query = {
      kind: 'ifinder-query',
      name: 'Q',
      ref: { query: 'policy', searchProfile: 'hr', maxResults: 5 }
    };
    expect(buildItemChanges(query, draftFromItem(query)).changes).toBeNull();
    expect(buildItemChanges(query, { ...draftFromItem(query), searchProfile: '' }).changes).toEqual(
      {
        ref: { query: 'policy', maxResults: 5 }
      }
    );
    expect(buildItemChanges(query, { ...draftFromItem(query), query: '' }).error).toBe(
      'queryRequired'
    );
  });

  test('a page keeps its language until another is picked', () => {
    const page = { kind: 'page', name: 'FAQ', ref: { pageId: 'faq', language: 'en' } };
    expect(buildItemChanges(page, draftFromItem(page)).changes).toBeNull();
    expect(buildItemChanges(page, { ...draftFromItem(page), language: 'de' }).changes).toEqual({
      ref: { pageId: 'faq', language: 'de' }
    });
  });
});
