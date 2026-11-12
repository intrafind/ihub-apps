// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The chip under an answer says what it is based on: only the kinds of source
 * the server named (`run/ended.answerBasis`), and "About this answer" opens
 * behind it. Every state of the design (#3619) in English and German, and the
 * keyboard and screen-reader behaviour of the popover.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';

const en = require('../../../shared/i18n/en.json');
const de = require('../../../shared/i18n/de.json');

let mockLanguage = 'en';
const lookup = (key, language) =>
  key.split('.').reduce((node, part) => node?.[part], language === 'de' ? de : en);
/** i18next's lookup as far as the chip needs it: plural keys and {{interpolation}}. */
const mockT = (key, defaultOrOptions, maybeOptions) => {
  const options = typeof defaultOrOptions === 'object' ? defaultOrOptions : maybeOptions;
  const count = options?.count;
  const plural = Number.isFinite(count) ? `${key}_${count === 1 ? 'one' : 'other'}` : null;
  const found = (plural && lookup(plural, mockLanguage)) ?? lookup(key, mockLanguage);
  let text = String(found ?? (typeof defaultOrOptions === 'string' ? defaultOrOptions : key));
  for (const [name, value] of Object.entries(options || {})) {
    text = text.replaceAll(`{{${name}}}`, String(value));
  }
  return text;
};
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: mockLanguage } })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));

const AnswerBasis = require('../../../client/src/features/chat/components/AnswerBasis').default;

const renderBasis = props =>
  render(
    <MemoryRouter>
      <AnswerBasis {...props} />
    </MemoryRouter>
  );

const chip = () => screen.getByTestId('answer-basis-chip');
const open = () => fireEvent.click(chip());
const panel = () => screen.getByTestId('answer-basis-panel');
const headings = () =>
  within(panel())
    .getAllByRole('heading')
    .map(h => h.textContent);

const PROJECT = { id: 'prj_case', name: 'Case 2026-114', mode: 'loaded', contributed: true };
const PROVENANCE = {
  ai_generated: true,
  model: { id: 'gpt-x' },
  content_hash: { alg: 'sha-256', value: 'a'.repeat(64) },
  output_id: '01JC0000000000000000000000'
};

beforeEach(() => {
  mockLanguage = 'en';
});

describe('the chip names the kinds of source, nothing else', () => {
  it('project only: "Project", no mode, no name, no "configured sources"', () => {
    renderBasis({ answerBasis: [{ kind: 'project' }], knowledgeScope: { projects: [PROJECT] } });
    expect(chip()).toHaveTextContent('Project');
    expect(chip()).not.toHaveTextContent('Case 2026-114');
    expect(chip()).not.toHaveTextContent(/loaded|all documents|searched/i);
    expect(screen.queryByText(/configured sources/i)).not.toBeInTheDocument();
    expect(chip()).toHaveAccessibleName('About this answer: based on project');
  });

  it('project and web search: "Project · Web", never "multiple sources"', () => {
    renderBasis({ answerBasis: [{ kind: 'project' }, { kind: 'web' }] });
    expect(chip().textContent).toBe('Project·Web');
    expect(screen.queryByText(/multiple sources/i)).not.toBeInTheDocument();
    expect(chip()).toHaveAccessibleName('About this answer: based on project and web');
  });

  it('an integration is named by its own label, and two integrations are two entries', () => {
    renderBasis({
      answerBasis: [
        { kind: 'integration', label: 'Jira' },
        { kind: 'integration', label: 'Munich AD' }
      ]
    });
    expect(chip().textContent).toBe('Jira·Munich AD');
    expect(chip()).toHaveAccessibleName('About this answer: based on Jira and Munich AD');
  });

  it('names at most two kinds, then "+N"; the accessible name keeps all of them', () => {
    renderBasis({
      answerBasis: [{ kind: 'project' }, { kind: 'web' }, { kind: 'integration', label: 'Jira' }]
    });
    expect(chip().textContent).toBe('Project·Web+1');
    expect(screen.getByTestId('answer-basis-more')).toHaveTextContent('+1');
    expect(chip()).toHaveAccessibleName('About this answer: based on project, web, and Jira');
  });

  it('draws every kind with its own icon and noun', () => {
    const cases = [
      ['project', 'Project', 'folder'],
      ['web', 'Web', 'globe-alt'],
      ['ifinder', 'iFinder', 'document-text'],
      ['iassistant', 'iAssistant', 'book-open'],
      ['documents', 'Documents', 'document-duplicate'],
      ['email', 'Email', 'mail'],
      ['file', 'File', 'paper-clip'],
      ['audio', 'Recording', 'microphone'],
      ['integration', 'Integration', 'link'],
      ['model', 'Model knowledge', 'sparkles']
    ];
    for (const [kind, noun, icon] of cases) {
      const { unmount } = renderBasis({ answerBasis: [{ kind }] });
      expect(chip()).toHaveTextContent(noun);
      expect(within(chip()).getAllByTestId('icon')[0]).toHaveAttribute('data-name', icon);
      unmount();
    }
  });

  it('nothing retrieved: "Model knowledge", in gray, never "no sources"', () => {
    renderBasis({ answerBasis: [{ kind: 'model' }] });
    expect(chip()).toHaveTextContent('Model knowledge');
    expect(chip()).toHaveClass('text-gray-600');
    expect(chip()).not.toHaveClass('text-indigo-700');
    expect(screen.queryByText(/no sources/i)).not.toBeInTheDocument();
  });

  it('sources used: indigo', () => {
    renderBasis({ answerBasis: [{ kind: 'web' }] });
    expect(chip()).toHaveClass('text-indigo-700');
  });

  it('is outlined, because it can be clicked (#3521)', () => {
    renderBasis({ answerBasis: [{ kind: 'web' }] });
    expect(chip()).toHaveClass('border');
    expect(chip().className).toMatch(/border-indigo-300/);
  });

  it('shows nothing without a basis the server named: no mapping from the old fields', () => {
    const { container } = renderBasis({
      knowledgeScope: { projects: [PROJECT] },
      answerSource: { sources: ['sources'] },
      provenance: PROVENANCE
    });
    expect(container).toBeEmptyDOMElement();
    const { container: empty } = renderBasis({ answerBasis: [] });
    expect(empty).toBeEmptyDOMElement();
  });
});

describe('a narrow pane drops the nouns, not the information', () => {
  it('two or more kinds keep their icons and drop the nouns under a narrow container', () => {
    renderBasis({ answerBasis: [{ kind: 'project' }, { kind: 'web' }] });
    const nouns = within(chip()).getAllByText(/^(Project|Web)$/);
    for (const noun of nouns) expect(noun).toHaveClass('@max-sm:sr-only');
    expect(chip()).toHaveAccessibleName('About this answer: based on project and web');
  });

  it('a single kind is short and keeps its noun', () => {
    renderBasis({ answerBasis: [{ kind: 'project' }] });
    expect(within(chip()).getByText('Project')).not.toHaveClass('@max-sm:sr-only');
  });

  it('never wraps and never grows past its row', () => {
    renderBasis({ answerBasis: [{ kind: 'model' }] });
    expect(chip()).toHaveClass('whitespace-nowrap');
    expect(chip()).toHaveClass('max-w-full');
  });
});

describe('German', () => {
  beforeEach(() => {
    mockLanguage = 'de';
  });

  it('says "Modellwissen" when nothing was retrieved', () => {
    renderBasis({ answerBasis: [{ kind: 'model' }] });
    expect(chip()).toHaveTextContent('Modellwissen');
    open();
    expect(screen.getByText(/auf Grundlage des Wissens des Modells/)).toBeInTheDocument();
  });

  it('names the kinds and words the sentence in German', () => {
    renderBasis({ answerBasis: [{ kind: 'project' }, { kind: 'web' }] });
    expect(chip().textContent).toBe('Projekt·Web');
    open();
    expect(
      screen.getByText(
        'Diese Antwort wurde von einer KI erstellt, auf Grundlage von Projekt und Web.'
      )
    ).toBeInTheDocument();
    expect(headings()).toEqual(['Zu dieser Antwort', 'KI-generiert', 'Quellen']);
  });

  it('the amber chip is short enough for a taskpane', () => {
    renderBasis({
      answerBasis: [{ kind: 'model' }],
      knowledgeScope: {
        projects: [{ id: 'ifc_1', mode: 'unavailable', reason: 'IFINDER_UNAVAILABLE' }]
      }
    });
    expect(screen.getByTestId('knowledge-scope-missing')).toHaveTextContent(
      'Projekt nicht verfügbar'
    );
  });
});

describe('the popover "About this answer"', () => {
  it('opens with the AI statement and the basis, then sources, not used and details', () => {
    renderBasis({
      answerBasis: [{ kind: 'project' }, { kind: 'web' }],
      knowledgeScope: {
        projects: [
          PROJECT,
          { id: 'prj_old', name: 'Archive', mode: 'searched', contributed: false }
        ]
      },
      provenance: PROVENANCE,
      models: [{ id: 'gpt-x', name: { en: 'GPT X' } }]
    });
    open();
    expect(headings()).toEqual([
      'About this answer',
      'AI-generated',
      'Sources',
      'Not used',
      'Details'
    ]);
    expect(
      screen.getByText('This answer was generated by AI, based on project and web.')
    ).toBeInTheDocument();
    // Details are today's provenance content.
    const details = screen.getByTestId('answer-basis-details');
    expect(within(details).getByTestId('provenance-model')).toHaveTextContent('GPT X (gpt-x)');
    expect(within(details).getByText('Copy hash')).toBeInTheDocument();
    expect(within(details).getByText('01JC0000000000000000000000')).toBeInTheDocument();
  });

  it('model knowledge: the sentence says so and there is no sources section', () => {
    renderBasis({ answerBasis: [{ kind: 'model' }], provenance: PROVENANCE });
    open();
    expect(
      screen.getByText("This answer was generated by AI, based on the model's knowledge.")
    ).toBeInTheDocument();
    expect(headings()).toEqual(['About this answer', 'AI-generated', 'Details']);
  });

  it('a record the server did not send leaves out the details, not the AI statement', () => {
    renderBasis({ answerBasis: [{ kind: 'web' }] });
    open();
    expect(headings()).toEqual(['About this answer', 'AI-generated', 'Sources']);
  });

  it('a project: its name, its mode in plain words, "Open project", and its diagnostics', () => {
    renderBasis({
      answerBasis: [{ kind: 'project' }],
      knowledgeScope: {
        projects: [{ ...PROJECT, knowledgeMode: 'auto', overBudget: true, modeFallback: 'tools' }]
      }
    });
    open();
    const project = screen.getByTestId('answer-basis-project');
    expect(project).toHaveTextContent('Case 2026-114');
    expect(project).toHaveTextContent('all documents read');
    expect(project).toHaveTextContent('Knowledge mode');
    expect(project).toHaveTextContent('over budget');
    expect(project).toHaveTextContent('the model cannot call tools');
    const link = within(project).getByRole('link', { name: 'Open project Case 2026-114' });
    expect(link).toHaveAttribute('href', '/projects/prj_case');
  });

  it('words the three ways a project is used', () => {
    const modes = [
      [{ mode: 'loaded' }, 'all documents read'],
      [{ mode: 'searched' }, 'searched for matching passages'],
      [{ mode: 'searched', excerpted: true }, 'searched for matching passages'],
      [{ mode: 'searched', knowledgeMode: 'pinned' }, 'only pinned documents']
    ];
    for (const [project, text] of modes) {
      const { unmount } = renderBasis({
        answerBasis: [{ kind: 'project' }],
        knowledgeScope: { projects: [{ id: 'prj_a', name: 'A', contributed: true, ...project }] }
      });
      open();
      expect(screen.getByTestId('answer-basis-project')).toHaveTextContent(text);
      unmount();
    }
  });

  it('an admin project has no page to link to; a shared chat does not know the project', () => {
    renderBasis({
      answerBasis: [{ kind: 'project' }],
      knowledgeScope: {
        projects: [
          { id: 'faq', name: 'FAQ', mode: 'loaded', contributed: true },
          { id: null, name: null, mode: 'searched', contributed: true }
        ]
      }
    });
    open();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('Private project')).toBeInTheDocument();
  });

  it('a project in scope that was not used is never on the chip; it is listed under "Not used"', () => {
    renderBasis({
      answerBasis: [{ kind: 'model' }],
      knowledgeScope: {
        projects: [{ id: 'prj_a', name: 'Alpha', mode: 'searched', contributed: false }]
      }
    });
    expect(chip()).not.toHaveTextContent('Project');
    open();
    const unused = screen.getByTestId('answer-basis-not-used');
    expect(unused).toHaveTextContent('Alpha');
    expect(unused).toHaveTextContent('nothing from it went into this answer');
    expect(screen.queryByTestId('answer-basis-sources')).not.toBeInTheDocument();
  });

  it('an integration is listed under its own label', () => {
    renderBasis({ answerBasis: [{ kind: 'integration', label: 'Jira' }, { kind: 'web' }] });
    open();
    const list = screen.getByTestId('answer-basis-sources');
    expect(within(list).getByText('Connected system: Jira')).toBeInTheDocument();
    expect(within(list).getByText('Web search')).toBeInTheDocument();
  });

  it('an iFinder collection has a project page too, so it is linked', () => {
    renderBasis({
      answerBasis: [{ kind: 'project' }],
      knowledgeScope: {
        projects: [
          {
            id: 'ifc_00000000-0000-4000-8000-000000000001',
            name: 'Contracts',
            mode: 'searched',
            contributed: true
          }
        ]
      }
    });
    open();
    expect(screen.getByRole('link', { name: 'Open project Contracts' })).toHaveAttribute(
      'href',
      '/projects/ifc_00000000-0000-4000-8000-000000000001'
    );
  });

  it('a project the basis names without a project in the scope is still listed', () => {
    renderBasis({ answerBasis: [{ kind: 'project' }] });
    open();
    expect(
      within(screen.getByTestId('answer-basis-sources')).getByText('Project')
    ).toBeInTheDocument();
  });
});

describe('the amber chip: a project that could not be used', () => {
  const unavailable = {
    id: 'ifc_1',
    name: 'Handbook',
    mode: 'unavailable',
    reason: 'IFINDER_UNAVAILABLE',
    contributed: false
  };

  it('is shown beside the chip, and the chip shows what was actually used', () => {
    renderBasis({ answerBasis: [{ kind: 'model' }], knowledgeScope: { projects: [unavailable] } });
    expect(chip()).toHaveTextContent('Model knowledge');
    expect(chip()).not.toHaveTextContent('Project');
    expect(screen.getByTestId('knowledge-scope-missing')).toHaveTextContent(
      'Project not available'
    );
  });

  it('counts several', () => {
    renderBasis({
      answerBasis: [{ kind: 'model' }],
      knowledgeScope: { projects: [unavailable, { ...unavailable, id: 'ifc_2' }] }
    });
    expect(screen.getByTestId('knowledge-scope-missing')).toHaveTextContent(
      '2 projects not available'
    );
  });

  it('says which project and why to a screen reader, and under "Not used"', () => {
    renderBasis({ answerBasis: [{ kind: 'model' }], knowledgeScope: { projects: [unavailable] } });
    const amber = screen.getByTestId('knowledge-scope-missing');
    expect(amber).toHaveTextContent('Handbook');
    expect(amber).toHaveTextContent('iFinder could not be reached, so this answer did not use it.');
    open();
    expect(screen.getByTestId('answer-basis-not-used')).toHaveTextContent('Handbook');
    expect(screen.getByTestId('answer-basis-not-used')).toHaveTextContent(
      'iFinder could not be reached'
    );
  });

  it('is a status only on the newest answer, so history does not announce itself', () => {
    const scope = { projects: [unavailable] };
    const { unmount } = renderBasis({
      answerBasis: [{ kind: 'model' }],
      knowledgeScope: scope,
      newest: true
    });
    expect(screen.getByRole('status')).toBe(screen.getByTestId('knowledge-scope-missing'));
    unmount();
    renderBasis({ answerBasis: [{ kind: 'model' }], knowledgeScope: scope, newest: false });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByTestId('knowledge-scope-missing')).toBeInTheDocument();
  });

  it('is shown even when the message has no basis; it is a failure, not a source', () => {
    renderBasis({ knowledgeScope: { projects: [unavailable] } });
    expect(screen.queryByTestId('answer-basis-chip')).not.toBeInTheDocument();
    expect(screen.getByTestId('knowledge-scope-missing')).toBeInTheDocument();
  });
});

describe('a workflow answer', () => {
  const workflowResult = {
    status: 'completed',
    executionId: 'wf-9',
    workflowName: { en: 'Review' }
  };

  it('reads "Workflow", links to the execution, and keeps the AI statement', () => {
    renderBasis({ workflowResult, answerBasis: [{ kind: 'web' }], provenance: PROVENANCE });
    expect(chip()).toHaveTextContent('Workflow');
    expect(chip()).not.toHaveTextContent('Web');
    open();
    expect(screen.getByText('This answer was generated by AI in a workflow.')).toBeInTheDocument();
    const link = within(screen.getByTestId('answer-basis-workflow')).getByRole('link', {
      name: 'Open workflow execution'
    });
    expect(link).toHaveAttribute('href', '/workflows/executions/wf-9');
    expect(screen.getByTestId('answer-basis-workflow')).toHaveTextContent('Review');
    expect(headings()).toContain('AI-generated');
    expect(headings()).toContain('Details');
  });

  it('names the workflow in the reader’s language, and falls back to the default one', () => {
    mockLanguage = 'de';
    const names = { en: 'Review', de: 'Prüfung' };
    const { unmount } = renderBasis({
      workflowResult: { status: 'completed', workflowName: names }
    });
    open();
    expect(screen.getByTestId('answer-basis-workflow')).toHaveTextContent('Prüfung');
    unmount();
    renderBasis({ workflowResult: { status: 'completed', workflowName: { en: 'Review' } } });
    open();
    expect(screen.getByTestId('answer-basis-workflow')).toHaveTextContent('Review');
  });

  it('without an execution there is no link', () => {
    renderBasis({ workflowResult: { status: 'completed', workflowName: 'Review' } });
    open();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('the popover stays inside a narrow pane', () => {
  afterEach(() => jest.restoreAllMocks());

  it('slides right when a chip that is not at the edge would push it off the left side', () => {
    Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true });
    jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
      const box = { top: 0, bottom: 0, x: 0, y: 0, width: 288, height: 0, toJSON: () => ({}) };
      return this.getAttribute('role') === 'dialog'
        ? { ...box, left: -100, right: 188 }
        : { ...box, left: 0, right: 0, width: 0 };
    });
    renderBasis({ answerBasis: [{ kind: 'web' }] });
    open();
    // 8px from the pane's edge: the panel was 100px past it.
    expect(panel().style.transform).toBe('translateX(108px)');
  });

  it('slides left when it would run past the right side, and not at all when it fits', () => {
    Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true });
    const place = (left, right) =>
      jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
        const box = { top: 0, bottom: 0, x: 0, y: 0, height: 0, toJSON: () => ({}) };
        return this.getAttribute('role') === 'dialog'
          ? { ...box, left, right, width: right - left }
          : { ...box, left: 0, right: 0, width: 0 };
      });
    place(60, 340);
    const { unmount } = renderBasis({ answerBasis: [{ kind: 'web' }] });
    open();
    expect(panel().style.transform).toBe('translateX(-28px)');
    unmount();
    jest.restoreAllMocks();
    place(16, 304);
    renderBasis({ answerBasis: [{ kind: 'web' }] });
    open();
    expect(panel().style.transform).toBe('');
  });
});

describe('keyboard and screen reader', () => {
  it('is a button that says whether it is expanded, and opens a labelled dialog', () => {
    renderBasis({ answerBasis: [{ kind: 'web' }] });
    expect(chip().tagName).toBe('BUTTON');
    expect(chip()).toHaveAttribute('aria-expanded', 'false');
    expect(chip()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    open();
    expect(chip()).toHaveAttribute('aria-expanded', 'true');
    const dialog = screen.getByRole('dialog', { name: 'About this answer' });
    expect(chip()).toHaveAttribute('aria-controls', dialog.id);
    fireEvent.click(chip());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Escape closes it and returns the focus to the chip', () => {
    renderBasis({ answerBasis: [{ kind: 'web' }] });
    // Opening does not move the focus: only closing returns it to the chip.
    open();
    expect(chip()).not.toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(chip()).toHaveFocus();
  });

  it('a press outside closes it', () => {
    renderBasis({ answerBasis: [{ kind: 'web' }] });
    open();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('its links are reachable by keyboard: they are links', () => {
    renderBasis({ answerBasis: [{ kind: 'project' }], knowledgeScope: { projects: [PROJECT] } });
    open();
    const link = screen.getByRole('link', { name: /Open project/ });
    link.focus();
    expect(link).toHaveFocus();
  });

  it('keeps no information only in a title attribute', () => {
    const { container } = renderBasis({
      answerBasis: [{ kind: 'project' }, { kind: 'web' }, { kind: 'integration', label: 'Jira' }],
      knowledgeScope: {
        projects: [
          { ...PROJECT, knowledgeMode: 'auto', overBudget: true },
          { id: 'ifc_1', name: 'Handbook', mode: 'unavailable', reason: 'IFINDER_UNAVAILABLE' }
        ]
      }
    });
    open();
    // The hash keeps a title for the pointer, and its full text is read out too.
    const titled = [...container.querySelectorAll('[title]')].filter(
      node => node.getAttribute('data-testid') !== 'provenance-hash'
    );
    expect(titled).toEqual([]);
  });

  it('reads the full hash to a screen reader, not only in a title', () => {
    renderBasis({ answerBasis: [{ kind: 'web' }], provenance: PROVENANCE });
    open();
    expect(screen.getByTestId('provenance-hash')).toHaveTextContent('a'.repeat(64));
  });
});

describe('strings', () => {
  const keysOf = (node, prefix = '') =>
    Object.entries(node).flatMap(([key, value]) =>
      value && typeof value === 'object' ? keysOf(value, `${prefix}${key}.`) : [`${prefix}${key}`]
    );

  it('every string exists in English and German', () => {
    expect(keysOf(de.chatMessage.answerBasis).sort()).toEqual(
      keysOf(en.chatMessage.answerBasis).sort()
    );
  });

  it('the old badge strings are gone', () => {
    expect(en.chatMessage.answerSource).toBeUndefined();
    expect(de.chatMessage.answerSource).toBeUndefined();
  });
});
