/**
 * Which skills the `/` picker offers, and where. Global skills stay narrowed
 * to the app's `skills` list; personal skills (the user's own and those shared
 * with them) are offered in every app unless it sets
 * `skillSettings.allowPersonal: false`, in their own groups after the global
 * skills. Selecting one hands the entry to the chat input, which inserts
 * `/<name> ` (see chat-input-slash-picker.test.jsx).
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, options) => (typeof options === 'string' ? options : (options?.defaultValue ?? key)),
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/api', () => ({
  fetchPrompts: jest.fn(() => Promise.resolve([]))
}));

jest.mock('../../../client/src/api/endpoints/skills', () => ({
  fetchSkills: jest.fn()
}));

jest.mock('../../../client/src/features/prompts/hooks/usePromptPreferences', () => () => ({
  favorites: [],
  recents: [],
  recordUsage: jest.fn()
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

// The list as the modal would show it before a query: grouped, in order.
jest.mock('../../../client/src/shared/components/SearchModal', () => ({
  __esModule: true,
  default: ({ items, getGroupLabel, onSelect }) => (
    <ul>
      {items.map(item => (
        <li key={`${item._type}:${item.id}`} data-group={getGroupLabel(item)}>
          <button type="button" onClick={() => onSelect(item)}>
            {item.name}
          </button>
        </li>
      ))}
    </ul>
  )
}));

import { fetchPrompts } from '../../../client/src/api';
import { fetchSkills } from '../../../client/src/api/endpoints/skills';
import PromptSearch from '../../../client/src/features/prompts/components/PromptSearch';
import {
  PICKER_SKILL_GROUPS,
  selectPickerSkills
} from '../../../client/src/features/skills/utils/skillPicker';

const PICKER_LIST = [
  { id: 'brand-voice', name: 'brand-voice', description: 'Global, assigned', scope: 'global' },
  {
    id: 'legal-review',
    name: 'legal-review',
    description: 'Global, not assigned',
    scope: 'global'
  },
  // A server that predates personal skills sends no scope and no id.
  { name: 'old-style', description: 'Global without scope' },
  {
    id: 'usk_mine1',
    name: 'weekly-report',
    description: 'Mine',
    scope: 'mine',
    owner: { name: 'Me' }
  },
  {
    id: 'usk_shared1',
    name: 'team-notes',
    description: 'Shared',
    scope: 'shared',
    owner: { name: 'Jane' }
  }
];

describe('selectPickerSkills', () => {
  test('global skills need the app to list them; personal ones do not', () => {
    const result = selectPickerSkills(PICKER_LIST, { appSkills: ['brand-voice', 'old-style'] });
    expect(result.map(skill => [skill.id, skill.scope, skill.group])).toEqual([
      ['brand-voice', 'global', 'skill'],
      ['old-style', 'global', 'skill'],
      ['usk_mine1', 'mine', 'skillMine'],
      ['usk_shared1', 'shared', 'skillShared']
    ]);
  });

  test('an app without skills still offers personal skills', () => {
    const result = selectPickerSkills(PICKER_LIST, { appSkills: [] });
    expect(result.map(skill => skill.id)).toEqual(['usk_mine1', 'usk_shared1']);
    expect(selectPickerSkills(PICKER_LIST).map(skill => skill.id)).toEqual([
      'usk_mine1',
      'usk_shared1'
    ]);
  });

  test('allowPersonal: false leaves only the assigned global skills', () => {
    const result = selectPickerSkills(PICKER_LIST, {
      appSkills: ['brand-voice'],
      allowPersonal: false
    });
    expect(result.map(skill => skill.id)).toEqual(['brand-voice']);
  });

  test('a personal skill whose name matches an app skill is still a personal skill', () => {
    const result = selectPickerSkills(
      [{ id: 'usk_x', name: 'brand-voice', scope: 'mine', description: '' }],
      { appSkills: ['brand-voice'], allowPersonal: false }
    );
    expect(result).toEqual([]);
  });

  test('entries are ready for the search list', () => {
    const [skill] = selectPickerSkills([{ name: 'old-style' }], { appSkills: ['old-style'] });
    expect(skill).toMatchObject({
      _type: 'skill',
      id: 'old-style',
      scope: 'global',
      group: PICKER_SKILL_GROUPS.global,
      description: '',
      ownerName: ''
    });
    const [shared] = selectPickerSkills([PICKER_LIST[4]]);
    expect(shared.ownerName).toBe('Jane');
  });

  test('tolerates a missing or malformed list', () => {
    expect(selectPickerSkills(undefined)).toEqual([]);
    expect(selectPickerSkills([null, {}, { description: 'no name' }])).toEqual([]);
  });
});

describe('PromptSearch skill groups', () => {
  beforeEach(() => {
    fetchSkills.mockReset();
    fetchSkills.mockResolvedValue(PICKER_LIST);
    fetchPrompts.mockClear();
  });

  const groupsShown = () =>
    screen.getAllByRole('listitem').map(item => [item.textContent, item.dataset.group]);

  test('global skills of the app first, then my skills, then shared skills', async () => {
    render(
      <PromptSearch isOpen onClose={() => {}} onSelect={() => {}} appSkills={['brand-voice']} />
    );
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));
    expect(groupsShown()).toEqual([
      ['brand-voice', 'Skills'],
      ['weekly-report', 'My skills'],
      ['team-notes', 'Shared skills']
    ]);
  });

  test('an app that turns personal skills off shows only its own skills', async () => {
    render(
      <PromptSearch
        isOpen
        onClose={() => {}}
        onSelect={() => {}}
        appSkills={['brand-voice']}
        allowPersonalSkills={false}
      />
    );
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    expect(groupsShown()).toEqual([['brand-voice', 'Skills']]);
  });

  test('without skills enabled nothing is fetched and no skill is offered', async () => {
    render(
      <PromptSearch
        isOpen
        onClose={() => {}}
        onSelect={() => {}}
        appSkills={['brand-voice']}
        skillsEnabled={false}
      />
    );
    await waitFor(() => expect(fetchPrompts).toHaveBeenCalled());
    expect(fetchSkills).not.toHaveBeenCalled();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  test('selecting a personal skill hands over the entry with its name and id', async () => {
    const onSelect = jest.fn(() => true);
    render(<PromptSearch isOpen onClose={() => {}} onSelect={onSelect} appSkills={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'weekly-report' }));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ _type: 'skill', id: 'usk_mine1', name: 'weekly-report' })
    );
  });
});
