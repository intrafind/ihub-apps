// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The shared dialog that gives something to another owner
 * (`shared/components/TransferOwnerDialog`), and the project dialog that
 * became a wrapper around it (`TransferProjectDialog`).
 *
 * The dialog knows no API: the tests pass the lookup, the call and the texts.
 * For the project wrapper the API module is a stub and the texts are the real
 * English ones, so the wrapper renders what `project-page.test.jsx` expects.
 *
 * Slice P8 of concepts/app-builder-rework-2026-11/02-personal-apps.md
 * (sections 11.7, 14.3 and 21).
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createTexts, en } from './helpers/userAppEditorHarness';

const mockApi = { fetchProjectShareTargets: jest.fn(), transferProject: jest.fn() };
jest.mock('../../../client/src/api', () => ({
  fetchProjectShareTargets: (...args) => mockApi.fetchProjectShareTargets(...args),
  transferProject: (...args) => mockApi.transferProject(...args)
}));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  getBasePath: () => '',
  buildPath: p => p,
  buildAssetUrl: p => p
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const mockTexts = createTexts();
jest.mock('react-i18next', () => ({
  useTranslation: () => mockTexts.translation
}));

const TransferOwnerDialog =
  require('../../../client/src/shared/components/TransferOwnerDialog').default;
const TransferProjectDialog =
  require('../../../client/src/features/projects/components/TransferProjectDialog').default;

const BEN = { id: 'u_ben', name: 'Ben Baker', email: 'ben@example.org' };
const CARLA = { id: 'u_carla', name: 'Carla Diaz' };

const LABELS = {
  title: 'Hand over',
  hint: 'Choose who should take the app over.',
  search: 'Search people',
  submit: 'Next',
  submitTo: () => 'Next',
  confirmTitle: owner => `Hand over "Job ad writer" to ${owner.name}?`,
  lines: owner => [`${owner.name} is asked to take the app over.`, 'You keep no access.'],
  confirm: owner => `Ask ${owner.name}`
};

beforeAll(() => mockTexts.init());
beforeEach(() => jest.clearAllMocks());

let consoleError;
beforeEach(() => {
  consoleError = jest.spyOn(console, 'error');
});
afterEach(() => {
  const unsettled = consoleError.mock.calls.filter(call =>
    String(call[0]).includes('not wrapped in act')
  );
  consoleError.mockRestore();
  expect(unsettled).toEqual([]);
});

async function click(element) {
  await act(async () => {
    fireEvent.click(element);
  });
}

/** Types into the search box and waits for the debounced lookup to answer. */
async function search(lookup, text) {
  const before = lookup.mock.calls.length;
  await act(async () => {
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: text } });
  });
  await waitFor(() => expect(lookup.mock.calls.length).toBeGreaterThan(before));
  await act(async () => {});
}

function renderShared(props = {}) {
  const handlers = {
    fetchTargets: jest.fn().mockResolvedValue({ users: [BEN, CARLA] }),
    transfer: jest.fn().mockResolvedValue({ id: 'x', offered: true }),
    errorMessage: jest.fn(error => `Refused: ${error.message}`),
    onClose: jest.fn(),
    onTransferred: jest.fn()
  };
  const item = { id: 'x' };
  render(
    <TransferOwnerDialog item={item} labels={LABELS} danger={false} {...handlers} {...props} />
  );
  return { ...handlers, ...props, item };
}

describe('TransferOwnerDialog', () => {
  test('first step: the search box has the focus, and nothing can be sent yet', async () => {
    const { fetchTargets, transfer } = renderShared();
    const dialog = screen.getByRole('dialog', { name: 'Hand over' });
    expect(within(dialog).getByRole('searchbox', { name: 'Search people' })).toHaveFocus();
    expect(within(dialog).getByText('Choose who should take the app over.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Next' })).toBeDisabled();

    // One character is not a search.
    await act(async () => {
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'b' } });
    });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(fetchTargets).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
  });

  test('second step: the texts of the caller, with the picked person', async () => {
    const { fetchTargets, transfer } = renderShared();
    await search(fetchTargets, ' be ');
    expect(fetchTargets).toHaveBeenCalledWith('be');
    await click(screen.getByRole('button', { name: /Ben Baker/ }));
    expect(screen.getByRole('button', { name: /Ben Baker/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await click(screen.getByRole('button', { name: 'Next' }));

    const dialog = screen.getByRole('dialog', { name: 'Hand over "Job ad writer" to Ben Baker?' });
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map(item => item.textContent)
    ).toEqual(['Ben Baker is asked to take the app over.', 'You keep no access.']);
    // "Back" has the focus, and leads to the first step with the choice kept.
    const back = within(dialog).getByRole('button', { name: en.common.back });
    expect(back).toHaveFocus();
    expect(transfer).not.toHaveBeenCalled();
    await click(back);
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  test('confirming calls `transfer` with the item and the person, and hands on the result', async () => {
    const { fetchTargets, transfer, onTransferred, item } = renderShared();
    await search(fetchTargets, 'ben');
    await click(screen.getByRole('button', { name: /Ben Baker/ }));
    await click(screen.getByRole('button', { name: 'Next' }));
    const confirm = screen.getByRole('button', { name: 'Ask Ben Baker' });
    // An offer changes nothing by itself: the button is not the red one.
    expect(confirm.className).not.toContain('bg-red-600');
    await click(confirm);
    expect(transfer).toHaveBeenCalledWith(item, BEN);
    expect(onTransferred).toHaveBeenCalledWith({ id: 'x', offered: true }, BEN);
  });

  test('a refused call is said in the dialog, and can be tried again', async () => {
    const transfer = jest.fn().mockRejectedValueOnce(new Error('too many offers'));
    const { fetchTargets, onTransferred } = renderShared({ transfer });
    await search(fetchTargets, 'ben');
    await click(screen.getByRole('button', { name: /Ben Baker/ }));
    await click(screen.getByRole('button', { name: 'Next' }));
    await click(screen.getByRole('button', { name: 'Ask Ben Baker' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Refused: too many offers');
    expect(onTransferred).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Ask Ben Baker' })).toBeEnabled();
  });

  test('typing again drops the choice; a failed lookup is said', async () => {
    const fetchTargets = jest
      .fn()
      .mockResolvedValueOnce({ users: [BEN] })
      .mockRejectedValueOnce(new Error('offline'));
    renderShared({ fetchTargets });
    await search(fetchTargets, 'ben');
    await click(screen.getByRole('button', { name: /Ben Baker/ }));
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    await search(fetchTargets, 'benn');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Refused: offline');
  });

  test('a change that takes effect at once has the red button by default', async () => {
    const { fetchTargets } = renderShared({ danger: undefined });
    await search(fetchTargets, 'ben');
    await click(screen.getByRole('button', { name: /Ben Baker/ }));
    await click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('button', { name: 'Ask Ben Baker' }).className).toContain('bg-red-600');
  });
});

describe('TransferProjectDialog (the wrapper)', () => {
  const PROJECT = {
    id: 'prj_a',
    name: 'Case 2026-114',
    members: [{ type: 'group', id: 'legal', name: 'Legal', role: 'user' }],
    audience: { catalog: true }
  };

  function renderProject(project = PROJECT) {
    const onClose = jest.fn();
    const onTransferred = jest.fn();
    mockApi.fetchProjectShareTargets.mockResolvedValue({ users: [BEN], groups: [] });
    render(
      <TransferProjectDialog project={project} onClose={onClose} onTransferred={onTransferred} />
    );
    return { onClose, onTransferred };
  }

  test('renders the project texts in both steps and transfers at once', async () => {
    const { onTransferred } = renderProject();
    const dialog = screen.getByRole('dialog', { name: en.projects.transfer.title });
    expect(dialog.querySelector('#transfer-project-title')).not.toBeNull();
    expect(within(dialog).getByText(en.projects.transfer.hint)).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: en.projects.transfer.submit })
    ).toBeDisabled();

    await search(mockApi.fetchProjectShareTargets, 'ben');
    expect(mockApi.fetchProjectShareTargets).toHaveBeenCalledWith('ben');
    await click(within(dialog).getByRole('button', { name: /Ben Baker/ }));
    await click(within(dialog).getByRole('button', { name: 'Transfer to Ben Baker' }));

    expect(
      within(dialog).getByRole('heading', { name: 'Transfer “Case 2026-114” to Ben Baker?' })
    ).toBeInTheDocument();
    const lines = within(dialog)
      .getAllByRole('listitem')
      .map(item => item.textContent);
    expect(lines).toHaveLength(4);
    // Wide shares stay in force, the catalog included.
    expect(lines[2]).toContain('Legal');
    expect(lines[2]).toContain(en.projects.transfer.catalog);
    expect(within(dialog).getByText(en.projects.transfer.confirmUndo)).toBeInTheDocument();
    expect(mockApi.transferProject).not.toHaveBeenCalled();

    const result = { id: 'prj_a', transferred: true };
    mockApi.transferProject.mockResolvedValue(result);
    const confirm = within(dialog).getByRole('button', { name: en.projects.transfer.confirm });
    expect(confirm.className).toContain('bg-red-600');
    await click(confirm);
    expect(mockApi.transferProject).toHaveBeenCalledWith('prj_a', 'u_ben');
    expect(onTransferred).toHaveBeenCalledWith(result, BEN);
  });

  test('a project without wide shares says that access is lost', async () => {
    renderProject({ id: 'prj_b', name: 'Private', members: [] });
    await search(mockApi.fetchProjectShareTargets, 'ben');
    await click(screen.getByRole('button', { name: /Ben Baker/ }));
    await click(screen.getByRole('button', { name: 'Transfer to Ben Baker' }));
    expect(screen.getAllByRole('listitem')[2]).toHaveTextContent(
      'You lose access to the project unless Ben Baker shares it with you again.'
    );
  });

  test('"Cancel" closes without a call', async () => {
    const { onClose } = renderProject();
    await click(screen.getByRole('button', { name: en.common.cancel }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockApi.transferProject).not.toHaveBeenCalled();
  });
});
