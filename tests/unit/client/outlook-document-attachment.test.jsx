import {
  attachFileToOutlookItem,
  canAttachFileToOutlookItem,
  MAX_ATTACHMENT_BYTES
} from '../../../client/src/features/office/utilities/outlookAttachments';
import { openExternalUrlInOffice } from '../../../client/src/features/office/utilities/officeExternalLinks';
import {
  downloadBlob,
  filenameFromContentDisposition,
  resolveDownloadFilename
} from '../../../client/src/utils/fileDownload';

/**
 * The Office-side half of the citation document actions (issue #2453):
 * handing a link to the user's browser, and putting a downloaded document on
 * the mail being written.
 */

const asyncResult = (status, extra = {}) => ({ status, ...extra });

function installOffice({
  mailbox = true,
  compose = true,
  requirementSets = { 'Mailbox:1.8': true },
  addFileAttachmentFromBase64Async,
  openBrowserWindow
} = {}) {
  const item = mailbox
    ? {
        addFileAttachmentFromBase64Async,
        body: compose ? { setAsync: () => {} } : { getAsync: () => {} }
      }
    : null;

  global.Office = {
    AsyncResultStatus: { Succeeded: 'succeeded', Failed: 'failed' },
    context: {
      requirements: {
        isSetSupported: (set, version) => !!requirementSets[`${set}:${version}`]
      },
      ui: openBrowserWindow ? { openBrowserWindow } : {},
      ...(mailbox ? { mailbox: { item } } : {})
    }
  };
  return item;
}

afterEach(() => {
  delete global.Office;
  jest.restoreAllMocks();
});

describe('canAttachFileToOutlookItem', () => {
  test('true while composing on a client that supports base64 attachments', () => {
    installOffice({ addFileAttachmentFromBase64Async: () => {} });
    expect(canAttachFileToOutlookItem()).toBe(true);
  });

  test('false while reading a mail — there is no draft to attach to', () => {
    installOffice({ compose: false, addFileAttachmentFromBase64Async: () => {} });
    expect(canAttachFileToOutlookItem()).toBe(false);
  });

  test('false on clients without Mailbox 1.8', () => {
    installOffice({ requirementSets: {}, addFileAttachmentFromBase64Async: () => {} });
    expect(canAttachFileToOutlookItem()).toBe(false);
  });

  test('false outside Outlook', () => {
    expect(canAttachFileToOutlookItem()).toBe(false);
    installOffice({ mailbox: false });
    expect(canAttachFileToOutlookItem()).toBe(false);
  });
});

describe('attachFileToOutlookItem', () => {
  test('passes the bytes and the filename to Outlook', async () => {
    const addFileAttachmentFromBase64Async = jest.fn((base64, name, options, callback) =>
      callback(asyncResult('succeeded'))
    );
    installOffice({ addFileAttachmentFromBase64Async });

    await attachFileToOutlookItem({ base64: 'QUJD', filename: 'report.pdf' });

    expect(addFileAttachmentFromBase64Async).toHaveBeenCalledWith(
      'QUJD',
      'report.pdf',
      { isInline: false },
      expect.any(Function)
    );
  });

  test('surfaces the reason Outlook refused', async () => {
    installOffice({
      addFileAttachmentFromBase64Async: (base64, name, options, callback) =>
        callback(
          asyncResult('failed', { error: { message: 'Attachment size exceeded', code: 9000 } })
        )
    });

    await expect(attachFileToOutlookItem({ base64: 'QUJD', filename: 'big.pdf' })).rejects.toThrow(
      'Attachment size exceeded'
    );
  });

  test('rejects with NOT_COMPOSING when the user is only reading a mail', async () => {
    installOffice({ compose: false, addFileAttachmentFromBase64Async: () => {} });

    await expect(attachFileToOutlookItem({ base64: 'QUJD', filename: 'r.pdf' })).rejects.toThrow(
      'NOT_COMPOSING'
    );
  });

  test('caps attachments below the usual Exchange message limit', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe('openExternalUrlInOffice', () => {
  test('hands the URL to Office rather than to a blocked popup', () => {
    const openBrowserWindow = jest.fn();
    installOffice({ openBrowserWindow });
    const windowOpen = jest.spyOn(window, 'open').mockReturnValue(null);

    expect(openExternalUrlInOffice('https://example.test/doc')).toBe(true);
    expect(openBrowserWindow).toHaveBeenCalledWith('https://example.test/doc');
    expect(windowOpen).not.toHaveBeenCalled();
  });

  test('falls back to window.open on clients without the API, and reports a blocked popup', () => {
    installOffice();
    const windowOpen = jest.spyOn(window, 'open').mockReturnValue(null);

    expect(openExternalUrlInOffice('https://example.test/doc')).toBe(false);
    expect(windowOpen).toHaveBeenCalled();

    windowOpen.mockReturnValue({});
    expect(openExternalUrlInOffice('https://example.test/doc')).toBe(true);
  });
});

describe('filenames', () => {
  test('reads both Content-Disposition spellings', () => {
    expect(filenameFromContentDisposition('attachment; filename="Q3 report.pdf"')).toBe(
      'Q3 report.pdf'
    );
    expect(
      filenameFromContentDisposition("attachment; filename*=UTF-8''Gesch%C3%A4ftsbericht.pdf")
    ).toBe('Geschäftsbericht.pdf');
    expect(filenameFromContentDisposition('attachment')).toBeNull();
    expect(filenameFromContentDisposition(undefined)).toBeNull();
  });

  test('prefers the server name, then the document name, then the title', () => {
    expect(
      resolveDownloadFilename({
        headerFilename: 'server.pdf',
        fileName: 'doc.pdf',
        title: 'Title'
      })
    ).toBe('server.pdf');
    expect(resolveDownloadFilename({ fileName: 'doc.pdf', title: 'Title' })).toBe('doc.pdf');
  });

  test('gives a bare title an extension so Outlook can open the attachment', () => {
    expect(
      resolveDownloadFilename({ title: 'Quarterly report', contentType: 'application/pdf' })
    ).toBe('Quarterly report.pdf');
    expect(
      resolveDownloadFilename({ title: 'Notes', contentType: 'text/plain; charset=utf-8' })
    ).toBe('Notes.txt');
    expect(resolveDownloadFilename({ title: 'Mystery', contentType: 'application/x-weird' })).toBe(
      'Mystery'
    );
  });

  test('strips path separators and characters Windows rejects', () => {
    expect(resolveDownloadFilename({ headerFilename: '../../etc/passwd' })).toBe(
      '.._.._etc_passwd'
    );
    expect(resolveDownloadFilename({ headerFilename: 'a:b*c?.txt' })).toBe('a_b_c_.txt');
    expect(resolveDownloadFilename({})).toBe('document');
  });
});

describe('downloadBlob', () => {
  test('saves through an anchor instead of a popup the host would block', () => {
    const clicks = [];
    jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
      clicks.push({ download: this.download, inDocument: document.body.contains(this) });
    });
    window.URL.createObjectURL = jest.fn(() => 'blob:mock');
    window.URL.revokeObjectURL = jest.fn();

    downloadBlob(new Blob(['x']), 'report.pdf');

    expect(clicks).toEqual([{ download: 'report.pdf', inDocument: true }]);
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });
});
