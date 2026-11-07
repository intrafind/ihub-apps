import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import LlmTimeoutsCard from '../../../client/src/features/admin/components/LlmTimeoutsCard';
import ProviderTimeoutFields from '../../../client/src/features/admin/components/ProviderTimeoutFields';
import { makeAdminApiCall } from '../../../client/src/api/adminApi';

/**
 * The installation-wide timeouts card (Admin → Providers) and the per-provider
 * fields: an empty field means "inherit" and is sent as null / left out, a typed
 * number (0 included) is sent as is.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, values) => {
      if (typeof fallback !== 'string') return key;
      return fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values?.[name] ?? ''));
    },
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: jest.fn(),
  getAdminApiErrorMessage: err => `API error: ${err.message}`
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span />
}));

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

/** The card starts collapsed to a summary line; Edit opens its fields. */
const openCard = () => fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

const payload = (saved = {}) => ({
  data: {
    saved,
    defaults: { connectTimeoutMs: 30000, streamIdleTimeoutMs: 60000 },
    effective: { connectTimeoutMs: 30000, streamIdleTimeoutMs: 60000, ...saved }
  }
});

describe('LlmTimeoutsCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the saved values, with the defaults as placeholders for unset ones', async () => {
    makeAdminApiCall.mockResolvedValue(payload({ connectTimeoutMs: 45000 }));
    render(<LlmTimeoutsCard />);
    await flush();
    openCard();

    expect(screen.getByLabelText('Connect timeout (ms)')).toHaveValue(45000);
    const idle = screen.getByLabelText('Stream idle timeout (ms)');
    expect(idle).toHaveValue(null);
    expect(idle).toHaveAttribute('placeholder', '60000');
  });

  it('starts collapsed to one summary line and opens with Edit', async () => {
    makeAdminApiCall.mockResolvedValue(payload({ streamIdleTimeoutMs: 0 }));
    render(<LlmTimeoutsCard />);
    await flush();

    expect(screen.getByTestId('llm-timeouts-summary')).toHaveTextContent(
      'connect 30 s · stream idle off'
    );
    expect(screen.getByLabelText('Connect timeout (ms)')).not.toBeVisible();
    const toggle = screen.getByRole('button', { name: 'Edit' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(screen.getByLabelText('Connect timeout (ms)')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows a failed load next to the title even while collapsed', async () => {
    makeAdminApiCall.mockRejectedValue(new Error('boom'));
    render(<LlmTimeoutsCard />);
    await flush();

    expect(screen.getByRole('alert')).toHaveTextContent('API error: boom');
    expect(screen.queryByTestId('llm-timeouts-summary')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeVisible();
  });

  it('keeps Save disabled until something changes', async () => {
    makeAdminApiCall.mockResolvedValue(payload());
    render(<LlmTimeoutsCard />);
    await flush();
    openCard();

    const save = screen.getByRole('button', { name: 'Save timeouts' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Stream idle timeout (ms)'), {
      target: { value: '180000' }
    });
    expect(save).toBeEnabled();
  });

  it('sends a number for a filled field and null for an empty one', async () => {
    makeAdminApiCall.mockResolvedValueOnce(payload({ connectTimeoutMs: 45000 }));
    render(<LlmTimeoutsCard />);
    await flush();
    openCard();

    makeAdminApiCall.mockResolvedValueOnce(payload({ streamIdleTimeoutMs: 0 }));
    fireEvent.change(screen.getByLabelText('Connect timeout (ms)'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Stream idle timeout (ms)'), {
      target: { value: '0' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save timeouts' }));
    await flush();

    expect(makeAdminApiCall).toHaveBeenLastCalledWith('/admin/llm-timeouts', {
      method: 'PUT',
      body: { connectTimeoutMs: null, streamIdleTimeoutMs: 0 }
    });
    expect(screen.getByRole('status')).toHaveTextContent('Timeouts saved');
    expect(screen.getByLabelText('Stream idle timeout (ms)')).toHaveValue(0);
  });

  it('shows the server error and keeps the typed value when saving fails', async () => {
    makeAdminApiCall.mockResolvedValueOnce(payload());
    render(<LlmTimeoutsCard />);
    await flush();
    openCard();

    makeAdminApiCall.mockRejectedValueOnce(new Error('too large'));
    fireEvent.change(screen.getByLabelText('Connect timeout (ms)'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save timeouts' }));
    await flush();

    expect(screen.getByRole('alert')).toHaveTextContent('API error: too large');
    expect(screen.getByLabelText('Connect timeout (ms)')).toHaveValue(5);
  });
});

describe('ProviderTimeoutFields', () => {
  const inherited = { connectTimeoutMs: 30000, streamIdleTimeoutMs: 60000 };

  it('shows the provider value, or the inherited one as placeholder and hint', () => {
    render(
      <ProviderTimeoutFields
        data={{ streamIdleTimeoutMs: 180000 }}
        onChange={() => {}}
        inherited={inherited}
      />
    );
    expect(screen.getByLabelText('Stream idle timeout (ms)')).toHaveValue(180000);
    const connect = screen.getByLabelText('Connect timeout (ms)');
    expect(connect).toHaveValue(null);
    expect(connect).toHaveAttribute('placeholder', '30000');
    expect(screen.getByText('Inherited: 30000 ms (installation)')).toBeInTheDocument();
  });

  it('reports a number, 0 included, and undefined when the field is emptied', () => {
    const onChange = jest.fn();
    render(
      <ProviderTimeoutFields
        data={{ connectTimeoutMs: 1000 }}
        onChange={onChange}
        inherited={inherited}
      />
    );
    fireEvent.change(screen.getByLabelText('Stream idle timeout (ms)'), {
      target: { value: '0' }
    });
    expect(onChange).toHaveBeenLastCalledWith('streamIdleTimeoutMs', 0);
    fireEvent.change(screen.getByLabelText('Connect timeout (ms)'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith('connectTimeoutMs', undefined);
  });
});
