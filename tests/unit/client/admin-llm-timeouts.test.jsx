import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import LlmTimeoutsCard from '../../../client/src/features/admin/components/LlmTimeoutsCard';
import {
  SaveSectionsBar,
  SaveSectionsProvider
} from '../../../client/src/features/admin/components/SaveSections';
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

/** The card sits on the Providers page, whose bar saves it. */
const renderCard = () =>
  render(
    <SaveSectionsProvider>
      <LlmTimeoutsCard />
      <SaveSectionsBar />
    </SaveSectionsProvider>
  );

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
    renderCard();
    await flush();
    openCard();

    expect(screen.getByLabelText('Connect timeout (ms)')).toHaveValue(45000);
    const idle = screen.getByLabelText('Stream idle timeout (ms)');
    expect(idle).toHaveValue(null);
    expect(idle).toHaveAttribute('placeholder', '60000');
  });

  it('starts collapsed to one summary line and opens with Edit', async () => {
    makeAdminApiCall.mockResolvedValue(payload({ streamIdleTimeoutMs: 0 }));
    renderCard();
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
    renderCard();
    await flush();

    expect(screen.getByRole('alert')).toHaveTextContent('API error: boom');
    expect(screen.queryByTestId('llm-timeouts-summary')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeVisible();
  });

  it('shows a failed load once, with a visible Retry, and no Edit (R7)', async () => {
    makeAdminApiCall.mockRejectedValueOnce(new Error('boom'));
    renderCard();
    await flush();

    // One alert, also counting hidden ones (the collapsed body).
    expect(screen.getAllByRole('alert', { hidden: true })).toHaveLength(1);
    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(retry).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();

    makeAdminApiCall.mockResolvedValueOnce(payload());
    await act(async () => {
      fireEvent.click(retry);
    });
    await flush();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('llm-timeouts-summary')).toBeInTheDocument();
    openCard();
    expect(screen.getByLabelText('Connect timeout (ms)')).toBeVisible();
  });

  it('shows the save bar only once something changed', async () => {
    makeAdminApiCall.mockResolvedValue(payload());
    renderCard();
    await flush();
    openCard();

    // No Save of its own, and no bar until something changes.
    expect(screen.queryByRole('button', { name: 'Save timeouts' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Save changes' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Stream idle timeout (ms)'), {
      target: { value: '180000' }
    });
    expect(screen.getByRole('region', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('sends a number for a filled field and null for an empty one', async () => {
    makeAdminApiCall.mockResolvedValueOnce(payload({ connectTimeoutMs: 45000 }));
    renderCard();
    await flush();
    openCard();

    makeAdminApiCall.mockResolvedValueOnce(payload({ streamIdleTimeoutMs: 0 }));
    fireEvent.change(screen.getByLabelText('Connect timeout (ms)'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Stream idle timeout (ms)'), {
      target: { value: '0' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await flush();

    expect(makeAdminApiCall).toHaveBeenLastCalledWith('/admin/llm-timeouts', {
      method: 'PUT',
      body: { connectTimeoutMs: null, streamIdleTimeoutMs: 0 }
    });
    expect(screen.getByRole('status')).toHaveTextContent('Timeouts saved');
    expect(screen.getByLabelText('Stream idle timeout (ms)')).toHaveValue(0);
    expect(screen.queryByRole('region', { name: 'Save changes' })).not.toBeInTheDocument();
  });

  it('shows the server error and keeps the typed value when saving fails', async () => {
    makeAdminApiCall.mockResolvedValueOnce(payload());
    renderCard();
    await flush();
    openCard();

    makeAdminApiCall.mockRejectedValueOnce(new Error('too large'));
    fireEvent.change(screen.getByLabelText('Connect timeout (ms)'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await flush();

    // The bar stays, names the error, and the typed value stays for a retry.
    expect(screen.getByTestId('save-bar-message')).toHaveTextContent('API error: too large');
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled();
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
