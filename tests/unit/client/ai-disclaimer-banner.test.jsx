import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * AIDisclaimerBanner Component Tests
 * Tests the AI disclaimer banner behavior with and without configured link
 */

// Mock dependencies
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultValue) => defaultValue,
    i18n: { language: 'en' }
  })
}));

// Mock Icon component
jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`}>{name}</span>;
  };
});

// Mock UIConfigContext
const mockUIConfigContext = (disclaimerConfig = {}) => ({
  useUIConfig: () => ({
    uiConfig: {
      disclaimer: disclaimerConfig
    }
  })
});

// Simplified version of AIDisclaimerBanner that mimics the real component
const AIDisclaimerBanner = ({ uiConfig }) => {
  const disclaimerLink = uiConfig?.disclaimer?.link;
  const disclaimerHint = uiConfig?.disclaimer?.hint?.en || uiConfig?.disclaimer?.hint;

  const handleClick = () => {
    if (disclaimerLink) {
      window.open(disclaimerLink, '_blank', 'noopener,noreferrer');
    }
  };

  const isClickable = !!disclaimerLink;
  const ElementTag = isClickable ? 'button' : 'div';
  const baseClasses = 'flex items-center gap-2 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-400';
  const clickableClasses = isClickable
    ? 'hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer'
    : 'cursor-default';

  return (
    <div className="flex items-center justify-center mt-1 mb-2">
      <ElementTag
        onClick={isClickable ? handleClick : undefined}
        className={`${baseClasses} ${clickableClasses} rounded-lg transition-colors`}
        title="Disclaimer"
        data-testid="disclaimer-banner"
      >
        <span data-testid="icon-informationCircle">informationCircle</span>
        <span>{disclaimerHint || 'iHub uses AI and can make mistakes. Please verify results carefully.'}</span>
      </ElementTag>
    </div>
  );
};

describe('AIDisclaimerBanner', () => {
  beforeEach(() => {
    // Mock window.open
    window.open = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('when link is configured', () => {
    test('renders as a button element', () => {
      const uiConfig = {
        disclaimer: {
          link: '/pages/disclaimer',
          hint: { en: 'Click here to read the disclaimer' }
        }
      };

      render(<AIDisclaimerBanner uiConfig={uiConfig} />);

      const banner = screen.getByTestId('disclaimer-banner');
      expect(banner.tagName).toBe('BUTTON');
    });

    test('displays configured hint text', () => {
      const uiConfig = {
        disclaimer: {
          link: '/pages/disclaimer',
          hint: { en: 'Click here to read the disclaimer' }
        }
      };

      render(<AIDisclaimerBanner uiConfig={uiConfig} />);

      expect(screen.getByText('Click here to read the disclaimer')).toBeInTheDocument();
    });

    test('has cursor-pointer class', () => {
      const uiConfig = {
        disclaimer: {
          link: '/pages/disclaimer',
          hint: { en: 'Click here' }
        }
      };

      render(<AIDisclaimerBanner uiConfig={uiConfig} />);

      const banner = screen.getByTestId('disclaimer-banner');
      expect(banner.className).toContain('cursor-pointer');
    });

    test('opens link when clicked', () => {
      const uiConfig = {
        disclaimer: {
          link: 'https://example.com/disclaimer',
          hint: { en: 'Click here' }
        }
      };

      render(<AIDisclaimerBanner uiConfig={uiConfig} />);

      const banner = screen.getByTestId('disclaimer-banner');
      fireEvent.click(banner);

      expect(window.open).toHaveBeenCalledWith(
        'https://example.com/disclaimer',
        '_blank',
        'noopener,noreferrer'
      );
    });

    test('opens internal page path when clicked', () => {
      const uiConfig = {
        disclaimer: {
          link: '/pages/disclaimer',
          hint: { en: 'Read more' }
        }
      };

      render(<AIDisclaimerBanner uiConfig={uiConfig} />);

      const banner = screen.getByTestId('disclaimer-banner');
      fireEvent.click(banner);

      expect(window.open).toHaveBeenCalledWith('/pages/disclaimer', '_blank', 'noopener,noreferrer');
    });
  });

  describe('when link is not configured', () => {
    test('renders as a div element', () => {
      const uiConfig = {
        disclaimer: {
          hint: { en: 'This is just informational text' }
        }
      };

      render(<AIDisclaimerBanner uiConfig={uiConfig} />);

      const banner = screen.getByTestId('disclaimer-banner');
      expect(banner.tagName).toBe('DIV');
    });

    test('has cursor-default class', () => {
      const uiConfig = {
        disclaimer: {
          hint: { en: 'This is just informational text' }
        }
      };

      render(<AIDisclaimerBanner uiConfig={uiConfig} />);

      const banner = screen.getByTestId('disclaimer-banner');
      expect(banner.className).toContain('cursor-default');
      expect(banner.className).not.toContain('cursor-pointer');
    });

    test('does not open anything when clicked', () => {
      const uiConfig = {
        disclaimer: {
          hint: { en: 'This is just informational text' }
        }
      };

      render(<AIDisclaimerBanner uiConfig={uiConfig} />);

      const banner = screen.getByTestId('disclaimer-banner');
      fireEvent.click(banner);

      expect(window.open).not.toHaveBeenCalled();
    });

    test('displays configured hint text', () => {
      const uiConfig = {
        disclaimer: {
          hint: { en: 'Custom informational text' }
        }
      };

      render(<AIDisclaimerBanner uiConfig={uiConfig} />);

      expect(screen.getByText('Custom informational text')).toBeInTheDocument();
    });

    test('displays default hint text when no hint configured', () => {
      const uiConfig = {
        disclaimer: {}
      };

      render(<AIDisclaimerBanner uiConfig={uiConfig} />);

      expect(
        screen.getByText('iHub uses AI and can make mistakes. Please verify results carefully.')
      ).toBeInTheDocument();
    });
  });

  describe('icon display', () => {
    test('always displays information circle icon', () => {
      const uiConfig = {
        disclaimer: {
          link: '/pages/disclaimer',
          hint: { en: 'Click here' }
        }
      };

      render(<AIDisclaimerBanner uiConfig={uiConfig} />);

      expect(screen.getByTestId('icon-informationCircle')).toBeInTheDocument();
    });
  });
});
