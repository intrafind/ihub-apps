// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Two client helpers that hand server-provided text to the browser:
 * `startIntegrationConnect` leaves the page for the vendor's consent URL, and
 * `markdownToHtml` returns HTML that callers render with innerHTML.
 */

jest.mock('../../../client/src/api/userIntegrationsApi', () => ({
  fetchUserIntegration: jest.fn(),
  requestConnectUrl: jest.fn()
}));
jest.mock('../../../client/src/features/integrations/connect/connectResult', () => ({
  currentReturnUrl: () => '/apps/chat'
}));
jest.mock('../../../client/src/config/marked.config', () => ({
  renderMarkdown: jest.fn()
}));

import { requestConnectUrl } from '../../../client/src/api/userIntegrationsApi';
import { startIntegrationConnect } from '../../../client/src/features/integrations/connect/integrationInfo';
import { renderMarkdown } from '../../../client/src/config/marked.config';
import { markdownToHtml } from '../../../client/src/utils/markdownUtils';

describe('startIntegrationConnect', () => {
  it('navigates to an https consent URL', async () => {
    requestConnectUrl.mockResolvedValue('https://vendor.example/authorize?state=1');
    const navigate = jest.fn();
    await startIntegrationConnect('jira', { navigate });
    expect(navigate).toHaveBeenCalledWith('https://vendor.example/authorize?state=1');
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', 'ftp://vendor.example/x', '', undefined])(
    'does not navigate to %p',
    async url => {
      requestConnectUrl.mockResolvedValue(url);
      const navigate = jest.fn();
      await expect(startIntegrationConnect('jira', { navigate })).rejects.toThrow(
        'not an http(s) URL'
      );
      expect(navigate).not.toHaveBeenCalled();
    }
  );
});

describe('markdownToHtml', () => {
  let consoleError;
  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => consoleError.mockRestore());

  it('returns the rendered HTML', () => {
    renderMarkdown.mockReturnValue('<p>ok</p>');
    expect(markdownToHtml('ok')).toBe('<p>ok</p>');
  });

  it('escapes the source instead of returning it as HTML when rendering fails', () => {
    renderMarkdown.mockImplementation(() => {
      throw new Error('boom');
    });
    const html = markdownToHtml('<img src=x onerror=alert(1)> & more');
    expect(html).not.toContain('<img');
    expect(html).toBe('<pre>&lt;img src=x onerror=alert(1)&gt; &amp; more</pre>');
  });

  it('returns an empty string for empty or non-string input', () => {
    expect(markdownToHtml('')).toBe('');
    expect(markdownToHtml(null)).toBe('');
  });
});
