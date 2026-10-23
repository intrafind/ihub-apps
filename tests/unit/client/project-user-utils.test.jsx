// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Pure rules of the user projects UI (#1036, slice 5): the shared item
 * helpers (cloud picks, dialog tabs, upload checks), the project page rules
 * (list filters, form, quotas, members, chats), the error messages of the
 * spec's codes, the provenance chip, and the text mode of the preview.
 */
import {
  buildCloudItemRequests,
  buildItemDialogTabs,
  cloudItemRef,
  cloudProvidersForKind,
  isItemReadable,
  validateUploads,
  visibleItemDialogTabs,
  linkSourceProjects,
  linkableItems
} from '../../../client/src/features/projects/utils/projectItems';
import {
  appsForProjectChats,
  buildCreateProjectBody,
  buildProjectChanges,
  chatPath,
  countProjectGroups,
  filterProjectList,
  membersToShares,
  membersWithout,
  ownMemberEntry,
  projectChatStartPath,
  projectCreation,
  projectFormFrom,
  projectListGroup,
  projectUsage,
  quotaState,
  reconcileProjectForm,
  resolveProjectChatApp,
  sharesToMembers,
  validateProjectForm
} from '../../../client/src/features/projects/utils/projectView';
import {
  itemErrorMessage,
  projectErrorDetails,
  projectErrorMessage
} from '../../../client/src/features/projects/utils/projectErrors';
import {
  formatSnapshotDate,
  provenanceView
} from '../../../client/src/features/projects/utils/projectProvenance';
import {
  downloadFormatFor,
  isOriginalDiscarded,
  previewFormatFor,
  splitByPassages
} from '../../../client/src/features/documentPreview/utils/textPreview';

const t = (key, defaultOrOptions, maybeOptions) => {
  const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions || {};
  const text = typeof defaultOrOptions === 'string' ? defaultOrOptions : key;
  return Object.entries(options).reduce(
    (out, [name, value]) => out.replaceAll(`{{${name}}}`, value),
    text
  );
};

/** An error as `handleApiResponse` throws it. */
const apiError = (status, data) =>
  Object.assign(new Error(data?.error || 'failed'), {
    status,
    originalError: { response: { status, data } }
  });

describe('project items — cloud picks', () => {
  test('builds the ref each cloud kind expects', () => {
    const file = {
      id: 'f1',
      name: 'Contract.pdf',
      mimeType: 'application/pdf',
      size: 1200,
      lastModifiedDateTime: '2026-10-12T08:00:00Z',
      webUrl: 'https://sp/contract'
    };
    expect(cloudItemRef('office365', 'sp', file, { id: 'd1' })).toEqual({
      providerId: 'sp',
      fileId: 'f1',
      driveId: 'd1',
      name: 'Contract.pdf',
      mimeType: 'application/pdf',
      size: 1200,
      lastModified: '2026-10-12T08:00:00Z',
      url: 'https://sp/contract'
    });
    expect(cloudItemRef('google-drive', 'gd', { id: 'g1', name: 'a.docx' })).toEqual({
      providerId: 'gd',
      fileId: 'g1',
      name: 'a.docx'
    });
    expect(cloudItemRef('nextcloud', 'nc', { id: 'x', path: '/Docs/a.md', name: 'a.md' })).toEqual({
      providerId: 'nc',
      path: '/Docs/a.md',
      name: 'a.md'
    });
    expect(cloudItemRef('office365', '', file)).toBeNull();
    expect(cloudItemRef('jira', 'x', file)).toBeNull();
  });

  test('turns a multi-file pick into one request per file', () => {
    const requests = buildCloudItemRequests(
      'google-drive',
      'gd',
      [{ id: 'a', name: 'A.pdf' }, { id: 'b', name: 'B.pdf' }, null],
      null,
      { pinned: true }
    );
    expect(requests).toEqual([
      {
        kind: 'google-drive',
        ref: { providerId: 'gd', fileId: 'a', name: 'A.pdf' },
        name: 'A.pdf',
        pinned: true
      },
      {
        kind: 'google-drive',
        ref: { providerId: 'gd', fileId: 'b', name: 'B.pdf' },
        name: 'B.pdf',
        pinned: true
      }
    ]);
  });

  test('finds the providers of a kind by its picker descriptor or the default type', () => {
    const providers = [
      { id: 'sp', type: 'office365' },
      { id: 'gd', type: 'googledrive' }
    ];
    expect(cloudProvidersForKind(providers, 'google-drive')).toEqual([
      { id: 'gd', type: 'googledrive' }
    ]);
    expect(
      cloudProvidersForKind(providers, {
        id: 'office365',
        picker: { type: 'cloud', provider: 'office365' }
      })
    ).toEqual([{ id: 'sp', type: 'office365' }]);
    expect(cloudProvidersForKind(null, 'nextcloud')).toEqual([]);
  });
});

describe('project items — dialog tabs and uploads', () => {
  const kinds = [{ id: 'upload' }, { id: 'url' }, { id: 'office365' }];

  test('offers the cloud kinds only where the dialog has a cloud picker', () => {
    const withCloud = buildItemDialogTabs(kinds, { upload: { available: true } }, { cloud: true });
    const byId = Object.fromEntries(withCloud.map(tab => [tab.id, tab]));
    expect(byId.office365).toMatchObject({ enabled: true, reason: null });
    expect(byId['google-drive']).toMatchObject({ enabled: false, reason: 'disabled' });
    const admin = buildItemDialogTabs(kinds, null);
    expect(admin.find(tab => tab.id === 'office365')).toMatchObject({
      enabled: false,
      reason: 'later'
    });
  });

  test('hides kinds the installation does not offer but keeps the storage notice', () => {
    const tabs = buildItemDialogTabs(kinds, { upload: { available: false } }, { cloud: true });
    expect(visibleItemDialogTabs(tabs).map(tab => tab.id)).toEqual([
      'upload',
      'text',
      'url',
      'office365'
    ]);
  });

  test('checks files against the per-file limit and the project quotas', () => {
    const config = { limits: { maxFileBytes: 100, maxFiles: 3, maxProjectBytes: 500 } };
    const small = { name: 'a', size: 50 };
    expect(validateUploads([], config, null)).toBe('fileRequired');
    expect(validateUploads([{ name: 'big', size: 101 }], config, null)).toBe('fileTooLarge');
    expect(validateUploads([small, small], config, { items: 2, bytes: 0 })).toBe('quotaFiles');
    expect(validateUploads([small], config, { items: 0, bytes: 480 })).toBe('quotaProjectBytes');
    expect(validateUploads([small], config, { items: 0, bytes: 0 })).toBeNull();
  });

  test('a stale item keeps its readable text', () => {
    expect(isItemReadable({ status: 'stale' })).toBe(true);
    expect(isItemReadable({ status: 'extracting' })).toBe(false);
  });
});

describe('project items — documents linked from other projects', () => {
  test('offers the link tab only where the dialog can pick projects', () => {
    const kinds = [{ id: 'url' }, { id: 'project-item' }];
    expect(buildItemDialogTabs(kinds, {}).some(tab => tab.kind === 'project-item')).toBe(false);
    expect(
      buildItemDialogTabs(kinds, {}, { projectLinks: true }).find(
        tab => tab.kind === 'project-item'
      )
    ).toMatchObject({ enabled: true });
  });

  test('lists every project the viewer uses but this one and compliance views', () => {
    const projects = [
      { id: 'faq', ownership: 'admin', role: 'linked', permissions: { canUse: true } },
      { id: 'prj_here', ownership: 'user', role: 'owner', permissions: { canUse: true } },
      { id: 'prj_shared', ownership: 'user', role: 'user', permissions: { canUse: true } },
      { id: 'prj_someone', ownership: 'user', role: 'admin', permissions: { canUse: true } }
    ];
    expect(linkSourceProjects(projects, 'prj_here').map(project => project.id)).toEqual([
      'prj_shared',
      'faq'
    ]);
  });

  test('marks documents the target has already, also through a link of a link', () => {
    const source = {
      id: 'prj_src',
      items: [
        { id: 'itm_a', kind: 'upload' },
        { id: 'itm_b', kind: 'upload' },
        { id: 'itm_c', kind: 'project-item', ref: { projectId: 'prj_here', itemId: 'itm_own' } }
      ]
    };
    const target = {
      id: 'prj_here',
      items: [
        { id: 'itm_own', kind: 'upload' },
        { id: 'itm_link', kind: 'project-item', ref: { projectId: 'prj_src', itemId: 'itm_a' } }
      ]
    };
    expect(linkableItems(source, target).map(({ item, linked }) => [item.id, linked])).toEqual([
      ['itm_a', true],
      ['itm_b', false],
      ['itm_c', true]
    ]);

    // A link of the source whose original the viewer cannot read is not offered.
    const withBroken = {
      ...source,
      items: [{ id: 'itm_d', kind: 'project-item', ref: {}, link: { state: 'forbidden' } }]
    };
    expect(linkableItems(withBroken, target)[0]).toMatchObject({ unavailable: true });
    expect(linkableItems(source, target)[0]).toMatchObject({ unavailable: false });
  });
});

describe('project page rules', () => {
  const mine = { id: 'prj_a', ownership: 'user', name: 'Case 114', permissions: { isOwner: true } };
  const shared = {
    id: 'prj_b',
    ownership: 'user',
    name: 'Team wiki',
    description: 'Shared notes',
    owner: { name: 'Dana' },
    permissions: { isOwner: false, canUse: true }
  };
  const admin = { id: 'faq', ownership: 'admin', name: { en: 'FAQ', de: 'FAQ' }, permissions: {} };

  test('groups and filters the list', () => {
    expect(projectListGroup(admin)).toBe('apps');
    expect(countProjectGroups([mine, shared, admin])).toEqual({
      all: 3,
      mine: 1,
      shared: 1,
      apps: 1
    });
    expect(filterProjectList([mine, shared, admin], { filter: 'shared' })).toEqual([shared]);
    expect(filterProjectList([mine, shared, admin], { search: 'dana' })).toEqual([shared]);
    expect(filterProjectList([mine, shared, admin], { search: 'faq' })).toEqual([admin]);
  });

  test('validates the form and sends only what changed', () => {
    expect(validateProjectForm({ name: ' ' })).toEqual({ name: 'required' });
    expect(validateProjectForm({ name: 'x'.repeat(201) })).toEqual({ name: 'tooLong' });
    expect(buildCreateProjectBody({ name: ' Case ', description: '', instructions: '  ' })).toEqual(
      {
        name: 'Case'
      }
    );
    const project = { name: 'Case', description: 'd', instructions: 'Be brief.' };
    expect(
      buildProjectChanges({ name: 'Case', description: 'd', instructions: 'Be brief.' }, project)
    ).toBeNull();
    expect(
      buildProjectChanges({ name: 'Case 2', description: 'd', instructions: 'Be brief.' }, project)
    ).toEqual({
      name: 'Case 2'
    });
  });

  test('sets, changes and clears the default app of a project', () => {
    expect(buildCreateProjectBody({ name: 'Case', defaultAppId: 'summarizer' })).toEqual({
      name: 'Case',
      defaultAppId: 'summarizer'
    });
    expect(buildCreateProjectBody({ name: 'Case', defaultAppId: '' })).toEqual({ name: 'Case' });
    const project = { name: 'Case', description: '', instructions: '', defaultAppId: 'chat' };
    const form = projectFormFrom(project);
    expect(form.defaultAppId).toBe('chat');
    expect(buildProjectChanges(form, project)).toBeNull();
    expect(buildProjectChanges({ ...form, defaultAppId: 'summarizer' }, project)).toEqual({
      defaultAppId: 'summarizer'
    });
    // Choosing "no default" is sent as null, the server's way to clear it.
    expect(buildProjectChanges({ ...form, defaultAppId: '' }, project)).toEqual({
      defaultAppId: null
    });
    // A project that never had one is unchanged by an untouched form.
    expect(buildProjectChanges(projectFormFrom({ name: 'Case' }), { name: 'Case' })).toBeNull();
  });

  test('takes another editor’s update into untouched fields only', () => {
    const base = { name: 'Case', description: 'd', instructions: 'Be brief.' };
    const form = { ...base, name: 'Case 2' };
    const polled = {
      id: 'prj_a',
      name: 'Case',
      description: 'd',
      instructions: 'Answer in German.'
    };
    const next = reconcileProjectForm(form, base, polled);
    expect(next.form).toEqual({
      name: 'Case 2',
      description: 'd',
      instructions: 'Answer in German.',
      defaultAppId: ''
    });
    // Only the user's own edit goes out; the other editor's text is kept.
    expect(buildProjectChanges(next.form, next.base)).toEqual({ name: 'Case 2' });
    // A field both changed keeps the user's text and still counts as a change.
    const both = reconcileProjectForm({ ...base, instructions: 'Mine.' }, base, polled);
    expect(both.form.instructions).toBe('Mine.');
    expect(buildProjectChanges(both.form, both.base)).toEqual({ instructions: 'Mine.' });
  });

  test('computes quotas and whether a project may be created', () => {
    expect(quotaState(4, 5)).toMatchObject({ level: 'warn', limit: 5 });
    expect(quotaState(5, 5)).toMatchObject({ level: 'full' });
    expect(quotaState(1, undefined)).toMatchObject({ level: 'ok', limit: null });
    expect(
      projectUsage({ usage: { items: 2, bytes: 10 } }, { limits: { maxFiles: 25 } }).items
    ).toMatchObject({
      used: 2,
      limit: 25
    });
    const config = { userProjects: { enabled: true, canCreate: true, maxProjects: 2, used: 2 } };
    expect(projectCreation(config)).toMatchObject({ allowed: false, reason: 'quota' });
    expect(projectCreation({ userProjects: { enabled: true, canCreate: false } }).reason).toBe(
      'permission'
    );
    expect(projectCreation(null).reason).toBe('disabled');
  });

  test('maps members to shares and back, and finds the caller for "leave"', () => {
    const members = [
      { type: 'user', id: 'u1', name: 'Ann', role: 'editor' },
      { type: 'group', id: 'legal', role: 'user' },
      { type: 'everyone', id: null, role: 'user' }
    ];
    const shares = membersToShares(members);
    expect(shares[0]).toEqual({ type: 'user', id: 'u1', name: 'Ann', permission: 'edit' });
    expect(sharesToMembers(shares)).toEqual([
      { type: 'user', id: 'u1', role: 'editor' },
      { type: 'group', id: 'legal', role: 'user' },
      { type: 'everyone', role: 'user' }
    ]);
    const project = { members };
    expect(ownMemberEntry(project, 'u1')).toBe(members[0]);
    expect(ownMemberEntry(project, 'legal')).toBeNull();
    expect(membersWithout(project, 'u1')).toHaveLength(2);
  });

  test('links chats and starts project chats', () => {
    expect(chatPath({ id: 'c1', appId: 'chat' })).toBe('/apps/chat/c/c1');
    expect(chatPath({ id: 'c1' })).toBe('/chats');
    expect(projectChatStartPath('chat', 'prj_a')).toBe('/apps/chat?project=prj_a');
    // Someone from the catalog starts a chat with the project attached.
    expect(projectChatStartPath('chat', 'prj_a', { attach: true })).toBe(
      '/apps/chat?attachProject=prj_a'
    );
    expect(
      appsForProjectChats([
        { id: 'a' },
        { id: 'b', features: { userProjects: false } },
        { id: 'c', features: { projects: false } }
      ])
    ).toEqual([{ id: 'a' }]);
    // Only chat apps start a chat; an omitted type is a chat app.
    expect(
      appsForProjectChats([
        { id: 'a' },
        { id: 'c', type: 'chat' },
        { id: 'frame', type: 'iframe' },
        { id: 'away', type: 'redirect' }
      ]).map(app => app.id)
    ).toEqual(['a', 'c']);
    // With a first message the chat sends it at once.
    expect(projectChatStartPath('chat', 'prj_a', { message: '  Summarize the lease  ' })).toBe(
      '/apps/chat?project=prj_a&prefill=Summarize+the+lease&send=true'
    );
    expect(projectChatStartPath('chat', 'prj_a', { message: '   ' })).toBe(
      '/apps/chat?project=prj_a'
    );
    // Someone from the catalog sends the first message with the project attached.
    expect(projectChatStartPath('chat', 'prj_a', { attach: true, message: 'Hi' })).toBe(
      '/apps/chat?attachProject=prj_a&prefill=Hi&send=true'
    );
  });

  test('starts in the default app while it is usable, else the first app', () => {
    const apps = [{ id: 'chat' }, { id: 'summarizer' }];
    expect(resolveProjectChatApp(apps, 'summarizer')).toBe('summarizer');
    expect(resolveProjectChatApp(apps, 'removed')).toBe('chat');
    expect(resolveProjectChatApp(apps, null)).toBe('chat');
    expect(resolveProjectChatApp([], 'chat')).toBeNull();
  });
});

describe('project errors', () => {
  test('finds the code in details or at the top level', () => {
    expect(
      projectErrorDetails(
        apiError(413, { error: 'x', details: { code: 'QUOTA_FILES', limit: 25 } })
      )
    ).toMatchObject({
      code: 'QUOTA_FILES',
      status: 413,
      details: { limit: 25 }
    });
    expect(projectErrorDetails(apiError(409, { error: 'x', code: 'PROJECT_MISMATCH' })).code).toBe(
      'PROJECT_MISMATCH'
    );
  });

  test('turns the spec codes into messages and keeps the server text otherwise', () => {
    expect(
      projectErrorMessage(apiError(413, { details: { code: 'QUOTA_FILES', limit: 25 } }), t)
    ).toBe('This project already holds 25 items, the most it may hold.');
    expect(
      projectErrorMessage(
        apiError(413, { details: { code: 'QUOTA_FILE_BYTES', limit: 20971520 } }),
        t
      )
    ).toBe('A file may be at most 20.0 MB.');
    expect(
      projectErrorMessage(
        apiError(415, {
          details: { code: 'UNSUPPORTED_TYPE', accepted: { summary: 'PDF, Word' } }
        }),
        t
      )
    ).toBe('This file type is not supported. Supported: PDF, Word.');
    expect(
      projectErrorMessage(apiError(503, { details: { code: 'STORAGE_UNAVAILABLE' } }), t)
    ).toBe('Projects are not available on this installation.');
    expect(projectErrorMessage(apiError(400, { error: 'Odd input' }), t)).toBe('Odd input');
  });

  test('explains failed items by their code', () => {
    expect(itemErrorMessage({ error: { code: 'NO_TEXT', message: 'raw' } }, t)).toMatch(/OCR/);
    expect(
      itemErrorMessage({ error: { code: 'EXTRACTION_FAILED', message: 'encrypted' } }, t)
    ).toBe('encrypted');
    expect(itemErrorMessage({ error: null }, t)).toBeNull();
  });
});

describe('provenance', () => {
  test('maps origins onto the three markers', () => {
    expect(provenanceView({ origin: 'written' })).toEqual({
      marker: 'uploaded',
      site: null,
      at: null
    });
    expect(provenanceView({ origin: 'migrated' }).marker).toBe('linked');
    expect(
      provenanceView({ origin: 'picked', kind: 'office365', at: '2026-10-12T08:00:00Z' })
    ).toEqual({
      marker: 'picked',
      site: 'OneDrive / SharePoint',
      at: '2026-10-12T08:00:00Z'
    });
    expect(
      provenanceView(
        { origin: 'picked', source: { site: 'Nextcloud' } },
        { snapshotAt: '2026-01-01T00:00:00Z' }
      )
    ).toMatchObject({ site: 'Nextcloud', at: '2026-01-01T00:00:00Z' });
    expect(provenanceView(null)).toBeNull();
    expect(provenanceView({ origin: 'web' })).toBeNull();
  });

  test('formats the snapshot date and ignores garbage', () => {
    expect(formatSnapshotDate('2026-10-12T08:00:00Z', 'en-GB')).toBe('12 Oct 2026');
    expect(formatSnapshotDate('not a date', 'en')).toBeNull();
  });
});

describe('text preview', () => {
  test('previews and downloads text-only project documents as text', () => {
    const upload = { provider: 'project', provenance: { origin: 'uploaded', kind: 'upload' } };
    const webPage = { provider: 'project', provenance: { origin: 'linked', kind: 'url' } };
    const ifinderDoc = {
      provider: 'project',
      provenance: { origin: 'linked', kind: 'ifinder-document' }
    };
    expect(previewFormatFor(upload)).toBe('text');
    expect(previewFormatFor(webPage)).toBe('text');
    expect(downloadFormatFor(upload)).toBe('text');
    // An iFinder document has a rendition; an unknown kind asks and falls back on 410.
    expect(previewFormatFor(ifinderDoc)).toBe('pdf');
    expect(previewFormatFor({ provider: 'project' })).toBe('pdf');
    expect(previewFormatFor({ provider: 'ifinder' })).toBe('pdf');
    expect(downloadFormatFor({ provider: 'ifinder' })).toBe('original');
  });

  test('recognizes "original discarded"', () => {
    expect(isOriginalDiscarded({ response: { status: 410 } })).toBe(true);
    expect(isOriginalDiscarded({ response: { status: 404 } })).toBe(false);
  });

  test('highlights passages and merges overlapping ones', () => {
    const text = 'The rent is due monthly. Notice period is three months.';
    expect(splitByPassages(text, ['Notice period is three months.'])).toEqual({
      segments: [
        { at: 0, text: 'The rent is due monthly. ', match: null },
        { at: 25, text: 'Notice period is three months.', match: 0 }
      ],
      matches: 1
    });
    const overlapping = splitByPassages(text, ['rent is due', 'is due monthly']);
    expect(overlapping.matches).toBe(1);
    expect(overlapping.segments[1]).toEqual({ at: 4, text: 'rent is due monthly', match: 0 });
    expect(splitByPassages(text, ['not in there'])).toEqual({
      segments: [{ at: 0, text, match: null }],
      matches: 0
    });
  });
});
