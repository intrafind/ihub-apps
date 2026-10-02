import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';

/**
 * Redirect apps only follow http(s) targets. Any other configured URL shows an
 * error instead of a "Continue" button, and is never opened — neither on click
 * nor through the automatic redirect when the warning page is turned off.
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

const RedirectApp = require('../../../client/src/features/apps/pages/RedirectApp').default;

const redirectApp = redirectConfig => ({
  id: 'external-tool',
  type: 'redirect',
  name: { en: 'External tool' },
  description: { en: 'Opens an external tool' },
  redirectConfig
});

let windowOpen;

beforeEach(() => {
  windowOpen = jest.spyOn(window, 'open').mockReturnValue({});
});

afterEach(() => {
  windowOpen.mockRestore();
});

describe('RedirectApp', () => {
  test('opens an https URL in a new tab', () => {
    render(<RedirectApp app={redirectApp({ url: 'https://example.com/tool' })} />);

    fireEvent.click(screen.getByText('pages.redirectApp.continueButton'));

    expect(windowOpen).toHaveBeenCalledWith(
      'https://example.com/tool',
      '_blank',
      'noopener,noreferrer'
    );
    expect(screen.queryByText('pages.redirectApp.invalidUrl')).not.toBeInTheDocument();
  });

  test('redirects automatically to an http URL when the warning is off', () => {
    render(
      <RedirectApp app={redirectApp({ url: 'http://intranet.example.com/', showWarning: false })} />
    );

    expect(windowOpen).toHaveBeenCalledWith(
      'http://intranet.example.com/',
      '_blank',
      'noopener,noreferrer'
    );
  });

  test.each([
    'javascript:void(0)',
    'data:text/html,hello',
    'file:///etc/hosts',
    'mailto:someone@example.com'
  ])('shows an error and opens nothing for %s', url => {
    render(<RedirectApp app={redirectApp({ url })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('pages.redirectApp.invalidUrl');
    expect(screen.queryByText('pages.redirectApp.continueButton')).not.toBeInTheDocument();
    expect(windowOpen).not.toHaveBeenCalled();
  });

  test('does not redirect automatically to a non-http URL when the warning is off', () => {
    render(<RedirectApp app={redirectApp({ url: 'javascript:void(0)', showWarning: false })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('pages.redirectApp.invalidUrl');
    expect(windowOpen).not.toHaveBeenCalled();
  });

  test('shows the error when no URL is configured', () => {
    render(<RedirectApp app={redirectApp(undefined)} />);

    expect(screen.getByRole('alert')).toHaveTextContent('pages.redirectApp.invalidUrl');
    expect(windowOpen).not.toHaveBeenCalled();
  });
});
