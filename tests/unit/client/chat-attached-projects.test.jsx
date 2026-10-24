// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The projects of a chat: the chat input's project picker, where the
 * viewer's projects are searched and ticked, and the chips beside the input
 * that show the project the chat runs in and the ones it draws on. A tick is
 * saved at once for a stored chat and kept in state (to ride on the next
 * message) for a chat that is not stored yet. A chat is never moved into a
 * project once it exists.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';

const mockSetAttached = jest.fn();
jest.mock('../../../client/src/api', () => ({
  setChatAttachedProjects: (...args) => mockSetAttached(...args)
}));

let mockProjects = [];
let mockEnabled = true;
const mockMyProjectsCalls = [];
jest.mock('../../../client/src/features/projects/hooks/useProjects', () => ({
  useMyProjects: options => {
    mockMyProjectsCalls.push(options);
    return { projects: mockProjects };
  },
  useProjectsAvailability: () => ({ userProjectsEnabled: mockEnabled })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const mockT = (key, defaultOrOptions, maybeOptions) => {
  const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions || {};
  const text = typeof defaultOrOptions === 'string' ? defaultOrOptions : key;
  return Object.entries(options).reduce(
    (out, [name, value]) => out.replaceAll(`{{${name}}}`, value),
    text
  );
};
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } })
}));

const ChatProjectChips =
  require('../../../client/src/features/projects/components/ChatProjectChips').default;
const ChatProjectPicker =
  require('../../../client/src/features/projects/components/ChatProjectPicker').default;
const {
  useOfferedProjects
} = require('../../../client/src/features/projects/components/ChatProjectPicker');

const HANDBOOK = {
  id: 'prj_handbook',
  ownership: 'user',
  name: 'Handbook',
  permissions: { isOwner: true }
};
const CASE = { id: 'prj_case', ownership: 'user', name: 'Case 2026-114' };
// Comes with an app: not in the viewer's list.
const ADMIN = { id: 'faq', ownership: 'admin', name: { en: 'FAQ' } };
// Available to everyone, and the viewer added it from the catalog.
const ADDED_ADMIN = {
  id: 'policies',
  ownership: 'admin',
  name: { en: 'Policies' },
  subscribed: true
};

const {
  useChatAttachedProjects
} = require('../../../client/src/features/projects/hooks/useChatAttachedProjects');

/**
 * The chat page's shape: one attached-projects controller, shared by the
 * chips and the project picker, both fed from one `projectContext`.
 */
function Harness({ params, showMenu = true, showChips = true }) {
  const attached = useChatAttachedProjects({
    chatId: params.chatId,
    stored: params.stored,
    value: params.value,
    onChange: params.onChange
  });
  const projectContext = { ...params, attached };
  const offered = useOfferedProjects(projectContext);
  return (
    <MemoryRouter>
      {showMenu && <ChatProjectPicker projectContext={projectContext} offered={offered} />}
      {showChips && <ChatProjectChips projectContext={projectContext} />}
    </MemoryRouter>
  );
}

function context(overrides = {}) {
  return {
    chatId: 'chat-1',
    stored: true,
    containerProjectId: null,
    value: [],
    onChange: jest.fn(),
    disabled: false,
    ...overrides
  };
}

/** Open the picker; it stays open while projects are ticked. */
const openPicker = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Projects for this chat' }));
const option = name => screen.getByRole('option', { name });

const renderMenu = overrides => {
  const params = context(overrides);
  const view = render(<Harness params={params} showChips={false} />);
  openPicker();
  return { projectContext: params, ...view };
};

const renderChips = overrides => {
  const params = context(overrides);
  return {
    projectContext: params,
    ...render(<Harness params={params} showMenu={false} />)
  };
};

beforeEach(() => {
  mockSetAttached.mockReset();
  mockProjects = [HANDBOOK, CASE, ADMIN, ADDED_ADMIN];
  mockEnabled = true;
});

describe('project picker', () => {
  test("offers the viewer's list — not the admin projects of their apps, nor the chat's own container", () => {
    renderMenu({ containerProjectId: CASE.id });

    expect(option('Handbook')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Case 2026-114' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'FAQ' })).not.toBeInTheDocument();
    // An admin project added from the catalog is offered, in its own section.
    const admins = screen.getByRole('group', { name: 'From the administrators' });
    expect(within(admins).getByRole('option', { name: 'Policies' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'My projects' })).getByRole('option', {
        name: 'Handbook'
      })
    ).toBeInTheDocument();
  });

  test('narrows the list with the search', () => {
    renderMenu();

    fireEvent.change(screen.getByRole('combobox', { name: 'Projects for this chat' }), {
      target: { value: 'case' }
    });

    expect(option('Case 2026-114')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Handbook' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'nothing like it' } });
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(screen.getByText('No project matches.')).toBeInTheDocument();
  });

  test('saves a tick at once for a stored chat and shows the list the server kept', async () => {
    mockSetAttached.mockResolvedValue({ chat: { attachedProjectIds: [HANDBOOK.id] } });
    const { projectContext } = renderMenu();

    fireEvent.click(option('Handbook'));

    await waitFor(() => expect(mockSetAttached).toHaveBeenCalledWith('chat-1', [HANDBOOK.id]));
    await waitFor(() => expect(projectContext.onChange).toHaveBeenCalledWith([HANDBOOK.id]));
    // Ticking keeps the picker open for the next one.
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  test('ticks with the keyboard too, and Escape closes it', async () => {
    mockSetAttached.mockResolvedValue({ chat: { attachedProjectIds: [CASE.id] } });
    renderMenu();
    const search = screen.getByRole('combobox');
    expect(search).toHaveFocus();

    fireEvent.change(search, { target: { value: 'case' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(search).toHaveAttribute('aria-activedescendant', option('Case 2026-114').id);
    fireEvent.keyDown(search, { key: 'Enter' });

    await waitFor(() => expect(mockSetAttached).toHaveBeenCalledWith('chat-1', [CASE.id]));

    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Projects for this chat' })).toHaveFocus();
  });

  test('keeps the pick in state for a chat that is not stored yet', () => {
    const { projectContext } = renderMenu({ stored: false, chatId: null });

    fireEvent.click(option('Case 2026-114'));

    expect(mockSetAttached).not.toHaveBeenCalled();
    expect(projectContext.onChange).toHaveBeenCalledWith([CASE.id]);
  });

  test('shows a ticked project as selected and unticks it', async () => {
    mockSetAttached.mockResolvedValue({ chat: { attachedProjectIds: [] } });
    renderMenu({ value: [HANDBOOK.id] });

    const row = option('Handbook');
    expect(row).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(row);

    await waitFor(() => expect(mockSetAttached).toHaveBeenCalledWith('chat-1', []));
  });

  test('says so when the server refuses, and keeps the list', async () => {
    mockSetAttached.mockRejectedValue(new Error('nope'));
    const params = context();
    render(<Harness params={params} />);
    openPicker();

    fireEvent.click(option('Handbook'));

    // The failure shows in the chips, which stay when the picker has closed.
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(params.onChange).not.toHaveBeenCalled();
  });

  test('a picker that closes while a change is saving loses neither the result nor the error', async () => {
    mockSetAttached.mockRejectedValue(new Error('nope'));
    const params = context();
    const { rerender } = render(<Harness params={params} />);
    openPicker();

    fireEvent.click(option('Handbook'));
    // The picker unmounts; the controller lives above it.
    rerender(<Harness params={params} showMenu={false} />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  test('one change at a time: the chips and the picker share a single saving flag', async () => {
    let finish;
    mockSetAttached.mockReturnValue(new Promise(resolve => (finish = resolve)));
    const params = context({ value: [CASE.id] });
    render(<Harness params={params} />);
    openPicker();

    fireEvent.click(option('Handbook'));
    expect(mockSetAttached).toHaveBeenCalledTimes(1);

    // Mid-save, neither the chip's × nor another row starts a second PATCH
    // from the stale list.
    expect(
      screen.getByRole('button', { name: 'Remove Case 2026-114 from this chat' })
    ).toBeDisabled();
    expect(option('Case 2026-114')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(option('Case 2026-114'));
    expect(mockSetAttached).toHaveBeenCalledTimes(1);

    finish({ chat: { attachedProjectIds: [CASE.id, HANDBOOK.id] } });
    await waitFor(() => expect(params.onChange).toHaveBeenCalledWith([CASE.id, HANDBOOK.id]));
  });

  test('renders nothing while user projects are off or there is nothing to pick', () => {
    mockEnabled = false;
    const params = context();
    const { container, rerender } = render(<Harness params={params} showChips={false} />);
    expect(container).toBeEmptyDOMElement();

    mockEnabled = true;
    mockProjects = [ADMIN];
    rerender(<Harness params={params} showChips={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('a save that outlives its chat', () => {
  function Switchable({ chatId, onChange }) {
    return (
      <Harness
        params={context({ chatId, onChange, containerProjectId: CASE.id })}
        showChips={false}
      />
    );
  }

  test('neither its answer nor its error reaches the chat opened meanwhile', async () => {
    let finish;
    mockSetAttached.mockReturnValue(new Promise(resolve => (finish = resolve)));
    const onChange = jest.fn();
    const { rerender } = render(<Switchable chatId="chat-1" onChange={onChange} />);
    openPicker();

    fireEvent.click(option('Handbook'));
    rerender(<Switchable chatId="chat-2" onChange={onChange} />);
    finish({ chat: { attachedProjectIds: [HANDBOOK.id] } });
    await waitFor(() => expect(mockSetAttached).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(onChange).not.toHaveBeenCalled();

    // The same for a failure: no error appears in the new chat.
    mockSetAttached.mockRejectedValue(new Error('nope'));
    fireEvent.click(option('Handbook'));
    rerender(<Switchable chatId="chat-3" onChange={onChange} />);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('an app that opts out of projects', () => {
  test('offers no projects to tick but still names the project the chat runs in', () => {
    const params = context({ attachDisabled: true, containerProjectId: CASE.id });
    render(<Harness params={params} />);

    expect(
      screen.queryByRole('button', { name: 'Projects for this chat' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'In project: Case 2026-114' })).toBeInTheDocument();
  });

  test('loads no project list for a chat without a project context', () => {
    mockMyProjectsCalls.length = 0;
    function Probe() {
      useOfferedProjects(null);
      return null;
    }
    render(<Probe />);
    expect(mockMyProjectsCalls).toEqual([{ enabled: false }]);
  });
});

describe('project chips', () => {
  test('names the project the chat runs in and links to it, without a way to leave it', () => {
    renderChips({ containerProjectId: CASE.id });

    const link = screen.getByRole('link', { name: 'In project: Case 2026-114' });
    expect(link).toHaveAttribute('href', '/projects/prj_case');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  test('removes an attached project from its chip', async () => {
    mockSetAttached.mockResolvedValue({ chat: { attachedProjectIds: [CASE.id] } });
    const { projectContext } = renderChips({ value: [HANDBOOK.id, CASE.id] });

    expect(screen.getByRole('link', { name: /Handbook/ })).toHaveAttribute(
      'href',
      '/projects/prj_handbook'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove Handbook from this chat' }));

    await waitFor(() => expect(mockSetAttached).toHaveBeenCalledWith('chat-1', [CASE.id]));
    await waitFor(() => expect(projectContext.onChange).toHaveBeenCalledWith([CASE.id]));
  });

  test('renders nothing for a chat without projects, or while user projects are off', () => {
    const { container, rerender, projectContext } = renderChips();
    expect(container).toBeEmptyDOMElement();

    mockEnabled = false;
    rerender(
      <Harness params={{ ...projectContext, containerProjectId: CASE.id }} showMenu={false} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
