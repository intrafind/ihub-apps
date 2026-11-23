// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * AI-B10: a failed model test or import says what happened and what to check —
 * the upstream HTTP status, the host and the error code the server sent, a
 * translated remediation per cause, and for an untrusted certificate a link to
 * the SSL / TLS settings (domain whitelist).
 */
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';

const mockTexts = {
  'admin.connectionErrors.remediation.serverError': 'Der Endpunkt selbst ist fehlgeschlagen.',
  'admin.connectionErrors.facts.host': 'Host: {{host}}'
};
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) => {
      const text = mockTexts[key] ?? (typeof fallback === 'string' ? fallback : key);
      return Object.entries(options || {}).reduce(
        (out, [name, value]) => out.replace(`{{${name}}}`, value),
        text
      );
    }
  })
}));

import ConnectionErrorDetails from '../../../client/src/features/admin/components/ConnectionErrorDetails';
import {
  describeConnectionError,
  SSL_SETTINGS_PATH
} from '../../../client/src/features/admin/utils/connectionErrorHelp';
import { translateDiscoveryError } from '../../../client/src/features/admin/utils/modelImport';
import { translateModelTestMessage } from '../../../client/src/features/admin/utils/modelTestMessages';

const t = (key, fallback, options) => {
  const text = mockTexts[key] ?? (typeof fallback === 'string' ? fallback : key);
  return Object.entries(options || {}).reduce(
    (out, [name, value]) => out.replace(`{{${name}}}`, value),
    text
  );
};

describe('describeConnectionError', () => {
  it('names the upstream status, the host and the code', () => {
    const help = describeConnectionError(t, {
      messageKey: 'networkError',
      upstreamStatus: 502,
      host: 'llm.example.com:8443',
      errorCode: 'ECONNRESET'
    });
    expect(help.facts).toBe('HTTP 502 · Host: llm.example.com:8443 · Code: ECONNRESET');
  });

  it('translates the remediation of a known cause instead of the English server text', () => {
    const help = describeConnectionError(t, {
      messageKey: 'serverError',
      remediation: 'The model service itself failed to answer.'
    });
    expect(help.remediation).toBe('Der Endpunkt selbst ist fehlgeschlagen.');
  });

  it('keeps the server text for a cause without its own line, else the fallback', () => {
    expect(
      describeConnectionError(t, {
        messageKey: 'redirected',
        remediation: 'It points to https://elsewhere/v1. Enter that URL instead.'
      }).remediation
    ).toBe('It points to https://elsewhere/v1. Enter that URL instead.');
    expect(describeConnectionError(t, null, 'HTTP 500').remediation).toBe('HTTP 500');
  });

  it('separates a rejected key, a key that is needed and a wrong path', () => {
    const text = key => describeConnectionError(t, { messageKey: key }).remediation;
    expect(text('authenticationFailed')).toMatch(/rejected the API key/);
    expect(text('accessDenied')).toMatch(/does not allow/);
    expect(text('apiKeyRequired')).toMatch(/asks for an API key/);
    expect(text('apiKeyRequired')).not.toMatch(/rejected/);
    expect(text('modelNotFound')).toMatch(/Check the path/);
    expect(text('notFound')).toMatch(/\/v1\/models/);
  });

  it('points an untrusted certificate at the SSL whitelist', () => {
    const help = describeConnectionError(t, {
      messageKey: 'certificateUntrusted',
      errorCode: 'SELF_SIGNED_CERT_IN_CHAIN',
      host: 'llm.corp.local'
    });
    expect(help.showSslSettingsLink).toBe(true);
    expect(help.remediation).toMatch(/SSL domain whitelist/);
    expect(help.facts).toContain('SELF_SIGNED_CERT_IN_CHAIN');
  });

  it('translates the new headlines of the model test and the import', () => {
    const keyOnly = key => key;
    expect(translateModelTestMessage(keyOnly, 'certificateUntrusted', 'x')).toBe(
      'admin.models.testResults.messages.certificateUntrusted'
    );
    expect(translateModelTestMessage(keyOnly, 'apiKeyRequired', 'x')).toBe(
      'admin.models.testResults.messages.apiKeyRequired'
    );
    expect(translateDiscoveryError(keyOnly, 'serverError', 'HTTP 502')).toBe(
      'admin.models.import.errors.serverError'
    );
    expect(translateDiscoveryError(keyOnly, 'certificateUntrusted', 'x')).toBe(
      'admin.models.import.errors.certificateUntrusted'
    );
  });
});

describe('ConnectionErrorDetails', () => {
  it('links to the SSL / TLS settings for an untrusted certificate', () => {
    render(
      <MemoryRouter>
        <ConnectionErrorDetails
          details={{ messageKey: 'certificateUntrusted', host: 'llm.corp.local' }}
        />
      </MemoryRouter>
    );
    const link = screen.getByRole('link', { name: 'Open the SSL / TLS settings' });
    expect(link).toHaveAttribute('href', SSL_SETTINGS_PATH);
    expect(screen.getByText('Host: llm.corp.local')).toBeInTheDocument();
  });

  it('shows no link for other causes and nothing when there is nothing to say', () => {
    const { container, rerender } = render(
      <MemoryRouter>
        <ConnectionErrorDetails details={{ messageKey: 'serverError', upstreamStatus: 503 }} />
      </MemoryRouter>
    );
    expect(screen.getByText('HTTP 503')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <ConnectionErrorDetails details={null} />
      </MemoryRouter>
    );
    expect(container).toBeEmptyDOMElement();
  });
});
