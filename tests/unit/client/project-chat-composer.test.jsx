// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The chat field of a project page (#1036): the start page's chat input
 * (`AppChatStarter`, covered in app-chat-starter.test.jsx) for the project's
 * default app, starting the chat inside the project; the app select picks
 * another app for this chat. The chat page opens the chat id this tab holds
 * for the app, and without stored chats that is the previous conversation —
 * so each start mints a fresh one. Only chat apps are offered; a default app
 * the viewer cannot use falls back to the first app.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const mockApps = { apps: [], loading: false };
// The props the chat input was last rendered with.
const mockStarter = { props: null };
jest.mock('../../../client/src/features/chat/components/AppChatStarter', () => ({
  __esModule: true,
  default: props => {
    mockStarter.props = props;
    return <textarea aria-label={`Message ${props.app?.id}`} />;
  }
}));
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
    t: (key, def, options = {}) =>
      typeof def === 'string'
        ? Object.entries(options).reduce(
            (out, [name, value]) => out.replaceAll(`{{${name}}}`, value),
            def
          )
        : key,
    i18n: { language: 'en' }
  })
}));

const ProjectChatComposer =
  require('../../../client/src/features/projects/components/ProjectChatComposer').default;

function Location() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderComposer(project = {}, props = {}) {
  return render(
    <MemoryRouter initialEntries={['/projects/prj_case']}>
      <Routes>
        <Route
          path="/projects/:id"
          element={
            <ProjectChatComposer
              project={{ id: 'prj_case', name: 'Case', ...project }}
              projectName="Case"
              {...props}
            />
          }
        />
        <Route path="/apps/:appId" element={null} />
      </Routes>
      <Location />
    </MemoryRouter>
  );
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  mockStarter.props = null;
  mockApps.loading = false;
  mockApps.apps = [
    { id: 'chat', name: { en: 'Chat' } },
    { id: 'summarizer', name: { en: 'Summarizer' } },
    { id: 'wiki', name: { en: 'Wiki' }, type: 'iframe' },
    { id: 'away', name: { en: 'Elsewhere' }, type: 'redirect' },
    { id: 'closed', name: { en: 'Closed' }, features: { userProjects: false } },
    { id: 'dark', name: { en: 'Dark' }, features: { projects: false } }
  ];
});

test('renders the start page’s chat input for the project’s default app, inside the project', () => {
  renderComposer({ defaultAppId: 'summarizer' });

  expect(screen.getByRole('region', { name: 'New chat in Case' })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Message summarizer' })).toBeInTheDocument();
  expect(mockStarter.props.app.id).toBe('summarizer');
  expect(mockStarter.props.startParams).toEqual({ project: 'prj_case' });
});

test('someone who took the project from the catalog starts a chat outside it, with it attached', () => {
  renderComposer({}, { attach: true });

  expect(mockStarter.props.startParams).toEqual({ attachProject: 'prj_case' });
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  expect(screen.getByTestId('location')).toHaveTextContent('/apps/chat?attachProject=prj_case');
});

test('another app can be picked for this chat', () => {
  renderComposer({ defaultAppId: 'summarizer' });

  expect(screen.getByRole('combobox')).toHaveValue('summarizer');
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'chat' } });

  expect(screen.getByRole('textbox', { name: 'Message chat' })).toBeInTheDocument();
  expect(mockStarter.props.app.id).toBe('chat');
});

test('a sent message starts a new chat, never the one this tab held', () => {
  sessionStorage.setItem('ai_hub_chat_id_chat', 'chat-previous');
  localStorage.setItem('ai_hub_conversation_id_chat', 'conv-previous');
  renderComposer();

  // The input calls this right before it opens the chat page.
  mockStarter.props.onBeforeStart('chat');

  const minted = sessionStorage.getItem('ai_hub_chat_id_chat');
  expect(minted).toMatch(/^chat-/);
  expect(minted).not.toBe('chat-previous');
  expect(localStorage.getItem('ai_hub_conversation_id_chat')).toBeNull();
});

test('"New chat" opens an empty chat, never the one this tab held', () => {
  sessionStorage.setItem('ai_hub_chat_id_chat', 'chat-previous');
  // The iAssistant conversation the app would otherwise resume.
  localStorage.setItem('ai_hub_conversation_id_chat', 'conv-previous');
  renderComposer();

  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));

  expect(screen.getByTestId('location')).toHaveTextContent('/apps/chat?project=prj_case');
  expect(screen.getByTestId('location')).not.toHaveTextContent('prefill');
  const minted = sessionStorage.getItem('ai_hub_chat_id_chat');
  expect(minted).toMatch(/^chat-/);
  expect(minted).not.toBe('chat-previous');
  expect(localStorage.getItem('ai_hub_conversation_id_chat')).toBeNull();
});

test('offers only chat apps that take projects, and falls back from a default the viewer cannot use', () => {
  renderComposer({ defaultAppId: 'removed-app' });

  const options = Array.from(screen.getByRole('combobox').querySelectorAll('option')).map(
    option => option.textContent
  );
  expect(options).toEqual(['Chat', 'Summarizer']);
  expect(screen.getByRole('combobox')).toHaveValue('chat');
});

test('says so when no app can chat inside projects', () => {
  mockApps.apps = [{ id: 'wiki', name: { en: 'Wiki' }, type: 'iframe' }];
  renderComposer();

  expect(screen.getByText('No app can chat inside projects.')).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByRole('button', { name: 'New chat' })).toBeDisabled();
});
