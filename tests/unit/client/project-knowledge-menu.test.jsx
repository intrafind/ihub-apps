// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The knowledge mode of a chat (#3538) is chosen in the "+" menu, as the row
 * "Project knowledge" with an in-place list. The composer shows only an
 * override, as a chip that takes it back; the dropdown beside the project chip
 * is gone.
 */
import { render, screen, fireEvent, renderHook } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import { useRef } from 'react';

let mockAvailability = { userProjectsEnabled: true, knowledgeModes: ['auto', 'context', 'pinned'] };
jest.mock('../../../client/src/features/projects/hooks/useProjects', () => ({
  useMyProjects: () => ({ projects: [{ id: 'prj_a', name: 'Handbook' }] }),
  useProjectsAvailability: () => mockAvailability
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, defaultOrOptions, maybeOptions) => {
      const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions || {};
      const text = typeof defaultOrOptions === 'string' ? defaultOrOptions : key;
      return Object.entries(options).reduce(
        (out, [name, value]) => out.replaceAll(`{{${name}}}`, value),
        text
      );
    },
    i18n: { language: 'en' }
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid={`icon-${name}`} />
}));
jest.mock('../../../client/src/shared/components/MagicPromptLoader', () => () => null);
jest.mock('../../../client/src/features/chat/components/ImageGenerationControls', () => () => null);
jest.mock('../../../client/src/features/voice/components', () => ({
  VoiceInputComponent: () => null
}));
jest.mock('../../../client/src/api', () => ({
  saveIntegrationPreferences: jest.fn(() => Promise.resolve({}))
}));
jest.mock('../../../client/src/features/office/contexts/EmbeddedHostContext', () => ({
  useEmbeddedHost: () => null
}));

const {
  useProjectKnowledgeMenu
} = require('../../../client/src/features/projects/hooks/useProjectKnowledgeMenu');
const ChatProjectChips =
  require('../../../client/src/features/projects/components/ChatProjectChips').default;
const ChatInputActionsMenu =
  require('../../../client/src/features/chat/components/ChatInputActionsMenu').default;
const SubmenuRow = require('../../../client/src/features/integrations/picker/SubmenuRow').default;
const { useKeyboardNavigation } = require('../../../client/src/shared/hooks/useKeyboardNavigation');
const {
  chatKnowledgeModes
} = require('../../../client/src/features/projects/utils/knowledgeModes');

const context = (overrides = {}) => ({
  containerProjectId: 'prj_a',
  value: [],
  disabled: false,
  attached: { toggle: jest.fn(), saving: false, error: null },
  knowledgeMode: { value: '', set: jest.fn(), saving: false, error: null },
  ...overrides
});

beforeEach(() => {
  mockAvailability = { userProjectsEnabled: true, knowledgeModes: ['auto', 'context', 'pinned'] };
});

describe('chatKnowledgeModes', () => {
  test('offers automatic, everything and pinned; retrieval modes stay on the project page', () => {
    expect(chatKnowledgeModes(['auto', 'context', 'relevant', 'tools', 'pinned'])).toEqual([
      'auto',
      'context',
      'pinned'
    ]);
  });

  test('narrows to what the platform allows, and keeps the chat’s own mode', () => {
    expect(chatKnowledgeModes(['auto', 'pinned'])).toEqual(['auto', 'pinned']);
    expect(chatKnowledgeModes(['auto'], 'tools')).toEqual(['auto', 'tools']);
    expect(chatKnowledgeModes(['auto'], 'nonsense')).toEqual(['auto']);
  });
});

describe('useProjectKnowledgeMenu', () => {
  const run = projectContext =>
    renderHook(() => useProjectKnowledgeMenu(projectContext)).result.current;

  test('offers the row for a chat with a project', () => {
    const menu = run(context({ value: ['prj_b'] }));
    expect(menu).toMatchObject({
      value: '',
      modes: ['auto', 'context', 'pinned'],
      projectCount: 2
    });
  });

  test.each([
    ['no project context', null],
    ['no project in the chat', context({ containerProjectId: null })],
    ['a chat that takes no mode', context({ knowledgeMode: undefined })]
  ])('offers nothing for %s', (_name, projectContext) => {
    expect(run(projectContext)).toBeNull();
  });

  test('offers nothing when user projects are off', () => {
    mockAvailability = { ...mockAvailability, userProjectsEnabled: false };
    expect(run(context())).toBeNull();
  });

  test('offers nothing when the platform leaves no choice', () => {
    mockAvailability = { ...mockAvailability, knowledgeModes: ['auto', 'relevant'] };
    expect(run(context())).toBeNull();
  });

  test('still offers the row when the chat holds a mode the platform has since switched off', () => {
    mockAvailability = { ...mockAvailability, knowledgeModes: ['auto'] };
    const menu = run(context({ knowledgeMode: { value: 'pinned', set: jest.fn() } }));
    expect(menu.modes).toEqual(['auto', 'pinned']);
  });
});

describe('project chips', () => {
  const renderChips = projectContext =>
    render(
      <MemoryRouter>
        <ChatProjectChips projectContext={projectContext} />
      </MemoryRouter>
    );

  test('have no dropdown, and no chip while the project decides', () => {
    renderChips(context());
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-knowledge-mode-chip')).not.toBeInTheDocument();
  });

  test('show an override as a chip that takes it back in one click', () => {
    const projectContext = context({
      knowledgeMode: { value: 'pinned', set: jest.fn(), saving: false, error: null }
    });
    renderChips(projectContext);

    const chip = screen.getByRole('button', {
      name: 'Project knowledge: Pinned documents only. Click to use the project default.'
    });
    fireEvent.click(chip);
    expect(projectContext.knowledgeMode.set).toHaveBeenCalledWith('');
  });

  test('announce the mode for screen readers', () => {
    renderChips(context({ knowledgeMode: { value: 'context', set: jest.fn() } }));
    expect(screen.getByText('Project knowledge: Read everything')).toHaveAttribute(
      'aria-live',
      'polite'
    );
  });

  test('keep showing a failed change', () => {
    renderChips(
      context({ knowledgeMode: { value: '', set: jest.fn(), error: 'Could not save.' } })
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save.');
  });
});

describe('"+" menu', () => {
  const renderMenu = (projectKnowledge, props = {}) => {
    render(
      <ChatInputActionsMenu
        app={{ id: 'demo' }}
        enabledTools={null}
        uploadConfig={{}}
        projectKnowledge={projectKnowledge}
        {...props}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Actions menu' }));
  };
  const menuOf = (overrides = {}) => ({
    value: '',
    modes: ['auto', 'context', 'pinned'],
    onChange: jest.fn(),
    disabled: false,
    projectCount: 1,
    ...overrides
  });

  test('has the row even where nothing else would give the chat a menu', () => {
    renderMenu(menuOf());
    expect(
      screen.getByRole('menuitem', { name: 'Project knowledge: Project default' })
    ).toBeVisible();
    expect(screen.queryByText('This app uses no integrations.')).not.toBeInTheDocument();
    expect(screen.queryByText('Use in this chat')).not.toBeInTheDocument();
  });

  test('has no row without it', () => {
    renderMenu(null, {
      websearchEnabled: false,
      app: { id: 'demo', websearch: { enabled: true } },
      onWebsearchEnabledChange: jest.fn()
    });
    expect(screen.queryByText('Project knowledge')).not.toBeInTheDocument();
  });

  test('opens in place, lists the modes a chat may pick, and marks the current one', () => {
    renderMenu(menuOf({ value: 'pinned' }));
    const row = screen.getByRole('menuitem', { name: 'Project knowledge: Pinned documents only' });
    expect(row).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(row);

    expect(row).toHaveAttribute('aria-expanded', 'true');
    const radios = screen.getAllByRole('menuitemradio');
    expect(radios.map(radio => radio.getAttribute('data-option'))).toEqual([
      'inherit',
      'auto',
      'context',
      'pinned'
    ]);
    expect(screen.getByRole('menuitemradio', { name: /Pinned documents only/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByText('Override for this chat')).toBeInTheDocument();
    // One project: nothing to say about "all projects".
    expect(screen.queryByText('Applies to all projects in this chat.')).not.toBeInTheDocument();
  });

  test('says the choice covers every project when the chat has several', () => {
    renderMenu(menuOf({ projectCount: 2 }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Project knowledge/ }));
    expect(screen.getByText('Applies to all projects in this chat.')).toBeInTheDocument();
  });

  test('a pick sets the mode and closes the menu', () => {
    const projectKnowledge = menuOf();
    renderMenu(projectKnowledge);
    fireEvent.click(screen.getByRole('menuitem', { name: /Project knowledge/ }));

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Read everything/ }));

    expect(projectKnowledge.onChange).toHaveBeenCalledWith('context');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  test('the empty entry gives the decision back to the project', () => {
    const projectKnowledge = menuOf({ value: 'context' });
    renderMenu(projectKnowledge);
    fireEvent.click(screen.getByRole('menuitem', { name: /Project knowledge/ }));

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Project default/ }));

    expect(projectKnowledge.onChange).toHaveBeenCalledWith('');
  });

  test('opens with Enter and ArrowRight, closes with ArrowLeft and Escape and keeps the menu', () => {
    renderMenu(menuOf());
    const row = screen.getByRole('menuitem', { name: /Project knowledge/ });

    fireEvent.keyDown(row, { key: 'ArrowRight' });
    expect(row).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: /Automatic/ }), {
      key: 'ArrowLeft'
    });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(row).toHaveFocus();

    fireEvent.keyDown(row, { key: 'Enter' });
    expect(row).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(row, { key: 'Escape' });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  test('is found by the search field', () => {
    renderMenu(menuOf());
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'knowledge' } });
    expect(screen.getByRole('menuitem', { name: /Project knowledge/ })).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
    expect(screen.queryByRole('menuitem', { name: /Project knowledge/ })).not.toBeInTheDocument();
    expect(screen.getByText('No integrations match.')).toBeInTheDocument();
  });

  test('cannot be opened while a change is saved', () => {
    renderMenu(menuOf({ disabled: true }));
    const row = screen.getByRole('menuitem', { name: /Project knowledge/ });
    fireEvent.click(row);
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0);
    expect(row).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('SubmenuRow', () => {
  test('a locked row shows why and does not open', () => {
    render(
      <SubmenuRow
        id="profile"
        title="Search profile"
        valueLabel="Standard"
        options={[{ id: 'a', label: 'A' }]}
        selectedId="a"
        onSelect={jest.fn()}
        locked
        lockedReason="Set by the app. Cannot be changed here."
      />
    );
    const row = screen.getByRole('menuitem', { name: 'Search profile: Standard' });
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(row).toHaveAccessibleDescription('Set by the app. Cannot be changed here.');
    fireEvent.click(row);
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0);
  });
});

describe('Escape in a menu with an open submenu', () => {
  // jsdom has no layout: give every element a size so the hook sees its items.
  let offsetWidth;
  let offsetParent;
  beforeAll(() => {
    offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => 10
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get() {
        return this.parentNode;
      }
    });
  });
  afterAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth);
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent);
  });

  function Menu({ onClose }) {
    const ref = useRef(null);
    useKeyboardNavigation(ref, { isActive: true, onClose });
    return (
      <div ref={ref} role="menu">
        <div role="menuitem">Plain</div>
        <SubmenuRow
          id="sub"
          title="Sub"
          valueLabel="One"
          options={[{ id: 'one', label: 'One' }]}
          selectedId="one"
          onSelect={jest.fn()}
        />
      </div>
    );
  }

  test('closes the submenu first, the menu second', () => {
    const onClose = jest.fn();
    render(<Menu onClose={onClose} />);
    const row = screen.getByRole('menuitem', { name: 'Sub: One' });
    fireEvent.click(row);

    fireEvent.keyDown(screen.getByRole('menuitemradio'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(row).toHaveAttribute('aria-expanded', 'false');

    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Plain' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
