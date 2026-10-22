// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Start a chat in this project" (#1036): picking an app opens a new chat of
 * it inside the project. The chat page opens the chat id this tab holds for
 * the app, and without stored chats that is the previous conversation — so
 * the dialog mints a fresh one per start. Only chat apps are offered.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const mockApps = { apps: [], loading: false };
jest.mock('../../../client/src/shared/hooks/useApps', () => ({
  __esModule: true,
  default: () => mockApps
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, def) => (typeof def === 'string' ? def : key),
    i18n: { language: 'en' }
  })
}));

const StartProjectChatDialog =
  require('../../../client/src/features/projects/components/StartProjectChatDialog').default;

function Location() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderDialog() {
  return render(
    <MemoryRouter initialEntries={['/projects/prj_case']}>
      <Routes>
        <Route
          path="/projects/:id"
          element={<StartProjectChatDialog projectId="prj_case" onClose={() => {}} />}
        />
        <Route path="/apps/:appId" element={null} />
      </Routes>
      <Location />
    </MemoryRouter>
  );
}

beforeEach(() => {
  sessionStorage.clear();
  mockApps.apps = [
    { id: 'chat', name: { en: 'Chat' } },
    { id: 'wiki', name: { en: 'Wiki' }, type: 'iframe' },
    { id: 'away', name: { en: 'Elsewhere' }, type: 'redirect' }
  ];
});

test('opens a new chat of the app inside the project, never the one this tab held', () => {
  sessionStorage.setItem('ai_hub_chat_id_chat', 'chat-previous');
  renderDialog();

  fireEvent.click(screen.getByRole('button', { name: /Chat/ }));

  expect(screen.getByTestId('location')).toHaveTextContent('/apps/chat?project=prj_case');
  const minted = sessionStorage.getItem('ai_hub_chat_id_chat');
  expect(minted).toMatch(/^chat-/);
  expect(minted).not.toBe('chat-previous');
});

test('offers only chat apps', () => {
  renderDialog();
  expect(screen.getByRole('button', { name: /Chat/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Wiki/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Elsewhere/ })).toBeNull();
});
