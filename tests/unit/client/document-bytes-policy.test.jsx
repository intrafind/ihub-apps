/**
 * When an uploaded document carries its own bytes (`base64`).
 *
 * The bytes exist only for tools with file inputs (MCP `format: "file"`), and
 * they grow the chat request by ~1.37x the file size. So:
 *   - they are attached only when the app offers a tool with file inputs
 *     (advertised by `/api/tools?appId=…` as `_mcp.fileInputs`), and, at send
 *     time, only when such a tool is enabled for the turn
 *   - all documents' bytes of one message stay within a budget derived from
 *     the platform's `requestBodyLimitMB`; a document beyond it is sent as
 *     text only and the upload still succeeds
 *   - images keep their base64 as they always did
 */

import '@testing-library/jest-dom';
import { render, fireEvent, waitFor, renderHook } from '@testing-library/react';

// fileProcessing transitively imports the API client, which uses
// `import.meta.env` and cannot be parsed by babel-jest.
jest.mock('../../../client/src/api/endpoints/config', () => ({
  fetchMimetypesConfig: jest.fn(async () => {
    throw new Error('offline');
  })
}));

jest.mock('../../../client/src/api', () => ({
  fetchToolsBasic: jest.fn()
}));

let mockPlatformConfig = {};
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: mockPlatformConfig })
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : fallback?.defaultValue || key)
  })
}));

const { fetchToolsBasic } = require('../../../client/src/api');
const UnifiedUploader =
  require('../../../client/src/features/upload/components/UnifiedUploader').default;
const useDocumentBytesPolicy =
  require('../../../client/src/features/chat/hooks/useDocumentBytesPolicy').default;
const {
  DEFAULT_REQUEST_BODY_LIMIT_MB,
  applyDocumentBytesPolicy,
  capDocumentBytes,
  estimateDataUrlLength,
  getDocumentBytesBudget,
  offersFileInputTool
} = require('../../../client/src/features/upload/utils/documentBytes');

const MB = 1024 * 1024;

const FILE_TOOL = {
  id: 'files__inspect',
  _mcp: { serverId: 'files', fileInputs: [{ name: 'doc', array: false }] }
};
const PLAIN_MCP_TOOL = { id: 'drawio__create', _mcp: { serverId: 'drawio' } };
const LOCAL_TOOL = { id: 'braveSearch' };

const doc = (fileName, base64) => ({
  type: 'document',
  fileName,
  content: `text of ${fileName}`,
  ...(base64 !== undefined ? { base64 } : {})
});

describe('getDocumentBytesBudget', () => {
  it('uses 60% of the platform body limit', () => {
    expect(getDocumentBytesBudget(50)).toBe(30 * MB);
    expect(getDocumentBytesBudget('10')).toBe(6 * MB);
  });

  it('falls back to the server default when no limit is configured', () => {
    const fallback = getDocumentBytesBudget(DEFAULT_REQUEST_BODY_LIMIT_MB);
    expect(getDocumentBytesBudget()).toBe(fallback);
    expect(getDocumentBytesBudget(null)).toBe(fallback);
    expect(getDocumentBytesBudget('nonsense')).toBe(fallback);
    expect(getDocumentBytesBudget(0)).toBe(fallback);
  });
});

describe('offersFileInputTool', () => {
  it('is true when the app enables the MCP server of a tool with file inputs', () => {
    expect(offersFileInputTool(['files'], [FILE_TOOL, LOCAL_TOOL])).toBe(true);
  });

  it('is true when the app lists the tool itself', () => {
    expect(offersFileInputTool(['files__inspect'], [FILE_TOOL])).toBe(true);
  });

  it('is false when none of the app tools has file inputs', () => {
    expect(
      offersFileInputTool(['drawio', 'braveSearch'], [FILE_TOOL, PLAIN_MCP_TOOL, LOCAL_TOOL])
    ).toBe(false);
  });

  it('is false while nothing is known (no app tools, no loaded tools)', () => {
    expect(offersFileInputTool([], [FILE_TOOL])).toBe(false);
    expect(offersFileInputTool(undefined, [FILE_TOOL])).toBe(false);
    expect(offersFileInputTool(['files'], [])).toBe(false);
  });

  it('honours the turn enabled tools when given', () => {
    expect(offersFileInputTool(['files', 'drawio'], [FILE_TOOL], ['drawio'])).toBe(false);
    expect(offersFileInputTool(['files', 'drawio'], [FILE_TOOL], ['files'])).toBe(true);
    expect(offersFileInputTool(['files'], [FILE_TOOL], null)).toBe(true);
  });
});

describe('capDocumentBytes', () => {
  it('keeps bytes in order while they fit and drops them for a document beyond the budget', () => {
    const a = doc('a.pdf', 'x'.repeat(40));
    const b = doc('b.pdf', 'y'.repeat(40));
    const c = doc('c.pdf', 'z'.repeat(10));
    const out = capDocumentBytes([a, b, c], 55);
    expect(out[0]).toBe(a);
    expect(out[1]).toEqual(doc('b.pdf'));
    expect(out[1].content).toBe('text of b.pdf');
    expect(out[2]).toBe(c);
  });

  it('never touches images and returns the input when nothing changes', () => {
    const image = { type: 'image', fileName: 'p.png', base64: 'i'.repeat(100) };
    const list = [image, doc('a.pdf', 'x'.repeat(10))];
    expect(capDocumentBytes(list, 10)).toBe(list);
    expect(capDocumentBytes(image, 0)).toBe(image);
    expect(capDocumentBytes(null, 10)).toBeNull();
  });

  it('keeps the shape of a single entry', () => {
    expect(capDocumentBytes(doc('a.pdf', 'x'.repeat(10)), 5)).toEqual(doc('a.pdf'));
  });

  it('applyDocumentBytesPolicy drops every document byte when no file-input tool is offered', () => {
    const image = { type: 'image', fileName: 'p.png', base64: 'img' };
    const out = applyDocumentBytesPolicy([doc('a.pdf', 'xx'), image], {
      attachBytes: false,
      budget: 30 * MB
    });
    expect(out).toEqual([doc('a.pdf'), image]);
  });
});

describe('UnifiedUploader document bytes', () => {
  const TEXT = 'Quarterly numbers\n';

  function renderUploader(props = {}) {
    const onFileSelect = jest.fn();
    const utils = render(
      <UnifiedUploader
        onFileSelect={onFileSelect}
        config={{
          imageUploadEnabled: false,
          audioUploadEnabled: false,
          videoUploadEnabled: false,
          allowMultiple: true,
          fileUpload: { enabled: true, supportedFormats: ['text/plain'] }
        }}
        {...props}
      >
        <div />
      </UnifiedUploader>
    );
    const input = utils.container.querySelector('input[type="file"]');
    const upload = (...files) => fireEvent.change(input, { target: { files } });
    return { upload, onFileSelect };
  }

  const lastSelection = onFileSelect => {
    const calls = onFileSelect.mock.calls;
    const selection = calls[calls.length - 1][0];
    return Array.isArray(selection) ? selection : [selection];
  };

  it('attaches no bytes by default (no tool with file inputs)', async () => {
    const { upload, onFileSelect } = renderUploader();
    upload(new File([TEXT], 'notes.txt', { type: 'text/plain' }));
    await waitFor(() => expect(onFileSelect).toHaveBeenCalled());
    const [file] = lastSelection(onFileSelect);
    expect(file.content).toBe(TEXT);
    expect(file.base64).toBeUndefined();
  });

  it('attaches the bytes when the app offers a tool with file inputs', async () => {
    const { upload, onFileSelect } = renderUploader({ includeDocumentBytes: true });
    upload(new File([TEXT], 'notes.txt', { type: 'text/plain' }));
    await waitFor(() => expect(onFileSelect).toHaveBeenCalled());
    const [file] = lastSelection(onFileSelect);
    expect(file.content).toBe(TEXT);
    expect(file.base64).toMatch(/^data:text\/plain;base64,/);
  });

  it('keeps a document beyond the budget as text only instead of failing the upload', async () => {
    const small = new File(['a'], 'small.txt', { type: 'text/plain' });
    const large = new File(['b'.repeat(300)], 'large.txt', { type: 'text/plain' });
    const budget = estimateDataUrlLength(small.size, small.type) + 10;
    const { upload, onFileSelect } = renderUploader({
      includeDocumentBytes: true,
      documentBytesBudget: budget
    });
    upload(small, large);
    await waitFor(() => expect(onFileSelect).toHaveBeenCalled());
    const [first, second] = lastSelection(onFileSelect);
    expect(first.fileName).toBe('small.txt');
    expect(first.base64).toMatch(/^data:text\/plain;base64,/);
    expect(second.fileName).toBe('large.txt');
    expect(second.content).toBe('b'.repeat(300));
    expect(second.base64).toBeUndefined();
  });

  it('caps the total over several documents that each fit on their own', async () => {
    const one = new File(['1'.repeat(30)], 'one.txt', { type: 'text/plain' });
    const two = new File(['2'.repeat(30)], 'two.txt', { type: 'text/plain' });
    const budget = estimateDataUrlLength(one.size, one.type) + 5;
    const { upload, onFileSelect } = renderUploader({
      includeDocumentBytes: true,
      documentBytesBudget: budget
    });
    upload(one, two);
    await waitFor(() => expect(onFileSelect).toHaveBeenCalled());
    const [first, second] = lastSelection(onFileSelect);
    expect(first.base64).toBeDefined();
    expect(second.base64).toBeUndefined();
    expect(second.content).toBe('2'.repeat(30));
  });
});

describe('useDocumentBytesPolicy', () => {
  beforeEach(() => {
    fetchToolsBasic.mockReset();
    mockPlatformConfig = { requestBodyLimitMB: 20 };
  });

  it('attaches bytes once the app tools list a tool with file inputs', async () => {
    fetchToolsBasic.mockResolvedValue([FILE_TOOL, LOCAL_TOOL]);
    const app = { id: 'inspector', tools: ['files'] };
    const { result } = renderHook(() => useDocumentBytesPolicy(app));
    expect(result.current.attachBytes).toBe(false);
    await waitFor(() => expect(result.current.attachBytes).toBe(true));
    expect(fetchToolsBasic).toHaveBeenCalledWith({ appId: 'inspector' });
    expect(result.current.budget).toBe(12 * MB);
  });

  it('attaches none for an app whose tools take no files', async () => {
    fetchToolsBasic.mockResolvedValue([FILE_TOOL, PLAIN_MCP_TOOL]);
    const app = { id: 'diagrams', tools: ['drawio'] };
    const { result } = renderHook(() => useDocumentBytesPolicy(app));
    await waitFor(() => expect(fetchToolsBasic).toHaveBeenCalled());
    await Promise.resolve();
    expect(result.current.attachBytes).toBe(false);
  });

  it('does not ask for tools when the app has none', () => {
    const { result } = renderHook(() => useDocumentBytesPolicy({ id: 'plain', tools: [] }));
    expect(fetchToolsBasic).not.toHaveBeenCalled();
    expect(result.current.attachBytes).toBe(false);
  });

  it('attaches none when the file-input tool is disabled for the turn', async () => {
    fetchToolsBasic.mockResolvedValue([FILE_TOOL, PLAIN_MCP_TOOL]);
    const app = { id: 'mixed', tools: ['files', 'drawio'] };
    const { result } = renderHook(() => useDocumentBytesPolicy(app, { enabledTools: ['drawio'] }));
    await waitFor(() => expect(fetchToolsBasic).toHaveBeenCalled());
    await Promise.resolve();
    expect(result.current.attachBytes).toBe(false);
  });

  it('attaches none when the tools request fails', async () => {
    fetchToolsBasic.mockRejectedValue(new Error('403'));
    const { result } = renderHook(() => useDocumentBytesPolicy({ id: 'x', tools: ['files'] }));
    await waitFor(() => expect(fetchToolsBasic).toHaveBeenCalled());
    await Promise.resolve();
    expect(result.current.attachBytes).toBe(false);
  });
});
