/**
 * "Save as skill" reads the skill a chat answer drafts — a SKILL.md in a code
 * block, as the skill-builder skill hands it over — and "Create skill with
 * AI" opens a chat app that has the skill-builder skill.
 */
import {
  fencedBlocks,
  findSkillDraft,
  parseSkillMarkdown
} from '../../../client/src/features/skills/utils/skillDraft';

jest.mock('../../../client/src/shared/hooks/useApps', () => () => ({ apps: [] }));
jest.mock('../../../client/src/shared/hooks/useFavorites', () => () => ({ favorites: [] }));
jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  useUIConfig: () => ({ uiConfig: {} })
}));
import {
  findSkillBuilderApp,
  runsSkillBuilder
} from '../../../client/src/features/skills/hooks/useSkillBuilder';

const SKILL_MD = [
  '---',
  'name: weekly-status-report',
  'description: "Drafts the weekly status report. Use when the user asks for a \\"weekly report\\"."',
  '---',
  '',
  '# Weekly status report',
  '',
  '## Output format',
  '',
  '```',
  '**Highlights**',
  '- [highlight]',
  '```'
].join('\n');

const ANSWER = [
  'Here is your skill:',
  '',
  '````markdown',
  SKILL_MD,
  '````',
  '',
  '```markdown references/style-guide.md',
  '# Style guide',
  'Short sentences.',
  '```',
  '',
  '**`references/glossary.csv`**',
  '',
  '```csv',
  'term,meaning',
  '```',
  '',
  'Folder layout:',
  '',
  '```',
  'weekly-status-report/',
  '└── SKILL.md',
  '```',
  '',
  'Click **Save as skill** below to save it.'
].join('\n');

describe('fencedBlocks', () => {
  test('keeps shorter fences inside a longer one', () => {
    const blocks = fencedBlocks(ANSWER);
    expect(blocks.map(block => block.info)).toEqual([
      'markdown',
      'markdown references/style-guide.md',
      'csv',
      ''
    ]);
    expect(blocks[0].content).toBe(SKILL_MD);
    expect(blocks[2].precedingLine).toBe('**`references/glossary.csv`**');
  });

  test('runs an unclosed block to the end', () => {
    expect(fencedBlocks('text\n```md\nopen').map(block => block.content)).toEqual(['open']);
  });
});

describe('parseSkillMarkdown', () => {
  test('reads name, description and the instructions', () => {
    expect(parseSkillMarkdown(SKILL_MD)).toEqual({
      name: 'weekly-status-report',
      description: 'Drafts the weekly status report. Use when the user asks for a "weekly report".',
      body: SKILL_MD.split('---\n\n')[1]
    });
  });

  test('reads plain, single-quoted, folded and literal descriptions and skips nested keys', () => {
    const read = frontmatter => parseSkillMarkdown(`---\n${frontmatter}\n---\nBODY`);
    expect(read('name: a\ndescription: Plain text. # comment').description).toBe('Plain text.');
    expect(read("name: a\ndescription: 'It''s quoted'").description).toBe("It's quoted");
    expect(read('name: a\ndescription: >-\n  Folded\n  over lines.\nmetadata:\n  x: 1')).toEqual({
      name: 'a',
      description: 'Folded over lines.',
      body: 'BODY'
    });
    expect(read('name: a\ndescription: |\n  Line one\n  Line two').description).toBe(
      'Line one\nLine two'
    );
    expect(read('name: a\ndescription: "Spans\n  two lines"').description).toBe('Spans two lines');
  });

  test('is null without frontmatter, name, description or instructions', () => {
    expect(parseSkillMarkdown('# Just text')).toBeNull();
    expect(parseSkillMarkdown('---\nname: a\n---\nBODY')).toBeNull();
    expect(parseSkillMarkdown('---\ndescription: d\n---\nBODY')).toBeNull();
    expect(parseSkillMarkdown('---\nname: a\ndescription: d\n---\n')).toBeNull();
    expect(parseSkillMarkdown('---\nname: a\ndescription: d\nBODY')).toBeNull();
  });
});

describe('findSkillDraft', () => {
  test('takes the SKILL.md and the files labelled with their path', () => {
    expect(findSkillDraft(ANSWER)).toEqual({
      name: 'weekly-status-report',
      description: 'Drafts the weekly status report. Use when the user asks for a "weekly report".',
      body: expect.stringContaining('# Weekly status report'),
      files: [
        { path: 'references/style-guide.md', content: '# Style guide\nShort sentences.' },
        { path: 'references/glossary.csv', content: 'term,meaning' }
      ]
    });
  });

  test('takes the last draft, and one labelled SKILL.md over unlabelled ones', () => {
    const first = SKILL_MD.replace('weekly-status-report', 'first-draft');
    const second = SKILL_MD.replace('weekly-status-report', 'second-draft');
    expect(findSkillDraft(`\`\`\`\`\n${first}\n\`\`\`\`\n\`\`\`\`\n${second}\n\`\`\`\``).name).toBe(
      'second-draft'
    );
    expect(
      findSkillDraft(`\`\`\`\`markdown SKILL.md\n${first}\n\`\`\`\`\n\`\`\`\`\n${second}\n\`\`\`\``)
        .name
    ).toBe('first-draft');
  });

  test('reads an answer that is a bare SKILL.md', () => {
    expect(findSkillDraft(SKILL_MD)).toMatchObject({ name: 'weekly-status-report', files: [] });
  });

  test('finds nothing in an ordinary answer', () => {
    expect(findSkillDraft('Sure — here is a summary.\n\n---\n\nDone.')).toBeNull();
    expect(findSkillDraft('```yaml\nname: x\n```')).toBeNull();
    expect(findSkillDraft(undefined)).toBeNull();
  });
});

describe('findSkillBuilderApp', () => {
  const skills = [{ name: 'skill-builder' }, { name: 'brand-voice' }];
  const apps = [
    { id: 'translator', order: 1, skills: ['brand-voice'] },
    { id: 'writer', order: 3, skills: ['skill-builder'] },
    { id: 'chat', order: 2, skills: ['skill-builder'] },
    { id: 'site', type: 'iframe', order: 0, skills: ['skill-builder'] }
  ];

  test('picks the first chat app that has the skill', () => {
    expect(findSkillBuilderApp(apps, skills)?.id).toBe('chat');
  });

  test('prefers the start page app when it has the skill', () => {
    const uiConfig = { startPage: { defaultAppId: 'writer' } };
    expect(findSkillBuilderApp(apps, skills, { uiConfig })?.id).toBe('writer');
  });

  test('is null when the skill is not granted or no app has it', () => {
    expect(findSkillBuilderApp(apps, [{ name: 'brand-voice' }])).toBeNull();
    expect(findSkillBuilderApp([apps[0]], skills)).toBeNull();
  });

  test('prefers an app built around the skill over the start page app', () => {
    const builder = {
      id: 'skill-builder',
      order: 9,
      skills: ['skill-builder'],
      skillSettings: { autoActivate: true }
    };
    const uiConfig = { startPage: { defaultAppId: 'chat' } };
    expect(findSkillBuilderApp([...apps, builder], skills, { uiConfig })?.id).toBe('skill-builder');
    expect(runsSkillBuilder(builder)).toBe(true);
    expect(runsSkillBuilder(apps[2])).toBe(false);
  });
});
