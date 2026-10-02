import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';

/**
 * Iframe apps only embed http(s) URLs. Any other configured URL — for example
 * one in an app file saved before URLs were validated — shows an error instead
 * of an iframe, and "Open in new tab" is never offered for it.
 */

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: key => key,
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  __esModule: true,
  useUIConfig: () => ({ resetHeaderColor: () => {} })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

// runtimeBasePath uses `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => ''
}));

const IframeApp = require('../../../client/src/features/apps/pages/IframeApp').default;

const iframeApp = iframeConfig => ({
  id: 'embedded-tool',
  type: 'iframe',
  name: { en: 'Embedded tool' },
  iframeConfig
});

let windowOpen;

beforeEach(() => {
  windowOpen = jest.spyOn(window, 'open').mockReturnValue({});
});

afterEach(() => {
  windowOpen.mockRestore();
});

describe('IframeApp', () => {
  test('embeds an https URL and opens it in a new tab', () => {
    const { container } = render(
      <IframeApp app={iframeApp({ url: 'https://example.com/tool' })} />
    );

    expect(container.querySelector('iframe')).toHaveAttribute('src', 'https://example.com/tool');
    fireEvent.click(screen.getByTitle('pages.iframeApp.openInNewTab'));
    expect(windowOpen).toHaveBeenCalledWith(
      'https://example.com/tool',
      '_blank',
      'noopener,noreferrer'
    );
  });

  test.each([
    'javascript:void(0)',
    'data:text/html,hello',
    'file:///etc/hosts',
    'mailto:someone@example.com'
  ])('shows an error and embeds nothing for %s', url => {
    const { container } = render(<IframeApp app={iframeApp({ url })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('pages.iframeApp.invalidUrl');
    expect(container.querySelector('iframe')).not.toBeInTheDocument();
    expect(screen.queryByTitle('pages.iframeApp.openInNewTab')).not.toBeInTheDocument();
    expect(windowOpen).not.toHaveBeenCalled();
  });

  test('shows the error when no URL is configured', () => {
    const { container } = render(<IframeApp app={iframeApp(undefined)} />);

    expect(screen.getByRole('alert')).toHaveTextContent('pages.iframeApp.invalidUrl');
    expect(container.querySelector('iframe')).not.toBeInTheDocument();
  });
});
