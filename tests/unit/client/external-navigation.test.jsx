import {
  detectExternalNavigationHost,
  filenameFromContentDisposition,
  openExternalUrl,
  saveBlobAs
} from '../../../client/src/utils/externalNavigation';

/**
 * Host-aware external navigation.
 *
 * The bug this guards against (issue #2453) is invisible by construction: in
 * the Outlook task pane `window.open()` returns `null` without navigating or
 * throwing, so a button wired to it looks like it works and does nothing. The
 * assertions below therefore care about two things — that each host's own API
 * is the one that gets used, and that a blocked open is reported as `false`
 * rather than swallowed.
 */

describe('detectExternalNavigationHost', () => {
  afterEach(() => {
    delete global.Office;
    delete global.chrome;
  });

  it('is "web" with no embedded host APIs present', () => {
    expect(detectExternalNavigationHost()).toBe('web');
  });

  it('is "office" once Office.js has published the UI namespace', () => {
    global.Office = { context: { ui: { openBrowserWindow: jest.fn() } } };
    expect(detectExternalNavigationHost()).toBe('office');
  });

  it('is "extension" when chrome.tabs is reachable', () => {
    global.chrome = { tabs: { create: jest.fn() } };
    expect(detectExternalNavigationHost()).toBe('extension');
  });

  it('is not fooled by a half-initialised Office.js', () => {
    // Office.js is on the page from the first byte, but `Office.context` only
    // exists after onReady — detecting eagerly would pin the pane to "web".
    global.Office = {};
    expect(detectExternalNavigationHost()).toBe('web');
  });
});

describe('openExternalUrl', () => {
  let windowOpen;

  beforeEach(() => {
    windowOpen = jest.spyOn(window, 'open').mockReturnValue({});
  });

  afterEach(() => {
    windowOpen.mockRestore();
    delete global.Office;
    delete global.chrome;
  });

  it('uses window.open in the web app', () => {
    expect(openExternalUrl('https://example.test/doc')).toBe(true);
    expect(windowOpen).toHaveBeenCalledWith(
      'https://example.test/doc',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('uses Office.context.ui.openBrowserWindow in the Outlook task pane', () => {
    const openBrowserWindow = jest.fn();
    global.Office = { context: { ui: { openBrowserWindow } } };

    expect(openExternalUrl('https://example.test/doc')).toBe(true);
    expect(openBrowserWindow).toHaveBeenCalledWith('https://example.test/doc');
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it('falls back to window.open when the Office API rejects the call', () => {
    global.Office = {
      context: {
        ui: {
          openBrowserWindow: jest.fn(() => {
            throw new Error('requirement set not supported');
          })
        }
      }
    };

    expect(openExternalUrl('https://example.test/doc')).toBe(true);
    expect(windowOpen).toHaveBeenCalled();
  });

  it('uses chrome.tabs.create in the extension side panel', () => {
    const create = jest.fn(() => Promise.resolve({}));
    global.chrome = { tabs: { create } };

    expect(openExternalUrl('https://example.test/doc')).toBe(true);
    expect(create).toHaveBeenCalledWith({ url: 'https://example.test/doc' });
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it('swallows a rejected chrome.tabs.create promise', async () => {
    const create = jest.fn(() => Promise.reject(new Error('no tab')));
    global.chrome = { tabs: { create } };

    expect(openExternalUrl('https://example.test/doc')).toBe(true);
    await Promise.resolve();
  });

  it('reports failure when the popup is blocked', () => {
    windowOpen.mockReturnValue(null);
    expect(openExternalUrl('https://example.test/doc')).toBe(false);
  });

  it('reports failure when there is no URL', () => {
    expect(openExternalUrl('')).toBe(false);
    expect(windowOpen).not.toHaveBeenCalled();
  });
});

describe('saveBlobAs', () => {
  let createObjectURL;
  let revokeObjectURL;

  beforeEach(() => {
    jest.useFakeTimers();
    createObjectURL = jest.fn(() => 'blob:mock-url');
    revokeObjectURL = jest.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });

  afterEach(() => {
    jest.useRealTimers();
    delete URL.createObjectURL;
    delete URL.revokeObjectURL;
  });

  it('clicks a hidden <a download> so no popup is involved', () => {
    const clicks = [];
    const anchorClick = jest
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function record() {
        clicks.push({ href: this.href, download: this.download });
      });

    expect(saveBlobAs(new Blob(['pdf']), 'report.pdf')).toBe(true);
    expect(clicks).toEqual([{ href: 'blob:mock-url', download: 'report.pdf' }]);
    expect(document.querySelector('a[download]')).toBeNull();

    anchorClick.mockRestore();
  });

  it('revokes the object URL only after the transfer has had a chance to start', () => {
    const anchorClick = jest
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});

    saveBlobAs(new Blob(['pdf']), 'report.pdf');
    expect(revokeObjectURL).not.toHaveBeenCalled();

    jest.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');

    anchorClick.mockRestore();
  });

  it('reports failure when there is nothing to save', () => {
    expect(saveBlobAs(null, 'report.pdf')).toBe(false);
  });
});

describe('filenameFromContentDisposition', () => {
  it('reads a quoted filename', () => {
    expect(filenameFromContentDisposition('attachment; filename="q3 report.pdf"')).toBe(
      'q3 report.pdf'
    );
  });

  it('reads an unquoted filename', () => {
    expect(filenameFromContentDisposition('attachment; filename=q3.pdf')).toBe('q3.pdf');
  });

  it('prefers the RFC 5987 form so non-ASCII names survive', () => {
    expect(
      filenameFromContentDisposition(
        'attachment; filename="Bericht.pdf"; filename*=UTF-8\'\'Gesch%C3%A4ftsbericht.pdf'
      )
    ).toBe('Geschäftsbericht.pdf');
  });

  it('keeps the raw value when the percent-encoding is broken', () => {
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8''bad%ZZname.pdf")).toBe(
      'bad%ZZname.pdf'
    );
  });

  it('returns null when there is no filename', () => {
    expect(filenameFromContentDisposition('inline')).toBeNull();
    expect(filenameFromContentDisposition(undefined)).toBeNull();
  });
});
