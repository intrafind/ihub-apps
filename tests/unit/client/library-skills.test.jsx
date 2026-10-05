/**
 * Prompts and skills are one library at /prompts. With the skills feature a
 * type switch (All / Prompts / Skills, `?type=`) sits next to the scope
 * filter, skill cards carry a "Skill" badge, Favorites is hidden for skills,
 * and "New" becomes a menu (New prompt / New skill). Without the feature the
 * page is the prompt list it was.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';

// A stable `t`, as i18next's is: the page's loaders depend on it.
jest.mock('react-i18next', () => {
  const t = (key, options) =>
    typeof options === 'string'
      ? options
      : (options?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => options?.[name]);
  const value = { t, i18n: { language: 'en' } };
  return { useTranslation: () => value };
});
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/api', () => ({
  fetchPrompts: jest.fn(),
  fetchSkills: jest.fn(),
  fetchUserSkills: jest.fn()
}));
jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  useUIConfig: () => ({ uiConfig: {} })
}));
let mockPlatformConfig = {};
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: mockPlatformConfig })
}));
jest.mock('../../../client/src/shared/contexts/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true })
}));
let mockSkillsFeature = true;
jest.mock('../../../client/src/shared/hooks/useFeatureFlags', () => ({
  __esModule: true,
  default: () => ({
    isEnabled: (id, fallback) => (id === 'skills' ? mockSkillsFeature : fallback)
  })
}));
jest.mock('../../../client/src/features/prompts/hooks/usePromptPreferences', () => () => ({
  favorites: [],
  recents: [],
  toggleFavorite: jest.fn()
}));
const mockPromptActions = { create: jest.fn(), notice: null, dialogs: null };
jest.mock(
  '../../../client/src/features/prompts/hooks/usePromptActions',
  () => () => mockPromptActions
);
const mockSkillActions = {
  create: jest.fn(),
  edit: jest.fn(),
  duplicate: jest.fn(),
  notice: null,
  dialogs: null
};
jest.mock(
  '../../../client/src/features/skills/hooks/useSkillActions',
  () => () => mockSkillActions
);
jest.mock('../../../client/src/features/skills/components/SkillDetailsModal', () => ({ skill }) => (
  <div role="dialog">{`details:${skill.id}`}</div>
));
jest.mock('../../../client/src/features/prompts/components/PromptModal', () => () => null);

import { fetchPrompts, fetchSkills, fetchUserSkills } from '../../../client/src/api';
import PromptsList from '../../../client/src/features/prompts/pages/PromptsList';

const PROMPTS = [
  { id: 'p1', name: 'Status email', prompt: 'Write a status email', scope: 'global' },
  { id: 'p2', name: 'My draft', prompt: 'Draft', scope: 'mine', permissions: {} }
];
const PICKER = [
  { id: 'brand-voice', name: 'brand-voice', description: 'Global skill', scope: 'global' },
  // Personal entries of the picker list are taken from /api/user-skills instead.
  { id: 'usk_1', name: 'weekly-report', description: 'Picker copy', scope: 'mine' }
];
const USER_SKILLS = [
  {
    id: 'usk_1',
    name: 'weekly-report',
    description: 'Mine',
    scope: 'mine',
    fileCount: 2,
    permissions: { canEdit: true, canDuplicate: true }
  }
];

const renderLibrary = (entry = '/prompts') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <PromptsList />
    </MemoryRouter>
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockSkillsFeature = true;
  mockPlatformConfig = { userPrompts: { enabled: true }, userSkills: { enabled: true } };
  fetchPrompts.mockResolvedValue(PROMPTS);
  fetchSkills.mockResolvedValue(PICKER);
  fetchUserSkills.mockResolvedValue(USER_SKILLS);
});

const cardNames = () => [
  ...screen.queryAllByTestId('prompt-card').map(card => card.getAttribute('data-prompt-id')),
  ...screen.queryAllByTestId('skill-card').map(card => card.getAttribute('data-skill-id'))
];

test('All shows prompts and skills; skill cards carry a Skill badge', async () => {
  renderLibrary();
  await waitFor(() => expect(screen.getAllByTestId('skill-card')).toHaveLength(2));
  expect(screen.getByRole('heading', { name: 'Library' })).toBeInTheDocument();
  expect(cardNames()).toEqual(['p1', 'p2', 'usk_1', 'brand-voice']);
  for (const card of screen.getAllByTestId('skill-card')) {
    expect(within(card).getByText('Skill')).toBeInTheDocument();
  }
  const types = screen.getByRole('tablist', { name: 'Type' });
  expect(
    within(types)
      .getAllByRole('tab')
      .map(tab => tab.textContent)
  ).toEqual(['All', 'Prompts', 'Skills']);
  expect(fetchUserSkills).toHaveBeenCalledWith('all');
});

test('?type=skills shows only skills and hides Favorites', async () => {
  renderLibrary('/prompts?type=skills');
  await waitFor(() => expect(screen.getAllByTestId('skill-card')).toHaveLength(2));
  expect(screen.queryAllByTestId('prompt-card')).toHaveLength(0);
  const scopes = screen.getByRole('tablist', { name: 'Show' });
  expect(
    within(scopes)
      .getAllByRole('tab')
      .map(tab => tab.textContent)
  ).toEqual(['All', 'My skills', 'Shared with me', 'Global']);
});

test('switching the type narrows the list', async () => {
  renderLibrary();
  await waitFor(() => expect(screen.getAllByTestId('skill-card')).toHaveLength(2));
  fireEvent.click(screen.getByRole('tab', { name: 'Prompts' }));
  expect(cardNames()).toEqual(['p1', 'p2']);
  fireEvent.click(screen.getByRole('tab', { name: 'Skills' }));
  expect(cardNames()).toEqual(['usk_1', 'brand-voice']);
});

test('the Mine filter covers both kinds', async () => {
  renderLibrary('/prompts?filter=mine');
  await waitFor(() => expect(screen.getAllByTestId('skill-card')).toHaveLength(1));
  expect(cardNames()).toEqual(['p2', 'usk_1']);
});

test('New is a menu with New prompt and New skill', async () => {
  renderLibrary();
  await waitFor(() => expect(screen.getAllByTestId('skill-card')).toHaveLength(2));
  const button = screen.getByRole('button', { name: 'New' });
  expect(button).toHaveAttribute('aria-haspopup', 'menu');
  fireEvent.click(button);
  const items = screen.getAllByRole('menuitem');
  expect(items.map(item => item.textContent)).toEqual(['New prompt', 'New skill']);
  fireEvent.click(screen.getByRole('menuitem', { name: 'New skill' }));
  expect(mockSkillActions.create).toHaveBeenCalled();
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});

test('a skill card opens its details; ?skill= links open them too', async () => {
  renderLibrary('/prompts?skill=brand-voice');
  expect(await screen.findByText('details:brand-voice')).toBeInTheDocument();
});

test('a global skill can be copied to my skills from its card', async () => {
  renderLibrary('/prompts?type=skills');
  await waitFor(() => expect(screen.getAllByTestId('skill-card')).toHaveLength(2));
  const globalCard = screen
    .getAllByTestId('skill-card')
    .find(card => card.getAttribute('data-skill-id') === 'brand-voice');
  fireEvent.click(within(globalCard).getByRole('button', { name: 'Copy to my skills' }));
  expect(mockSkillActions.duplicate).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'brand-voice', scope: 'global' })
  );
});

test('without the skills feature the page is the prompt list', async () => {
  mockSkillsFeature = false;
  renderLibrary('/prompts?type=skills');
  await waitFor(() => expect(screen.getAllByTestId('prompt-card')).toHaveLength(2));
  expect(screen.queryByRole('tablist', { name: 'Type' })).not.toBeInTheDocument();
  expect(screen.queryAllByTestId('skill-card')).toHaveLength(0);
  expect(fetchSkills).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'New prompt' })).not.toHaveAttribute('aria-haspopup');
  expect(screen.getByRole('heading', { name: 'Prompts' })).toBeInTheDocument();
});

test('without personal skills only global skills show and New creates prompts', async () => {
  mockPlatformConfig = { userPrompts: { enabled: true }, userSkills: { enabled: false } };
  renderLibrary('/prompts?type=skills');
  await waitFor(() => expect(screen.getAllByTestId('skill-card')).toHaveLength(1));
  expect(fetchUserSkills).not.toHaveBeenCalled();
  expect(cardNames()).toEqual(['brand-voice']);
  expect(screen.getByRole('button', { name: 'New prompt' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Copy to my skills' })).not.toBeInTheDocument();
});
