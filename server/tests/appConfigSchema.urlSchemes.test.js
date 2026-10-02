/**
 * Redirect and iframe apps only accept http(s) URLs.
 *
 * The client navigates to `redirectConfig.url` and loads `iframeConfig.url` as
 * an iframe's src. `z.string().url()` alone accepts any scheme `new URL()` can
 * parse, so both fields go through `zHttpUrl`, which also requires `http:` or
 * `https:`.
 *
 * Native ESM: run with `node --experimental-vm-modules` (the test scripts do).
 */

import { appConfigSchema } from '../validators/appConfigSchema.js';
import { isHttpUrl, zHttpUrl } from '../validators/common.js';

const baseApp = {
  id: 'external-tool',
  name: { en: 'External tool' },
  description: { en: 'Opens an external tool' },
  color: '#4F46E5',
  icon: 'external-link'
};

const redirectApp = url => ({ ...baseApp, type: 'redirect', redirectConfig: { url } });
const iframeApp = url => ({ ...baseApp, type: 'iframe', iframeConfig: { url } });

const issueMessages = result => result.error.issues.map(issue => issue.message);

const NON_HTTP_URLS = [
  'javascript:void(0)',
  'data:text/plain,hello',
  'file:///etc/hosts',
  'ftp://files.example.com/tool',
  'mailto:someone@example.com'
];

describe('isHttpUrl', () => {
  test.each(['https://example.com', 'http://localhost:8080/path?q=1', 'HTTPS://EXAMPLE.COM/'])(
    'accepts %s',
    value => {
      expect(isHttpUrl(value)).toBe(true);
    }
  );

  test.each([...NON_HTTP_URLS, '/relative/path', '//example.com/x', 'not a url', ''])(
    'rejects %s',
    value => {
      expect(isHttpUrl(value)).toBe(false);
    }
  );
});

describe('zHttpUrl', () => {
  test('names the field in both messages', () => {
    const schema = zHttpUrl('Link');

    expect(issueMessages(schema.safeParse('not a url'))).toContain('Link must be a valid URL');
    expect(issueMessages(schema.safeParse('javascript:void(0)'))).toContain(
      'Link must use http or https'
    );
  });
});

describe('redirect app URL', () => {
  test.each(['https://example.com/tool', 'http://intranet.example.com:8080/'])(
    'accepts %s',
    url => {
      expect(appConfigSchema.safeParse(redirectApp(url)).success).toBe(true);
    }
  );

  test.each(NON_HTTP_URLS)('rejects %s', url => {
    const result = appConfigSchema.safeParse(redirectApp(url));

    expect(result.success).toBe(false);
    expect(result.error.issues[0].path).toEqual(['redirectConfig', 'url']);
    expect(issueMessages(result)).toContain('Redirect URL must use http or https');
  });

  test('still rejects a value that is not a URL at all', () => {
    const result = appConfigSchema.safeParse(redirectApp('example'));

    expect(result.success).toBe(false);
    expect(issueMessages(result)).toContain('Redirect URL must be a valid URL');
  });
});

describe('iframe app URL', () => {
  test('accepts an https URL', () => {
    expect(appConfigSchema.safeParse(iframeApp('https://example.com/embed')).success).toBe(true);
  });

  test.each(NON_HTTP_URLS)('rejects %s', url => {
    const result = appConfigSchema.safeParse(iframeApp(url));

    expect(result.success).toBe(false);
    expect(result.error.issues[0].path).toEqual(['iframeConfig', 'url']);
    expect(issueMessages(result)).toContain('Iframe URL must use http or https');
  });
});
