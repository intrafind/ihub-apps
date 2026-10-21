// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Business rules of the admin projects pages (#1036): link normalization,
 * the project form, the "Add item" dialog requests and tabs, list filtering
 * and the dependency list of a refused delete.
 */
import {
  buildProjectPayload,
  dependenciesFromDeleteError,
  filterProjects,
  normalizeProjectLinks,
  parseTags,
  projectFormFromProject,
  setProjectLinkMode,
  toggleProjectLink,
  uploadsAreUnscanned,
  validateProjectForm,
  validateProjectId
} from '../../../client/src/features/admin/utils/projectAdmin';
import {
  buildItemDialogTabs,
  buildItemRequest,
  hasActiveItems,
  summarizeItemKinds,
  validateUpload
} from '../../../client/src/features/projects/utils/projectItems';

describe('project links', () => {
  test('bare string ids become auto links without write access', () => {
    expect(normalizeProjectLinks(['handbook', { id: 'faq', mode: 'tools', write: true }])).toEqual([
      { id: 'handbook', mode: 'auto', write: false },
      { id: 'faq', mode: 'tools', write: true }
    ]);
  });

  test('drops empty and duplicate links and repairs unknown modes', () => {
    expect(
      normalizeProjectLinks(['', null, { id: 'a', mode: 'everything' }, 'a', { mode: 'context' }])
    ).toEqual([{ id: 'a', mode: 'auto', write: false }]);
    expect(normalizeProjectLinks(undefined)).toEqual([]);
  });

  test('toggling adds an auto link and removes an existing one', () => {
    const added = toggleProjectLink(['a'], 'b');
    expect(added).toEqual([
      { id: 'a', mode: 'auto', write: false },
      { id: 'b', mode: 'auto', write: false }
    ]);
    expect(toggleProjectLink(added, 'a')).toEqual([{ id: 'b', mode: 'auto', write: false }]);
  });

  test('changing the mode keeps the other links and the write flag', () => {
    expect(setProjectLinkMode([{ id: 'a', write: true }, 'b'], 'a', 'context')).toEqual([
      { id: 'a', mode: 'context', write: true },
      { id: 'b', mode: 'auto', write: false }
    ]);
  });
});

describe('project form', () => {
  test('validates the id only when creating', () => {
    expect(validateProjectId('')).toBe('required');
    expect(validateProjectId('has space')).toBe('invalid');
    expect(validateProjectId('prj_mine')).toBe('reserved');
    expect(validateProjectId('x'.repeat(51))).toBe('tooLong');
    expect(validateProjectId('employee-handbook.v2')).toBeNull();

    const form = { id: '', name: { en: '  ' } };
    expect(validateProjectForm(form, { isNew: true })).toEqual({
      id: 'required',
      name: 'required'
    });
    expect(validateProjectForm(form, { isNew: false })).toEqual({ name: 'required' });
  });

  test('builds a body without empty languages, description or category', () => {
    expect(
      buildProjectPayload({
        id: ' handbook ',
        name: { en: 'Handbook', de: '' },
        description: { en: ' ' },
        instructions: 'Answer in German.',
        enabled: false,
        category: '',
        tags: ['hr']
      })
    ).toEqual({
      id: 'handbook',
      name: { en: 'Handbook' },
      instructions: 'Answer in German.',
      enabled: false,
      tags: ['hr']
    });
  });

  test('reads a project with a plain-string description into the form', () => {
    expect(
      projectFormFromProject({ id: 'a', name: { en: 'A' }, description: '', tags: ['x'] })
    ).toEqual({
      id: 'a',
      name: { en: 'A' },
      description: { en: '' },
      instructions: '',
      enabled: true,
      category: '',
      tags: ['x']
    });
  });

  test('parses comma-separated tags without duplicates', () => {
    expect(parseTags(' hr, policies ,, hr')).toEqual(['hr', 'policies']);
  });
});

describe('items', () => {
  test('knows when an item is still being extracted', () => {
    expect(hasActiveItems([{ status: 'ready' }, { status: 'pending' }])).toBe(true);
    expect(hasActiveItems([{ status: 'extracting' }])).toBe(true);
    expect(hasActiveItems([{ status: 'ready' }, { status: 'failed' }])).toBe(false);
  });

  test('summarizes the kinds, most frequent first', () => {
    expect(summarizeItemKinds([{ kind: 'url' }, { kind: 'upload' }, { kind: 'upload' }])).toEqual([
      { kind: 'upload', count: 2 },
      { kind: 'url', count: 1 }
    ]);
  });

  test('builds the JSON body of every non-upload tab', () => {
    expect(buildItemRequest('text', { name: 'Note', text: 'Hello' })).toEqual({
      body: { kind: 'upload', ref: {}, name: 'Note', pinned: false, text: 'Hello' },
      error: null
    });
    expect(buildItemRequest('url', { url: 'https://example.com/a', pinned: true }).body).toEqual({
      kind: 'url',
      ref: { url: 'https://example.com/a' },
      pinned: true
    });
    expect(buildItemRequest('page', { pageId: 'faq', language: 'de' }).body.ref).toEqual({
      pageId: 'faq',
      language: 'de'
    });
    expect(buildItemRequest('ifinder-document', { documentId: 'doc-1' }).body).toEqual({
      kind: 'ifinder-document',
      ref: { documentId: 'doc-1' },
      pinned: false
    });
    expect(buildItemRequest('ifinder-query', { query: 'manual' }).body.ref).toEqual({
      query: 'manual'
    });
  });

  test('reports what is missing instead of building a body', () => {
    expect(buildItemRequest('text', { text: '  ' }).error).toBe('textRequired');
    expect(buildItemRequest('url', { url: 'ftp://example.com' }).error).toBe('urlInvalid');
    expect(buildItemRequest('page', {}).error).toBe('pageRequired');
    expect(buildItemRequest('ifinder-document', {}).error).toBe('documentRequired');
    expect(buildItemRequest('ifinder-query', {}).error).toBe('queryRequired');
    expect(buildItemRequest('office365', {}).error).toBe('unsupported');
  });

  test('checks the upload size against the configured limit', () => {
    expect(validateUpload(null, null)).toBe('fileRequired');
    expect(validateUpload({ size: 20 }, { limits: { maxFileBytes: 10 } })).toBe('fileTooLarge');
    expect(validateUpload({ size: 5 }, { limits: { maxFileBytes: 10 } })).toBeNull();
  });

  test('offers enabled kinds and shows cloud kinds as coming later', () => {
    const tabs = buildItemDialogTabs(
      [
        { id: 'upload', enabled: true },
        { id: 'url', enabled: true },
        { id: 'page', enabled: false },
        { id: 'office365', enabled: true }
      ],
      { upload: { available: false } }
    );
    const byId = Object.fromEntries(tabs.map(tab => [tab.id, tab]));
    expect(byId.upload).toMatchObject({ enabled: false, reason: 'storageUnavailable' });
    expect(byId.text).toMatchObject({
      enabled: false,
      kind: 'upload',
      reason: 'storageUnavailable'
    });
    expect(byId.url).toMatchObject({ enabled: true });
    expect(byId.page).toMatchObject({ enabled: false, reason: 'disabled' });
    expect(byId.office365).toMatchObject({ enabled: false, reason: 'later' });
    expect(byId.nextcloud).toMatchObject({ enabled: false, reason: 'later' });
  });

  test('warns only when uploads are possible but not scanned', () => {
    expect(uploadsAreUnscanned({ upload: { available: true }, scan: { provider: 'none' } })).toBe(
      true
    );
    expect(uploadsAreUnscanned({ upload: { available: true }, scan: { provider: 'clamav' } })).toBe(
      false
    );
    expect(uploadsAreUnscanned({ upload: { available: false }, scan: { provider: 'none' } })).toBe(
      false
    );
  });
});

describe('list and delete', () => {
  const projects = [
    {
      id: 'hr',
      name: { en: 'HR handbook', de: 'Personalhandbuch' },
      enabled: true,
      tags: ['policy'],
      items: [{ kind: 'upload' }]
    },
    { id: 'web', name: { en: 'Website' }, enabled: false, items: [{ kind: 'url' }] }
  ];

  test('filters by text in any language, tag, status and kind', () => {
    const ids = filters => filterProjects(projects, { language: 'en', ...filters }).map(p => p.id);
    expect(ids({ search: 'personal' })).toEqual(['hr']);
    expect(ids({ search: 'policy' })).toEqual(['hr']);
    expect(ids({ status: 'disabled' })).toEqual(['web']);
    expect(ids({ kind: 'upload' })).toEqual(['hr']);
    expect(ids({})).toEqual(['hr', 'web']);
  });

  test('reads the dependencies of a refused delete', () => {
    const dependencies = [{ type: 'app', id: 'chat', name: 'Chat' }];
    expect(
      dependenciesFromDeleteError({
        response: { data: { details: { code: 'PROJECT_IN_USE', dependencies } } }
      })
    ).toEqual(dependencies);
    expect(dependenciesFromDeleteError(new Error('boom'))).toBeNull();
  });
});
