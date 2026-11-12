// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the provider embedded in a stored picture (EU AI Act Art. 50(2)): the
 * Content Credentials the file carries, asked for when the details are opened.
 * Worded as the server's reader promises: the signature matches the file or not,
 * trust is not evaluated, nothing says "authentic".
 */
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) =>
      (typeof fallback === 'string' ? fallback : key).replace(
        /{{(\w+)}}/g,
        (_, name) => options?.[name]
      ),
    i18n: { language: 'en' }
  })
}));

const mockFetchChatArtifactProvenance = jest.fn();
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  fetchChatArtifactProvenance: (...args) => mockFetchChatArtifactProvenance(...args)
}));

const ProviderMark = require('../../../client/src/features/chat/components/ProviderMark').default;
const {
  ArtifactProvenanceFetchContext
} = require('../../../client/src/features/chat/contexts/ArtifactProvenanceFetchContext');

const mark = (c2pa, xmp = {}) => ({
  outputId: '01JC0000000000000000000000',
  providerMarking: {
    c2pa: {
      present: false,
      status: 'absent',
      valid: null,
      issuer: null,
      digitalSourceType: null,
      claimGenerator: null,
      signedAt: null,
      trust: 'not-evaluated',
      ...c2pa
    },
    xmp: { digitalSourceType: null, ...xmp },
    declared: 'synthid'
  }
});

const renderMark = (props = { chatId: 'c1', artifactId: 'a1' }, fetcher = null) =>
  render(
    <ArtifactProvenanceFetchContext.Provider value={fetcher}>
      <dl>
        <ProviderMark {...props} />
      </dl>
    </ArtifactProvenanceFetchContext.Provider>
  );

beforeEach(() => mockFetchChatArtifactProvenance.mockReset());

describe('a picture with Content Credentials', () => {
  it('shows signer, tool, time and source type, and that trust is not evaluated', async () => {
    mockFetchChatArtifactProvenance.mockResolvedValue(
      mark({
        present: true,
        status: 'present',
        valid: true,
        issuer: 'Google LLC',
        claimGenerator: 'Gemini 3',
        signedAt: '2026-11-11T09:00:00Z',
        digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia'
      })
    );
    renderMark();
    expect(await screen.findByTestId('provider-mark-status')).toHaveTextContent(
      'Found in the file'
    );
    expect(mockFetchChatArtifactProvenance).toHaveBeenCalledWith('c1', 'a1');
    expect(screen.getByText('The signature matches the file.')).toBeInTheDocument();
    expect(screen.getByText('Google LLC')).toBeInTheDocument();
    expect(screen.getByText('Gemini 3')).toBeInTheDocument();
    expect(screen.getByText('Created by an AI model')).toBeInTheDocument();
    expect(
      screen.getByText('iHub does not check whether the signer is trusted.')
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/authentic|verified|genuine/i);
  });

  it('says so when the signature no longer matches the file', async () => {
    mockFetchChatArtifactProvenance.mockResolvedValue(
      mark({ present: true, status: 'present', valid: false })
    );
    renderMark();
    expect(await screen.findByTestId('provider-mark-invalid')).toHaveTextContent(
      'does not match the file'
    );
  });
});

describe('a picture without', () => {
  it('says there are none, and shows embedded metadata that marks it as AI', async () => {
    mockFetchChatArtifactProvenance.mockResolvedValue(
      mark(
        {},
        {
          digitalSourceType:
            'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia'
        }
      )
    );
    renderMark();
    expect(await screen.findByTestId('provider-mark-status')).toHaveTextContent('None in the file');
    expect(screen.getByText('Embedded metadata')).toBeInTheDocument();
    expect(screen.getByText('Created by an AI model')).toBeInTheDocument();
    expect(
      screen.queryByText('iHub does not check whether the signer is trusted.')
    ).not.toBeInTheDocument();
  });
});

describe('when there is nothing to show', () => {
  it('renders nothing while the answer is on its way and when none is kept', async () => {
    mockFetchChatArtifactProvenance.mockRejectedValue(new Error('404'));
    const { container } = renderMark();
    expect(container.querySelector('dl')).toBeEmptyDOMElement();
    await waitFor(() => expect(mockFetchChatArtifactProvenance).toHaveBeenCalled());
    expect(container.querySelector('dl')).toBeEmptyDOMElement();
  });

  it('asks for nothing without a stored picture', () => {
    const { container } = renderMark({ chatId: 'c1', artifactId: undefined });
    expect(mockFetchChatArtifactProvenance).not.toHaveBeenCalled();
    expect(container.querySelector('dl')).toBeEmptyDOMElement();
  });
});

describe('a shared chat', () => {
  it('asks through the route its page provides, not the owner’s', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValue(mark({ present: true, status: 'present', valid: true, issuer: 'Acme' }));
    renderMark({ chatId: 'c1', artifactId: 'a9' }, fetcher);
    expect(await screen.findByText('Acme')).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith('c1', 'a9');
    expect(mockFetchChatArtifactProvenance).not.toHaveBeenCalled();
  });
});
