// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Importing into a project (`POST …/items/_import`): ZIP archives are routed to the import
 * endpoint (unpacked on the server) while other files keep the plain upload, the projects a chat
 * file can be copied into, and what the copy dialog says about who will see it.
 */
import {
  canCopyArtifactToProject,
  copyTargetProjects,
  importErrorMessage,
  importErrorSkipped,
  importSummary,
  isZipFile,
  projectAudienceLabel,
  projectAudienceOf,
  uploadProjectFiles,
  withZipAccept
} from '../../../client/src/features/projects/utils/projectImport';

const t = (key, fallback, options) =>
  String(fallback ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''));

const file = (name, type = '') => new File(['x'], name, { type });

describe('isZipFile / withZipAccept', () => {
  it('recognizes an archive by its name or its reported type', () => {
    expect(isZipFile(file('export.zip'))).toBe(true);
    expect(isZipFile(file('EXPORT.ZIP', 'application/octet-stream'))).toBe(true);
    expect(isZipFile(file('archive', 'application/x-zip-compressed'))).toBe(true);
    expect(isZipFile(file('report.pdf', 'application/pdf'))).toBe(false);
    expect(isZipFile(null)).toBe(false);
  });

  it('adds .zip to a restricting accept list once', () => {
    expect(withZipAccept('.pdf,.docx')).toBe('.pdf,.docx,.zip');
    expect(withZipAccept('.pdf,.zip')).toBe('.pdf,.zip');
    expect(withZipAccept(undefined)).toBeUndefined();
  });
});

describe('uploadProjectFiles', () => {
  const makeApi = () => ({
    uploadItem: jest.fn(async (_projectId, { file: f }) => ({ id: `item-${f.name}` })),
    importItem: jest.fn(async () => ({
      items: [{ id: 'a' }, { id: 'b' }],
      skipped: [{ name: 'photo.png', code: 'UNSUPPORTED_TYPE', message: 'Images are not taken' }]
    })),
    errorMessage: () => 'failed'
  });

  it('sends a ZIP archive to the import endpoint and other files to the plain upload', async () => {
    const api = makeApi();
    const zip = file('bundle.zip', 'application/zip');
    const pdf = file('report.pdf', 'application/pdf');
    const result = await uploadProjectFiles(
      api,
      'prj_1',
      [zip, pdf],
      { name: '', pinned: true },
      t
    );

    expect(api.importItem).toHaveBeenCalledWith('prj_1', { file: zip, pinned: true });
    expect(api.uploadItem).toHaveBeenCalledTimes(1);
    expect(api.uploadItem.mock.calls[0][1].file).toBe(pdf);
    expect(result.added.map(item => item.id)).toEqual(['a', 'b', 'item-report.pdf']);
    expect(result.uploaded).toEqual([zip, pdf]);
    expect(result.archives).toEqual([
      {
        name: 'bundle.zip',
        summary: {
          added: 2,
          skipped: [
            { name: 'photo.png', code: 'UNSUPPORTED_TYPE', message: 'Images are not taken' }
          ]
        }
      }
    ]);
    expect(result.failures).toEqual([]);
  });

  it('keeps the plain upload for an archive where the API has no import', async () => {
    const api = makeApi();
    delete api.importItem;
    await uploadProjectFiles(api, 'prj_1', [file('bundle.zip')], { name: 'n', pinned: false }, t);
    expect(api.uploadItem).toHaveBeenCalledTimes(1);
  });

  it('reports a refused archive with the server detail and what it skipped', async () => {
    const api = makeApi();
    api.importItem.mockRejectedValue({
      response: {
        status: 415,
        data: {
          code: 'UNSUPPORTED_TYPE',
          detail: 'The archive holds nothing a project can take.',
          details: { skipped: [{ name: 'a.png', code: 'UNSUPPORTED_TYPE', message: 'An image' }] }
        }
      }
    });
    const zip = file('pics.zip');
    const result = await uploadProjectFiles(api, 'prj_1', [zip], { name: '', pinned: false }, t);
    expect(result.uploaded).toEqual([]);
    expect(result.failures).toEqual([
      'The archive holds nothing a project can take.\n  a.png: An image'
    ]);
  });
});

describe('import errors', () => {
  it('prefers the server detail, and falls back on the code message', () => {
    const quota = {
      originalError: {
        response: { status: 413, data: { code: 'QUOTA_FILES', detail: 'Too many items.' } }
      }
    };
    expect(importErrorMessage(quota, t)).toBe('Too many items.');
    const bare = { response: { status: 415, data: { code: 'UNSUPPORTED_TYPE' } } };
    expect(importErrorMessage(bare, t)).toBe('This file type is not supported.');
    expect(importErrorSkipped(bare)).toEqual([]);
  });

  it('summarizes an answer however much of it came', () => {
    expect(importSummary({ items: [{}, {}] })).toEqual({ added: 2, skipped: [] });
    expect(importSummary(null)).toEqual({ added: 0, skipped: [] });
  });
});

describe('copy targets', () => {
  const project = overrides => ({
    id: 'prj_x',
    ownership: 'user',
    permissions: { canEdit: true, readOnly: false },
    ...overrides
  });

  it('lists user projects the caller may change, nothing else', () => {
    const projects = [
      project({ id: 'prj_own' }),
      project({ id: 'prj_reader', permissions: { canEdit: false } }),
      project({ id: 'prj_frozen', permissions: { canEdit: true, readOnly: true } }),
      project({ id: 'admin', ownership: 'admin' }),
      project({ id: 'ifc_1', tier: 'ifinder' })
    ];
    expect(copyTargetProjects(projects).map(entry => entry.id)).toEqual(['prj_own']);
    expect(copyTargetProjects(undefined)).toEqual([]);
  });

  it('never copies a picture, and needs a stored file', () => {
    expect(canCopyArtifactToProject({ id: 'a', mimeType: 'application/zip' })).toBe(true);
    expect(canCopyArtifactToProject({ id: 'a', mimeType: 'text/markdown' })).toBe(true);
    expect(canCopyArtifactToProject({ id: 'a', mimeType: 'image/png' })).toBe(false);
    expect(canCopyArtifactToProject({ id: 'a', kind: 'image' })).toBe(false);
    expect(canCopyArtifactToProject({ mimeType: 'text/plain' })).toBe(false);
  });
});

describe('project audience', () => {
  it('says who sees what is added', () => {
    expect(projectAudienceOf({ audience: { everyone: true }, memberCount: 3 }).kind).toBe(
      'everyone'
    );
    expect(projectAudienceOf({ audience: { catalog: true } }).kind).toBe('catalog');
    expect(projectAudienceOf({ members: [{}, {}] })).toEqual({ kind: 'members', count: 2 });
    expect(projectAudienceOf({ memberCount: 0 })).toEqual({ kind: 'private', count: 0 });
    expect(projectAudienceOf(null)).toEqual({ kind: 'private', count: 0 });
  });

  it('turns it into a label', () => {
    expect(projectAudienceLabel(null, t)).toBe('Only you');
    expect(projectAudienceLabel({ memberCount: 4 }, t)).toBe('Shared with 4 people or groups');
    expect(projectAudienceLabel({ audience: { everyone: true } }, t)).toBe('Everyone signed in');
  });
});
