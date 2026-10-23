// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The projects of a chat: the "+" menu section where the viewer's user
 * projects are ticked, and the chips beside the input that show the project
 * the chat runs in and the ones it draws on. A tick is saved at once for a
 * stored chat and kept in state (to ride on the next message) for a chat that
 * is not stored yet. A chat is never moved into a project once it exists.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';

const mockSetAttached = jest.fn();
jest.mock('../../../client/src/api', () => ({
  setChatAttachedProjects: (...args) => mockSetAttached(...args)
}));

let mockProjects = [];
let mockEnabled = true;
jest.mock('../../../client/src/features/projects/hooks/useProjects', () => ({
  useMyProjects: () => ({ projects: mockProjects }),
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
const ChatProjectsMenuSection =
  require('../../../client/src/features/projects/components/ChatProjectsMenuSection').default;
const {
  useOfferedProjects
} = require('../../../client/src/features/projects/components/ChatProjectsMenuSection');

const HANDBOOK = { id: 'prj_handbook', ownership: 'user', name: 'Handbook' };
const CASE = { id: 'prj_case', ownership: 'user', name: 'Case 2026-114' };
const ADMIN = { id: 'faq', ownership: 'admin', name: { en: 'FAQ' } };

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

/** The menu section the way the "+" menu renders it. */
function Menu({ projectContext }) {
  const offered = useOfferedProjects(projectContext);
  return (
    <ChatProjectsMenuSection
      projectContext={projectContext}
      offered={offered}
      navTabIndex={() => 0}
    />
  );
}

const renderMenu = overrides => {
  const projectContext = context(overrides);
  return { projectContext, ...render(<Menu projectContext={projectContext} />) };
};

const renderChips = overrides => {
  const projectContext = context(overrides);
  return {
    projectContext,
    ...render(
      <MemoryRouter>
        <ChatProjectChips projectContext={projectContext} />
      </MemoryRouter>
    )
  };
};

beforeEach(() => {
  mockSetAttached.mockReset();
  mockProjects = [HANDBOOK, CASE, ADMIN];
  mockEnabled = true;
});

describe('projects menu section', () => {
  test("offers the viewer's user projects, not admin ones or the chat's own container", () => {
    renderMenu({ containerProjectId: CASE.id });

    expect(screen.getByRole('menuitemcheckbox', { name: 'Handbook' })).toBeInTheDocument();
    expect(
      screen.queryByRole('menuitemcheckbox', { name: 'Case 2026-114' })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitemcheckbox', { name: 'FAQ' })).not.toBeInTheDocument();
  });

  test('saves a tick at once for a stored chat and shows the list the server kept', async () => {
    mockSetAttached.mockResolvedValue({ chat: { attachedProjectIds: [HANDBOOK.id] } });
    const { projectContext } = renderMenu();

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Handbook' }));

    await waitFor(() => expect(mockSetAttached).toHaveBeenCalledWith('chat-1', [HANDBOOK.id]));
    await waitFor(() => expect(projectContext.onChange).toHaveBeenCalledWith([HANDBOOK.id]));
  });

  test('ticks with the keyboard too', async () => {
    mockSetAttached.mockResolvedValue({ chat: { attachedProjectIds: [CASE.id] } });
    renderMenu();

    fireEvent.keyDown(screen.getByRole('menuitemcheckbox', { name: 'Case 2026-114' }), {
      key: ' '
    });

    await waitFor(() => expect(mockSetAttached).toHaveBeenCalledWith('chat-1', [CASE.id]));
  });

  test('keeps the pick in state for a chat that is not stored yet', () => {
    const { projectContext } = renderMenu({ stored: false, chatId: null });

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Case 2026-114' }));

    expect(mockSetAttached).not.toHaveBeenCalled();
    expect(projectContext.onChange).toHaveBeenCalledWith([CASE.id]);
  });

  test('shows a ticked project as checked and unticks it', async () => {
    mockSetAttached.mockResolvedValue({ chat: { attachedProjectIds: [] } });
    renderMenu({ value: [HANDBOOK.id] });

    const row = screen.getByRole('menuitemcheckbox', { name: 'Handbook' });
    expect(row).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(row);

    await waitFor(() => expect(mockSetAttached).toHaveBeenCalledWith('chat-1', []));
  });

  test('says so when the server refuses, and keeps the list', async () => {
    mockSetAttached.mockRejectedValue(new Error('nope'));
    const { projectContext } = renderMenu();

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Handbook' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(projectContext.onChange).not.toHaveBeenCalled();
  });

  test('renders nothing while user projects are off or there is nothing to pick', () => {
    mockEnabled = false;
    const { container, rerender, projectContext } = renderMenu();
    expect(container).toBeEmptyDOMElement();

    mockEnabled = true;
    mockProjects = [ADMIN];
    rerender(<Menu projectContext={projectContext} />);
    expect(container).toBeEmptyDOMElement();
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
      <MemoryRouter>
        <ChatProjectChips projectContext={{ ...projectContext, containerProjectId: CASE.id }} />
      </MemoryRouter>
    );
    expect(container).toBeEmptyDOMElement();
  });
});
