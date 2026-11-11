// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

let mockLanguage = 'en';
let mockPlatformConfig = null;

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (key === 'aiDisclosure.firstTurnNotice' ? 'BUILT-IN' : fallback || key),
    i18n: { language: mockLanguage }
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({ name }) => (
  <span data-testid={`icon-${name}`} />
));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: mockPlatformConfig })
}));

import AiFirstTurnNotice from '../../../client/src/features/chat/components/AiFirstTurnNotice';
import { resolveFirstTurnNotice } from '../../../shared/aiDisclosure.js';

const platform = (firstTurnNotice = {}) => ({
  aiDisclosure: { firstTurnNotice: { enabled: true, text: {}, ...firstTurnNotice } }
});
const app = firstTurnNotice => ({ aiDisclosure: { firstTurnNotice } });

beforeEach(() => {
  mockLanguage = 'en';
  mockPlatformConfig = platform();
});

describe('resolveFirstTurnNotice', () => {
  const t = () => 'BUILT-IN';
  const resolve = (p, a, language = 'en') =>
    resolveFirstTurnNotice({ platform: p?.aiDisclosure, app: a, language, t });

  it('falls back to the built-in text', () => {
    expect(resolve(platform())).toEqual({ visible: true, text: 'BUILT-IN' });
    expect(resolve(undefined, undefined)).toEqual({ visible: true, text: 'BUILT-IN' });
  });

  it('platform text, app text wins over it', () => {
    const p = platform({ text: { en: 'platform', de: 'Plattform' } });
    expect(resolve(p, undefined, 'de').text).toBe('Plattform');
    expect(resolve(p, app({ text: { en: 'app' } }), 'de').text).toBe('app'); // app en before platform de
    expect(resolve(p, app({ text: { en: 'app', de: 'App' } }), 'de').text).toBe('App');
  });

  it('uses the base language, then en; ignores blank entries', () => {
    expect(resolve(platform({ text: { de: 'D' } }), undefined, 'de-AT').text).toBe('D');
    expect(resolve(platform({ text: { en: 'E', de: '   ' } }), undefined, 'de').text).toBe('E');
  });

  it('global off is a master switch an app cannot override', () => {
    expect(
      resolve(platform({ enabled: false }), app({ enabled: true, text: { en: 'x' } }))
    ).toEqual({ visible: false, text: '' });
  });

  it('an app can turn its notice off', () => {
    expect(resolve(platform(), app({ enabled: false })).visible).toBe(false);
  });
});

describe('AiFirstTurnNotice', () => {
  it('renders the built-in text as a note, not a live region', () => {
    render(<AiFirstTurnNotice app={{}} />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('BUILT-IN');
    expect(note).not.toHaveAttribute('aria-live');
  });

  it('renders nothing before the platform config has loaded', () => {
    mockPlatformConfig = null;
    const { container } = render(<AiFirstTurnNotice app={{}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when disabled globally or for the app', () => {
    mockPlatformConfig = platform({ enabled: false });
    const { container, rerender } = render(<AiFirstTurnNotice app={{}} />);
    expect(container).toBeEmptyDOMElement();
    mockPlatformConfig = platform();
    rerender(<AiFirstTurnNotice app={app({ enabled: false })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the app override in the current language', () => {
    mockLanguage = 'de';
    render(<AiFirstTurnNotice app={app({ text: { en: 'App EN', de: 'App DE' } })} />);
    expect(screen.getByRole('note')).toHaveTextContent('App DE');
  });

  it('allows links and strips scripts', () => {
    mockPlatformConfig = platform({
      text: {
        en: 'See [policy](https://example.com/p) <script>alert(1)</script><img src=x onerror=alert(1)>'
      }
    });
    const { container } = render(<AiFirstTurnNotice app={{}} />);
    expect(screen.getByRole('link', { name: 'policy' })).toHaveAttribute(
      'href',
      'https://example.com/p'
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img[onerror]')).toBeNull();
  });
});
