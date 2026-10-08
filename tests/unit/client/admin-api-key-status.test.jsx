/**
 * The admin UI's view of a model's / provider's API key: a badge per state and
 * the hook that reads it from the server. The one that matters is an unreadable
 * stored key — it looks configured, but the server cannot decrypt it — which has
 * to read as a problem and say what to do, not as "Configured".
 */
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';

const mockMakeAdminApiCall = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args)
}));

const t = (key, fallback, options) => {
  const template = typeof fallback === 'string' ? fallback : key;
  const vars = (typeof fallback === 'object' ? fallback : options) || {};
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    name in vars ? String(vars[name]) : match
  );
};
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t, i18n: { language: 'en' } })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));

import ApiKeyStatusBadge from '../../../client/src/features/admin/components/ApiKeyStatusBadge';
import useApiKeyStatus from '../../../client/src/features/admin/hooks/useApiKeyStatus';

describe('ApiKeyStatusBadge', () => {
  it('renders nothing without a status', () => {
    const { container } = render(<ApiKeyStatusBadge status={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a state it does not know', () => {
    const { container } = render(<ApiKeyStatusBadge status={{ state: 'something-new' }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows where a found key comes from', () => {
    render(
      <ApiKeyStatusBadge
        status={{ state: 'ok', source: 'env', envVar: 'LLMHUB_API_KEY' }}
        detailed
      />
    );
    expect(screen.getByText('Key found')).toBeInTheDocument();
    expect(screen.getByText('environment variable LLMHUB_API_KEY')).toBeInTheDocument();
  });

  it('says a keyless server needs no key', () => {
    render(<ApiKeyStatusBadge status={{ state: 'keyless', source: 'none', envVar: null }} />);
    expect(screen.getByTestId('api-key-status')).toHaveAttribute('data-state', 'keyless');
    expect(screen.getByText('No key needed')).toBeInTheDocument();
  });

  it('flags a stored key the server cannot decrypt, and says what to do', () => {
    render(
      <ApiKeyStatusBadge
        status={{ state: 'undecryptable', source: 'model', envVar: null }}
        detailed
      />
    );
    expect(screen.getByText('Stored key unreadable')).toBeInTheDocument();
    expect(screen.getByText(/Enter the key again/)).toBeInTheDocument();
    expect(screen.getByText(/TOKEN_ENCRYPTION_KEY/)).toBeInTheDocument();
    expect(screen.queryByText('Key found')).not.toBeInTheDocument();
  });

  it('flags a missing key', () => {
    render(<ApiKeyStatusBadge status={{ state: 'missing', source: 'none', envVar: null }} />);
    expect(screen.getByText('No API key')).toBeInTheDocument();
  });
});

function Probe({ kind }) {
  const { statuses, loading } = useApiKeyStatus(kind);
  return (
    <div data-testid="probe" data-loading={String(loading)}>
      {JSON.stringify(statuses)}
    </div>
  );
}

describe('useApiKeyStatus', () => {
  beforeEach(() => {
    mockMakeAdminApiCall.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('reads the status of the models', async () => {
    mockMakeAdminApiCall.mockResolvedValue({
      data: { statuses: { gpt: { state: 'ok', source: 'model', envVar: null } } }
    });
    render(<Probe kind="models" />);
    await waitFor(() =>
      expect(screen.getByTestId('probe')).toHaveAttribute('data-loading', 'false')
    );
    expect(mockMakeAdminApiCall).toHaveBeenCalledWith('/admin/models/_key-status');
    expect(screen.getByTestId('probe')).toHaveTextContent('"gpt"');
  });

  it('reads the status of the providers', async () => {
    mockMakeAdminApiCall.mockResolvedValue({ data: { statuses: {} } });
    render(<Probe kind="providers" />);
    await waitFor(() =>
      expect(mockMakeAdminApiCall).toHaveBeenCalledWith('/admin/providers/_key-status')
    );
  });

  it('stays empty, without raising, when the server cannot be asked', async () => {
    mockMakeAdminApiCall.mockRejectedValue(new Error('network'));
    render(<Probe kind="models" />);
    await waitFor(() =>
      expect(screen.getByTestId('probe')).toHaveAttribute('data-loading', 'false')
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('{}');
  });
});
