import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const interpolate = (text, options) =>
  String(text).replace(/{{(\w+)}}/g, (_, name) => String(options?.[name] ?? ''));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, options) => {
      if (typeof options === 'string') return options;
      if (options && typeof options === 'object') {
        return interpolate(options.defaultValue ?? key, options);
      }
      return key;
    },
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/components/Icon', () => {
  return function Icon({ name }) {
    return <span data-testid={`icon-${name}`} />;
  };
});

jest.mock('../../../client/src/api/client', () => ({
  __esModule: true,
  apiClient: { get: jest.fn(), post: jest.fn() }
}));

jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  __esModule: true,
  buildAssetUrl: path => path,
  buildApiUrl: path => `/api/${path}`
}));

jest.mock('../../../client/src/api/endpoints/provenance', () => ({
  __esModule: true,
  fetchProvenanceInfo: jest.fn(),
  verifyProvenanceContent: jest.fn(),
  verifySignedReport: jest.fn()
}));

import VerifyPage from '../../../client/src/features/verify/pages/VerifyPage';
import {
  fetchProvenanceInfo,
  verifyProvenanceContent
} from '../../../client/src/api/endpoints/provenance';

/**
 * The public `/verify` page (EU AI Act Art. 50(2), issue #2573): it opens
 * without a session, tells a visitor why it cannot help when access is
 * restricted, and names the technique that found a mark.
 */

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/verify']}>
      <VerifyPage />
    </MemoryRouter>
  );

const readyInfo = {
  enabled: true,
  access: 'public',
  canVerify: true,
  reason: null,
  canUseTextDetection: false,
  maxUploadMB: 20,
  techniques: ['c2pa', 'text-signpost']
};

afterEach(() => jest.clearAllMocks());

describe('VerifyPage', () => {
  it('says detection is unavailable when the installation has it off', async () => {
    fetchProvenanceInfo.mockResolvedValue({ enabled: false, canVerify: false, reason: 'disabled' });
    renderPage();
    expect(
      Boolean(await screen.findByText('Detection is not available on this installation'))
    ).toBeTruthy();
  });

  it('links to the sign-in page when the detector needs a session', async () => {
    fetchProvenanceInfo.mockResolvedValue({
      ...readyInfo,
      access: 'authenticated',
      canVerify: false,
      reason: 'authentication-required'
    });
    renderPage();
    const link = await screen.findByRole('link', { name: /Sign in/ });
    expect(link.getAttribute('href')).toMatch(/^\/login\?returnUrl=/);
  });

  it('explains missing access for a signed-in user without it', async () => {
    fetchProvenanceInfo.mockResolvedValue({ ...readyInfo, canVerify: false, reason: 'forbidden' });
    renderPage();
    expect(Boolean(await screen.findByText('You do not have access to the detector'))).toBeTruthy();
  });

  it('checks pasted text and names the technique that found the mark', async () => {
    fetchProvenanceInfo.mockResolvedValue(readyInfo);
    verifyProvenanceContent.mockResolvedValue({
      result: {
        verdict: 'ai-generated',
        aiGenerated: true,
        techniques: [
          {
            technique: 'text-signpost',
            label: 'C2PA text signpost',
            found: true,
            valid: true,
            trusted: true,
            detail: 'Signed signpost of this installation'
          },
          {
            technique: 'text-watermark',
            label: 'Text watermark',
            found: false,
            valid: null,
            trusted: null,
            detail: 'Not checked',
            skipped: 'expert access required'
          }
        ],
        content: { sha256: 'abc123', mimeType: 'text/plain', size: 12, kind: 'text' },
        provenance: null,
        detector: { id: 'inst-1', installationUrl: 'https://ihub.example', version: '5.0.0' },
        checkedAt: '2026-09-30T10:00:00.000Z',
        summary: 'AI-generated: text signpost'
      },
      report: 'a.b.c',
      reportPayload: { typ: 'ihub-detection-report' }
    });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Pasted text/ }));
    fireEvent.change(screen.getByLabelText('Text to check'), {
      target: { value: 'Some generated text' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Check content/ }));

    await waitFor(() =>
      expect(verifyProvenanceContent).toHaveBeenCalledWith({ text: 'Some generated text' })
    );
    expect(Boolean(await screen.findByText('AI-generated'))).toBeTruthy();
    expect(Boolean(screen.getByText('Found by: C2PA text signpost'))).toBeTruthy();
    expect(Boolean(screen.getByText('Not checked: expert access required'))).toBeTruthy();
    expect(
      Boolean(screen.getByText(/does not prove that a person wrote the content/))
    ).toBeTruthy();
    expect(Boolean(screen.getByRole('button', { name: /Download signed report/ }))).toBeTruthy();
  });

  it('refuses a pasted value that is not a signed report', async () => {
    fetchProvenanceInfo.mockResolvedValue(readyInfo);
    renderPage();
    fireEvent.change(await screen.findByLabelText('Report'), {
      target: { value: 'hello' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Check report/ }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'This is not a verification report'
    );
  });
});
