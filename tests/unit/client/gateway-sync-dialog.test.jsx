// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { render, screen, fireEvent, act, within } from '@testing-library/react';
import '@testing-library/jest-dom';

/**
 * "Sync with gateway": the admin sees what is new on the gateway, what changed
 * and what is gone, picks, and only the pick is applied. Nothing is written by
 * opening the dialog.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) => {
      const text = typeof fallback === 'string' ? fallback : key;
      return Object.entries(options || {}).reduce(
        (out, [name, value]) => out.replace(`{{${name}}}`, value),
        text
      );
    },
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const mockApi = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockApi(...args),
  getAdminApiErrorMessage: err => err?.message || 'failed'
}));

const GatewaySyncDialog =
  require('../../../client/src/features/admin/components/GatewaySyncDialog').default;

const DRIFT = {
  modelsUrl: 'https://gw/v1/gateway/models',
  items: [
    {
      kind: 'changed',
      remoteId: 'qwen3-vl',
      modelId: 'gw-qwen',
      changes: [
        { field: 'contextWindow', from: 4096, to: 32768 },
        { field: 'supportsVision', from: false, to: true }
      ]
    },
    {
      kind: 'added',
      remoteId: 'mistral-large-3',
      name: 'mistral-large-3',
      model: { id: 'gw-mistral-large-3', modelId: 'mistral-large-3', provider: 'mistral' }
    },
    { kind: 'removed', remoteId: 'retired', modelId: 'gw-retired', reason: 'missing' },
    { kind: 'removed', remoteId: 'embedding-now', modelId: 'gw-emb', reason: 'unsupported' }
  ]
};

/**
 * Answers the drift read and the sync; `sync` computes the answer from the picks
 * it receives (default: every pick is applied).
 */
function setup(drift = DRIFT, sync = picks => picks.map(pick => ({ ...pick, status: 'applied' }))) {
  mockApi.mockImplementation(async (path, options = {}) => {
    if (path.endsWith('/_model-drift')) return { data: drift };
    if (path.endsWith('/_sync-models')) return { data: { items: sync(options.body.items) } };
    return { data: {} };
  });
}

const writes = () =>
  mockApi.mock.calls.filter(([path, options]) => options?.method && !path.endsWith('_model-drift'));

async function open(props = {}) {
  const onClose = jest.fn();
  const onSynced = jest.fn();
  await act(async () => {
    render(
      <GatewaySyncDialog providerId="ifinder-gw" onClose={onClose} onSynced={onSynced} {...props} />
    );
  });
  return { onClose, onSynced };
}

beforeEach(() => mockApi.mockReset());

test('asks the gateway for the drift of the provider and writes nothing', async () => {
  setup();
  await open();
  expect(mockApi).toHaveBeenCalledWith('/admin/providers/ifinder-gw/_model-drift');
  expect(writes()).toHaveLength(0);
});

test('shows what changed, what is new and what is gone, with the old and new values', async () => {
  setup();
  await open();

  expect(screen.getByRole('heading', { name: /Changed on the gateway \(1\)/ })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /New on the gateway \(1\)/ })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /No longer available \(2\)/ })).toBeInTheDocument();

  expect(screen.getByText(/4096/)).toBeInTheDocument();
  expect(screen.getByText(/32768/)).toBeInTheDocument();
  expect(screen.getByText('mistral-large-3 → imported as gw-mistral-large-3')).toBeInTheDocument();
  expect(screen.getByText('The gateway no longer lists this model.')).toBeInTheDocument();
  expect(
    screen.getByText('The gateway now lists this model as something iHub cannot run.')
  ).toBeInTheDocument();
  expect(screen.getByText(/disabled, not deleted/)).toBeInTheDocument();
});

test('every item starts ticked and the button counts them', async () => {
  setup();
  await open();
  expect(screen.getAllByRole('checkbox').every(box => box.checked)).toBe(true);
  expect(screen.getByRole('button', { name: 'Apply 4' })).toBeEnabled();
});

test('sends only what is still ticked, then reports and tells the page', async () => {
  setup();
  const { onSynced } = await open();

  // Keep the new model and the update; leave both gone models alone.
  fireEvent.click(screen.getByRole('checkbox', { name: /retired/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /gw-emb/ }));
  expect(screen.getByRole('button', { name: 'Apply 2' })).toBeEnabled();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Apply 2' }));
  });

  // One request, carrying the picks and nothing else: the server decides what to write.
  expect(writes()).toHaveLength(1);
  const [path, options] = writes()[0];
  expect(path).toBe('/admin/providers/ifinder-gw/_sync-models');
  expect(options.method).toBe('POST');
  expect(options.body).toEqual({
    items: [
      { kind: 'changed', remoteId: 'qwen3-vl' },
      { kind: 'added', remoteId: 'mistral-large-3' }
    ]
  });

  expect(screen.getByText('2 applied, 0 not applied.')).toBeInTheDocument();
  expect(onSynced).toHaveBeenCalledTimes(1);
  // The header's close button and the footer's: Apply is gone, only Close is left.
  expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(2);
  expect(screen.queryByRole('button', { name: /Apply/ })).not.toBeInTheDocument();
});

test('a gone model is sent as a pick, and nothing is ever deleted', async () => {
  setup({ ...DRIFT, items: [DRIFT.items[2]] });
  await open();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Apply 1' }));
  });
  expect(writes()).toHaveLength(1);
  expect(writes()[0][1].body).toEqual({ items: [{ kind: 'removed', remoteId: 'retired' }] });
  expect(mockApi.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false);
});

test('cannot apply with nothing ticked', async () => {
  setup();
  await open();
  for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box);
  expect(screen.getByRole('button', { name: 'Apply 0' })).toBeDisabled();
});

test('says so when the models are in sync, and offers only Close', async () => {
  setup({ modelsUrl: 'x', items: [] });
  const { onClose } = await open();
  expect(screen.getByText('The models are in sync with the gateway.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Apply/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).pop());
  expect(onClose).toHaveBeenCalled();
});

test('an item the server could not apply is named with its reason; the rest went through', async () => {
  setup(DRIFT, picks =>
    picks.map(pick =>
      pick.kind === 'added'
        ? {
            ...pick,
            status: 'failed',
            detail: 'A model with the id gw-mistral-large-3 already exists'
          }
        : { ...pick, status: 'applied' }
    )
  );
  const { onSynced } = await open();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Apply 4' }));
  });
  expect(screen.getByText('3 applied, 1 not applied.')).toBeInTheDocument();
  expect(
    screen.getByText(/mistral-large-3: A model with the id .* already exists/)
  ).toBeInTheDocument();
  expect(onSynced).toHaveBeenCalledTimes(1);
});

test('a pick the gateway changed since the admin looked is explained, not hidden', async () => {
  setup(DRIFT, picks =>
    picks.map(pick => ({ ...pick, status: 'skipped', detail: 'changedSinceReview' }))
  );
  const { onSynced } = await open();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Apply 4' }));
  });
  expect(screen.getByText('0 applied, 4 not applied.')).toBeInTheDocument();
  expect(screen.getAllByText(/The gateway changed since you looked/)).toHaveLength(4);
  expect(onSynced).not.toHaveBeenCalled();
});

test('a request that fails as a whole fails every item with the reason', async () => {
  mockApi.mockImplementation(async path => {
    if (path.endsWith('/_model-drift')) return { data: { items: [DRIFT.items[2]] } };
    throw new Error('The endpoint rejected the API key');
  });
  const { onSynced } = await open();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Apply 1' }));
  });
  expect(screen.getByText('0 applied, 1 not applied.')).toBeInTheDocument();
  expect(screen.getByText(/retired: The endpoint rejected the API key/)).toBeInTheDocument();
  expect(onSynced).not.toHaveBeenCalled();
});

test('when the gateway cannot be asked, shows why and lets the admin try again', async () => {
  mockApi.mockRejectedValueOnce(
    Object.assign(new Error('rejected'), {
      response: {
        data: {
          error: 'The endpoint rejected the API key',
          code: 'UPSTREAM_ERROR',
          details: { reason: 'authenticationFailed', hint: 'HTTP 401. Check the API key.' }
        }
      }
    })
  );
  await open();

  const alert = screen.getByRole('alert');
  expect(within(alert).getByText('The endpoint rejected the API key')).toBeInTheDocument();
  expect(within(alert).getByText('HTTP 401. Check the API key.')).toBeInTheDocument();
  expect(writes()).toHaveLength(0);

  setup();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  });
  expect(screen.getByRole('heading', { name: /Changed on the gateway/ })).toBeInTheDocument();
});
