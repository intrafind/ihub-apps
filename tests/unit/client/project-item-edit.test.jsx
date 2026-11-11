// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  buildItemChanges,
  draftFromItem,
  isEditableItem
} from '../../../client/src/features/projects/utils/projectItems';

describe('editing an item', () => {
  const url = { kind: 'url', name: 'Docs', ref: { url: 'https://a.example', maxContentLength: 9 } };

  test('only link kinds have a reference to edit', () => {
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

  test('the For the AI setting is sent when it changed', () => {
    const draft = draftFromItem(url);
    expect(draft.aiAccess).toBe('normal');
    expect(buildItemChanges(url, { ...draft, aiAccess: 'pinned' }).changes).toEqual({
      pinned: true,
      excludedFromAi: false
    });
    expect(buildItemChanges(url, { ...draft, aiAccess: 'excluded' }).changes).toEqual({
      pinned: false,
      excludedFromAi: true
    });
    const pinned = { ...url, pinned: true };
    expect(buildItemChanges(pinned, draftFromItem(pinned))).toEqual({ changes: null, error: null });
    expect(
      buildItemChanges(pinned, { ...draftFromItem(pinned), aiAccess: 'normal' }).changes
    ).toEqual({ pinned: false, excludedFromAi: false });
  });

  test('an upload is edited for its name and For the AI setting only', () => {
    const upload = { kind: 'upload', name: 'Notes', ref: { fileName: 'notes.txt' } };
    expect(buildItemChanges(upload, draftFromItem(upload))).toEqual({ changes: null, error: null });
    expect(
      buildItemChanges(upload, {
        ...draftFromItem(upload),
        name: 'Meeting notes',
        aiAccess: 'excluded'
      }).changes
    ).toEqual({ name: 'Meeting notes', pinned: false, excludedFromAi: true });
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

  test('a search that lets the model supply the query can still be renamed or moved to another profile', () => {
    const open = {
      kind: 'ifinder-query',
      name: 'iFinder search',
      ref: { query: '', maxResults: 5 }
    };
    expect(buildItemChanges(open, draftFromItem(open))).toEqual({ changes: null, error: null });
    expect(buildItemChanges(open, { ...draftFromItem(open), name: 'HR search' }).changes).toEqual({
      name: 'HR search'
    });
    expect(buildItemChanges(open, { ...draftFromItem(open), searchProfile: 'hr' }).changes).toEqual(
      {
        ref: { query: '', maxResults: 5, searchProfile: 'hr' }
      }
    );
    // Typing a query makes it a fixed search; one that had a query may not lose it.
    expect(buildItemChanges(open, { ...draftFromItem(open), query: 'policy' }).changes).toEqual({
      ref: { query: 'policy', maxResults: 5 }
    });
    const fixed = { kind: 'ifinder-query', name: 'Q', ref: { query: 'policy' } };
    expect(buildItemChanges(fixed, { ...draftFromItem(fixed), query: '' }).error).toBe(
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
