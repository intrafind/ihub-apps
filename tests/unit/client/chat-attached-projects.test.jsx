// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The project picker of a chat: chips for the attached projects, a list of
 * the viewer's user projects to tick, saved at once for a stored chat and kept
 * in state (to ride on the next message) for a chat that is not stored yet.
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

const ChatAttachedProjects =
  require('../../../client/src/features/projects/components/ChatAttachedProjects').default;

const HANDBOOK = { id: 'prj_handbook', ownership: 'user', name: 'Handbook' };
const CASE = { id: 'prj_case', ownership: 'user', name: 'Case 2026-114' };
const ADMIN = { id: 'faq', ownership: 'admin', name: { en: 'FAQ' } };

function renderBar(props) {
  return render(
    <MemoryRouter>
      <ChatAttachedProjects
        chatId="chat-1"
        stored
        containerProjectId={null}
        value={[]}
        onChange={jest.fn()}
        {...props}
      />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockSetAttached.mockReset();
  mockProjects = [HANDBOOK, CASE, ADMIN];
  mockEnabled = true;
});

describe('ChatAttachedProjects', () => {
  test("offers the viewer's user projects, not admin ones or the chat's own container", () => {
    renderBar({ containerProjectId: CASE.id });

    fireEvent.click(screen.getByRole('button', { name: 'Add project' }));

    expect(screen.getByLabelText('Handbook')).toBeInTheDocument();
    expect(screen.queryByLabelText('Case 2026-114')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('FAQ')).not.toBeInTheDocument();
  });

  test('saves a tick at once for a stored chat and shows the list the server kept', async () => {
    const onChange = jest.fn();
    mockSetAttached.mockResolvedValue({ chat: { attachedProjectIds: [HANDBOOK.id] } });
    renderBar({ onChange });

    fireEvent.click(screen.getByRole('button', { name: 'Add project' }));
    fireEvent.click(screen.getByLabelText('Handbook'));

    await waitFor(() => expect(mockSetAttached).toHaveBeenCalledWith('chat-1', [HANDBOOK.id]));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([HANDBOOK.id]));
  });

  test('keeps the pick in state for a chat that is not stored yet', () => {
    const onChange = jest.fn();
    renderBar({ stored: false, chatId: null, onChange });

    fireEvent.click(screen.getByRole('button', { name: 'Add project' }));
    fireEvent.click(screen.getByLabelText('Case 2026-114'));

    expect(mockSetAttached).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith([CASE.id]);
  });

  test('removes an attached project from its chip', async () => {
    const onChange = jest.fn();
    mockSetAttached.mockResolvedValue({ chat: { attachedProjectIds: [CASE.id] } });
    renderBar({ value: [HANDBOOK.id, CASE.id], onChange });

    expect(screen.getByRole('link', { name: /Handbook/ })).toHaveAttribute(
      'href',
      '/projects/prj_handbook'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove Handbook from this chat' }));

    await waitFor(() => expect(mockSetAttached).toHaveBeenCalledWith('chat-1', [CASE.id]));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([CASE.id]));
  });

  test('says so when the server refuses, and keeps the list', async () => {
    const onChange = jest.fn();
    mockSetAttached.mockRejectedValue(new Error('nope'));
    renderBar({ onChange });

    fireEvent.click(screen.getByRole('button', { name: 'Add project' }));
    fireEvent.click(screen.getByLabelText('Handbook'));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  test('renders nothing while user projects are off or there is nothing to pick', () => {
    mockEnabled = false;
    const { container, rerender } = renderBar({});
    expect(container).toBeEmptyDOMElement();

    mockEnabled = true;
    mockProjects = [ADMIN];
    rerender(
      <MemoryRouter>
        <ChatAttachedProjects chatId="c" stored value={[]} onChange={jest.fn()} />
      </MemoryRouter>
    );
    expect(container).toBeEmptyDOMElement();
  });
});
