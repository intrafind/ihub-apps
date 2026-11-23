// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import CreateMenu from '../../../client/src/shared/components/CreateMenu';

/**
 * The sidebar's "Create" (+) menu. Each entry is gated like the create button
 * of its own page, the whole control disappears when nothing can be created,
 * it is a keyboard-operable menu button, and each entry lands on the page that
 * creates the thing (with the request for the dialog in the navigation state).
 */

const mockTranslation = {
  t: (key, options) => (typeof options === 'string' ? options : key),
  i18n: { language: 'en' }
};
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => mockTranslation
}));

const mockState = {};
function reset(overrides = {}) {
  Object.assign(mockState, {
    isAuthenticated: true,
    platformConfig: { userPrompts: { enabled: true }, userSkills: { enabled: true } },
    uiConfig: {},
    flags: { promptsLibrary: true, skills: true },
    userApps: { enabled: true, config: { canCreate: true } },
    projectsAvailable: true,
    projectsConfig: { userProjects: { enabled: true, canCreate: true } },
    tasksAvailable: true,
    canCreateTasks: true,
    ...overrides
  });
}

jest.mock('../../../client/src/shared/contexts/AuthContext', () => ({
  __esModule: true,
  useAuth: () => ({ isAuthenticated: mockState.isAuthenticated })
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  __esModule: true,
  usePlatformConfig: () => ({ platformConfig: mockState.platformConfig, isLoading: false })
}));
jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  __esModule: true,
  useUIConfig: () => ({ uiConfig: mockState.uiConfig })
}));
jest.mock('../../../client/src/shared/hooks/useFeatureFlags', () => ({
  __esModule: true,
  default: () => ({
    isEnabled: (flag, fallback = false) =>
      flag in mockState.flags ? mockState.flags[flag] : fallback
  })
}));
jest.mock('../../../client/src/shared/hooks/useUserApps', () => ({
  __esModule: true,
  useUserAppsConfig: () => mockState.userApps
}));
jest.mock('../../../client/src/features/projects/hooks/useProjects', () => ({
  __esModule: true,
  useProjectsAvailability: () => ({ userProjectsEnabled: mockState.projectsAvailable }),
  useProjectsConfig: () => ({
    config: mockState.projectsAvailable ? mockState.projectsConfig : null
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
jest.mock('../../../client/src/features/tasks/hooks/useScheduledTasks', () => ({
  __esModule: true,
  useScheduledTasksAvailable: () => mockState.tasksAvailable,
  useCanCreateScheduledTasks: () => mockState.canCreateTasks
}));

let lastLocation;
function LocationProbe() {
  lastLocation = useLocation();
  return null;
}

function renderMenu(props = {}) {
  return render(
    <MemoryRouter initialEntries={['/start']}>
      <CreateMenu variant="expanded" {...props} />
      <LocationProbe />
    </MemoryRouter>
  );
}

const button = () => screen.getByRole('button', { name: 'Create' });
const itemNames = () => screen.getAllByRole('menuitem').map(item => item.textContent);

beforeEach(() => {
  reset();
  lastLocation = null;
});

describe('entries', () => {
  test('everything allowed: all five entries in order', () => {
    renderMenu();
    fireEvent.click(button());
    expect(itemNames()).toEqual(['App', 'Project', 'Skill', 'Prompt', 'Scheduled task']);
  });

  test('personal apps off or no permission: no App entry', () => {
    reset({ userApps: { enabled: false, config: null } });
    const { unmount } = renderMenu();
    fireEvent.click(button());
    expect(itemNames()).not.toContain('App');
    unmount();

    reset({ userApps: { enabled: true, config: { canCreate: false } } });
    renderMenu();
    fireEvent.click(button());
    expect(itemNames()).not.toContain('App');
  });

  test('projects: needs user projects and canCreate', () => {
    reset({ projectsConfig: { userProjects: { enabled: true, canCreate: false } } });
    const { unmount } = renderMenu();
    fireEvent.click(button());
    expect(itemNames()).not.toContain('Project');
    unmount();

    reset({ projectsAvailable: false });
    renderMenu();
    fireEvent.click(button());
    expect(itemNames()).not.toContain('Project');
  });

  test('projects: hidden at the project limit, shown below it', () => {
    reset({
      projectsConfig: { userProjects: { enabled: true, canCreate: true, maxProjects: 3, used: 3 } }
    });
    const { unmount } = renderMenu();
    fireEvent.click(button());
    expect(itemNames()).not.toContain('Project');
    unmount();

    reset({
      projectsConfig: { userProjects: { enabled: true, canCreate: true, maxProjects: 3, used: 2 } }
    });
    renderMenu();
    fireEvent.click(button());
    expect(itemNames()).toContain('Project');
  });

  test('skills need the skills feature and personal skills', () => {
    reset({ flags: { promptsLibrary: true, skills: false } });
    const { unmount } = renderMenu();
    fireEvent.click(button());
    expect(itemNames()).not.toContain('Skill');
    expect(itemNames()).toContain('Prompt');
    unmount();

    reset({ platformConfig: { userPrompts: { enabled: true }, userSkills: { enabled: false } } });
    renderMenu();
    fireEvent.click(button());
    expect(itemNames()).not.toContain('Skill');
  });

  test('library off: neither prompts nor skills', () => {
    reset({ uiConfig: { promptsList: { enabled: false } } });
    const { unmount } = renderMenu();
    fireEvent.click(button());
    expect(itemNames()).toEqual(['App', 'Project', 'Scheduled task']);
    unmount();

    reset({ flags: { promptsLibrary: false, skills: true } });
    renderMenu();
    fireEvent.click(button());
    expect(itemNames()).toEqual(['App', 'Project', 'Scheduled task']);
  });

  test('scheduled tasks need the feature and the permission', () => {
    reset({ canCreateTasks: false });
    const { unmount } = renderMenu();
    fireEvent.click(button());
    expect(itemNames()).not.toContain('Scheduled task');
    unmount();

    reset({ tasksAvailable: false });
    renderMenu();
    fireEvent.click(button());
    expect(itemNames()).not.toContain('Scheduled task');
  });

  test('anonymous viewer with nothing to create: the control is not rendered', () => {
    reset({
      isAuthenticated: false,
      userApps: { enabled: false, config: null },
      projectsAvailable: false,
      tasksAvailable: false
    });
    renderMenu();
    expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument();
  });
});

describe('menu button', () => {
  test('announces the menu and its state', () => {
    renderMenu();
    expect(button()).toHaveAttribute('aria-haspopup', 'menu');
    expect(button()).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button());
    expect(button()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  test('keyboard: ArrowDown opens on the first entry, arrows wrap, Escape returns focus', () => {
    renderMenu();
    button().focus();
    fireEvent.keyDown(button(), { key: 'ArrowDown' });
    const items = screen.getAllByRole('menuitem');
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(items[1], { key: 'End' });
    expect(items[items.length - 1]).toHaveFocus();
    fireEvent.keyDown(items[items.length - 1], { key: 'ArrowDown' });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0], { key: 'ArrowUp' });
    expect(items[items.length - 1]).toHaveFocus();
    fireEvent.keyDown(items[items.length - 1], { key: 'Home' });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0], { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button()).toHaveFocus();
  });

  test('ArrowUp opens on the last entry', () => {
    renderMenu();
    fireEvent.keyDown(button(), { key: 'ArrowUp' });
    const items = screen.getAllByRole('menuitem');
    expect(items[items.length - 1]).toHaveFocus();
  });

  test('a click outside closes it', () => {
    renderMenu();
    fireEvent.click(button());
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

describe('navigation targets', () => {
  test.each([
    ['App', '/apps/new', null],
    ['Project', '/projects', { create: 'project' }],
    ['Skill', '/prompts', { create: 'skill' }],
    ['Prompt', '/prompts', { create: 'prompt' }],
    ['Scheduled task', '/tasks/new', null]
  ])('%s → %s', (name, pathname, state) => {
    const onNavigate = jest.fn();
    renderMenu({ onNavigate });
    fireEvent.click(button());
    fireEvent.click(screen.getByRole('menuitem', { name }));
    expect(lastLocation.pathname).toBe(pathname);
    expect(lastLocation.state ?? null).toEqual(state);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  test('the rail variant renders the same menu', () => {
    renderMenu({ variant: 'rail' });
    expect(screen.getByTestId('sidebar-create-rail')).toBeInTheDocument();
    fireEvent.click(button());
    expect(itemNames()).toHaveLength(5);
  });
});
