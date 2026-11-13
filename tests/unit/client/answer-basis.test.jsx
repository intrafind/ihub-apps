// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The chip under an answer says that it is AI-generated and what it is based on:
 * a fixed AI segment, then only the kinds of source the server
 * named (`run/ended.answerBasis`); "About this answer" opens behind it. Every state of the design (#3619) in English and German, and the
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

const mockFetchChatArtifactProvenance = jest.fn();
jest.mock('../../../client/src/api', () => ({
  __esModule: true,
  fetchChatArtifactProvenance: (...args) => mockFetchChatArtifactProvenance(...args)
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));

const AnswerBasis = require('../../../client/src/features/chat/components/AnswerBasis').default;
const { KIND_ICON } = require('../../../client/src/features/chat/components/answerBasisModel');

const renderBasis = props =>
  render(
    <MemoryRouter>
      <AnswerBasis {...props} />
    </MemoryRouter>
  );

const chip = () => screen.getByTestId('answer-basis-chip');
const open = () => fireEvent.click(chip());
const kinds = () => within(chip()).getByTestId('answer-basis-kinds');
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
  mockFetchChatArtifactProvenance.mockReset();
  mockFetchChatArtifactProvenance.mockRejectedValue(new Error('404'));
});

describe('the chip says AI-generated, then names the kinds of source, nothing else', () => {
  it('project only: "Project", no mode, no name, no "configured sources"', () => {
    renderBasis({ answerBasis: [{ kind: 'project' }], knowledgeScope: { projects: [PROJECT] } });
    expect(chip()).toHaveTextContent('Project');
    expect(chip()).not.toHaveTextContent('Case 2026-114');
    expect(chip()).not.toHaveTextContent(/loaded|all documents|searched/i);
    expect(screen.queryByText(/configured sources/i)).not.toBeInTheDocument();
    expect(chip()).toHaveAccessibleName('AI-generated, based on project. About this answer');
  });

  it('project and web search: "Project · Web", never "multiple sources"', () => {
    renderBasis({ answerBasis: [{ kind: 'project' }, { kind: 'web' }] });
    expect(kinds().textContent).toBe('Project·Web');
    expect(screen.queryByText(/multiple sources/i)).not.toBeInTheDocument();
    expect(chip()).toHaveAccessibleName(
      'AI-generated, based on project and web. About this answer'
    );
  });

  it('an integration is named by its own label, and two integrations are two entries', () => {
    renderBasis({
      answerBasis: [
        { kind: 'integration', label: 'Jira' },
        { kind: 'integration', label: 'Munich AD' }
      ]
    });
    expect(kinds().textContent).toBe('Jira·Munich AD');
    expect(chip()).toHaveAccessibleName(
      'AI-generated, based on Jira and Munich AD. About this answer'
    );
  });

  it('names at most two kinds, then "+N"; the accessible name keeps all of them', () => {
    renderBasis({
      answerBasis: [{ kind: 'project' }, { kind: 'web' }, { kind: 'integration', label: 'Jira' }]
    });
    expect(kinds().textContent).toBe('Project·Web+1');
    expect(screen.getByTestId('answer-basis-more')).toHaveTextContent('+1');
    expect(chip()).toHaveAccessibleName(
      'AI-generated, based on project, web, and Jira. About this answer'
    );
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
      ['model', 'Model knowledge', 'cpu-chip']
    ];
    for (const [kind, noun, icon] of cases) {
      const { unmount } = renderBasis({ answerBasis: [{ kind }] });
      expect(chip()).toHaveTextContent(noun);
      // The first icon is the AI segment's; the kind's own follows it.
      expect(within(kinds()).getAllByTestId('icon')[0]).toHaveAttribute('data-name', icon);
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

  it('says "AI-generated" on every answer, as text and with the sparkles, ahead of the sources', () => {
    const states = [
      [{ kind: 'project' }],
      [{ kind: 'project' }, { kind: 'web' }],
      [{ kind: 'model' }],
      [{ kind: 'integration', label: 'Jira' }]
    ];
    for (const answerBasis of states) {
      const { unmount } = renderBasis({ answerBasis });
      const ai = within(chip()).getByTestId('answer-basis-ai-label');
      expect(ai).toHaveTextContent('AI-generated');
      expect(within(ai).getByTestId('icon')).toHaveAttribute('data-name', 'sparkles');
      // First in reading order: the AI segment comes before the kinds.
      expect(chip().firstElementChild).toBe(ai);
      unmount();
    }
  });

  it('the chip has no "Based on" lead-in; model knowledge reads "Model knowledge"', () => {
    renderBasis({ answerBasis: [{ kind: 'model' }] });
    expect(kinds().textContent).toBe('Model knowledge');
    expect(chip()).not.toHaveTextContent('Based on');
    expect(chip()).toHaveAccessibleName(
      "AI-generated, based on the model's knowledge. About this answer"
    );
  });

  it('keeps the sparkles for the AI segment alone: no kind uses it', () => {
    for (const kind of Object.keys(KIND_ICON)) expect(KIND_ICON[kind]).not.toBe('sparkles');
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

describe('the details of generated pictures are in the same chip (EU AI Act Art. 50(2))', () => {
  const IMAGE = {
    mimeType: 'image/png',
    provenance: {
      ai_generated: true,
      kind: 'image',
      model: { id: 'gemini-image', watermark: { by: 'provider', applied: true } },
      content_hash: { alg: 'sha-256', value: 'b'.repeat(64) },
      output_id: '01JC1111111111111111111111'
    }
  };

  it("an image-only answer: Details carry the picture's record, without a heading to tell apart", () => {
    renderBasis({ answerBasis: [{ kind: 'model' }], images: [IMAGE] });
    open();
    expect(headings()).toEqual(['About this answer', 'AI-generated', 'Details']);
    const details = screen.getByTestId('answer-basis-details');
    expect(within(details).getByTestId('provenance-model')).toHaveTextContent('gemini-image');
    expect(within(details).getByText('01JC1111111111111111111111')).toBeInTheDocument();
    expect(within(details).getByText(/not the image itself/)).toBeInTheDocument();
    expect(within(details).queryByText('Image 1')).not.toBeInTheDocument();
  });

  it('text and pictures: one record each, named so they can be told apart', () => {
    renderBasis({
      answerBasis: [{ kind: 'model' }],
      provenance: PROVENANCE,
      images: [IMAGE, { mimeType: 'image/png' }, IMAGE]
    });
    open();
    const details = screen.getByTestId('answer-basis-details');
    expect(within(details).getByTestId('answer-basis-record-text')).toHaveTextContent('Text');
    // The middle picture has no record (stored before it existed): the numbers stay the message's.
    const images = within(details).getAllByTestId('answer-basis-record-image');
    expect(images.map(node => node.querySelector('p')?.textContent)).toEqual([
      'Image 1',
      'Image 3'
    ]);
  });

  it('asks what the file of a stored picture carries, once the details are open', async () => {
    mockFetchChatArtifactProvenance.mockResolvedValue({
      outputId: IMAGE.provenance.output_id,
      providerMarking: {
        c2pa: {
          present: true,
          status: 'present',
          valid: true,
          issuer: 'Google LLC',
          trust: 'not-evaluated'
        },
        xmp: {}
      }
    });
    renderBasis({
      answerBasis: [{ kind: 'model' }],
      images: [{ ...IMAGE, id: 'art-1' }],
      chatId: 'chat-1'
    });
    // Nothing is asked for before the details are opened.
    expect(mockFetchChatArtifactProvenance).not.toHaveBeenCalled();
    open();
    const details = screen.getByTestId('answer-basis-details');
    expect(await within(details).findByText('Google LLC')).toBeInTheDocument();
    expect(mockFetchChatArtifactProvenance).toHaveBeenCalledWith('chat-1', 'art-1');
  });

  it('a picture only just generated has no stored copy to ask about yet', () => {
    renderBasis({ answerBasis: [{ kind: 'model' }], images: [IMAGE], chatId: 'chat-1' });
    open();
    expect(mockFetchChatArtifactProvenance).not.toHaveBeenCalled();
  });

  it('pictures without a record leave out the details, not the AI statement', () => {
    renderBasis({ answerBasis: [{ kind: 'model' }], images: [{ mimeType: 'image/png' }] });
    open();
    expect(headings()).toEqual(['About this answer', 'AI-generated']);
  });

  it('names the picture in German', () => {
    mockLanguage = 'de';
    renderBasis({ answerBasis: [{ kind: 'model' }], provenance: PROVENANCE, images: [IMAGE] });
    open();
    expect(screen.getByText('Bild 1')).toBeInTheDocument();
  });
});

describe('the panel finds room (it opens on the side that has it)', () => {
  // jsdom lays nothing out: give the panel a height so "room" means something.
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 300
    });
  });
  afterAll(() => {
    delete HTMLElement.prototype.scrollHeight;
    window.innerHeight = 768;
  });

  const openAt = rect => {
    chip().getBoundingClientRect = () => rect;
    open();
    return panel();
  };

  it('opens below when there is no room above (an answer at the top of the chat)', () => {
    renderBasis({ answerBasis: [{ kind: 'model' }] });
    expect(openAt({ top: 40, bottom: 64, left: 0, right: 24 }).className).toContain('top-full');
  });

  it('opens above when there is room above', () => {
    renderBasis({ answerBasis: [{ kind: 'model' }] });
    expect(openAt({ top: 600, bottom: 624, left: 0, right: 24 }).className).toContain(
      'bottom-full'
    );
  });

  it('caps the panel to the roomier side when neither side fits', () => {
    renderBasis({ answerBasis: [{ kind: 'model' }] });
    // A 300 px panel in a 400 px viewport: 150 px above, 226 px below. Neither fits,
    // so it opens below and is capped to that room minus the gap.
    window.innerHeight = 400;
    const opened = openAt({ top: 150, bottom: 174, left: 0, right: 24 });
    expect(opened.className).toContain('top-full');
    expect(opened.style.maxHeight).toBe('218px');
  });
});

describe('a narrow pane drops the nouns, not the information', () => {
  it('two or more kinds keep their icons and drop the nouns under a narrow container', () => {
    renderBasis({ answerBasis: [{ kind: 'project' }, { kind: 'web' }] });
    const nouns = within(chip()).getAllByText(/^(Project|Web)$/);
    for (const noun of nouns) expect(noun).toHaveClass('@max-sm:sr-only');
    expect(chip()).toHaveAccessibleName(
      'AI-generated, based on project and web. About this answer'
    );
  });

  it('the AI statement shortens to "AI"; it is not dropped for a reader', () => {
    renderBasis({ answerBasis: [{ kind: 'project' }, { kind: 'web' }] });
    const ai = within(chip()).getByTestId('answer-basis-ai-label');
    const full = within(ai).getByText('AI-generated');
    expect(full).toHaveClass('@max-sm:hidden');
    const short = within(ai).getByText('AI');
    expect(short).toHaveClass('hidden', '@max-sm:inline');
    // The short text is for the eye; the accessible name already carries the full one.
    expect(short).toHaveAttribute('aria-hidden', 'true');
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

  it('says "KI-generiert" on the chip, "Grundlage:" before the kinds, and "KI" when narrow', () => {
    renderBasis({ answerBasis: [{ kind: 'project' }, { kind: 'web' }] });
    const ai = within(chip()).getByTestId('answer-basis-ai-label');
    expect(ai).toHaveTextContent('KI-generiert');
    expect(within(ai).getByText('KI')).toHaveClass('@max-sm:inline');
    expect(chip()).toHaveAccessibleName(
      'KI-generiert, auf Grundlage von Projekt und Web. Zu dieser Antwort'
    );
  });

  it('says "Modellwissen" when nothing was retrieved', () => {
    renderBasis({ answerBasis: [{ kind: 'model' }] });
    expect(chip()).toHaveTextContent('Modellwissen');
    open();
    expect(screen.getByText(/auf Grundlage des Wissens des Modells/)).toBeInTheDocument();
  });

  it('names the kinds and words the sentence in German', () => {
    renderBasis({ answerBasis: [{ kind: 'project' }, { kind: 'web' }] });
    expect(kinds().textContent).toBe('Grundlage:Projekt·Web');
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

  it('says when a project answered from outdated documents that are being refreshed', () => {
    renderBasis({
      answerBasis: [{ kind: 'project' }],
      knowledgeScope: { projects: [{ ...PROJECT, outdated: 3 }] }
    });
    open();
    expect(
      screen.getByText(
        '3 outdated documents are being refreshed; this answer used their stored text',
        { exact: false }
      )
    ).toBeInTheDocument();
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
    expect(chip()).not.toHaveTextContent('Based on');
    expect(chip()).toHaveTextContent('AI-generated');
    expect(chip()).toHaveAccessibleName('AI-generated in a workflow. About this answer');
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

  it('opening moves the focus into the dialog, which is not modal and traps nothing', () => {
    renderBasis({ answerBasis: [{ kind: 'web' }] });
    chip().focus();
    open();
    const dialog = screen.getByRole('dialog', { name: 'About this answer' });
    expect(dialog).toHaveFocus();
    expect(chip()).not.toHaveFocus();
    // Non-modal: the page behind stays available and nothing keeps Tab inside.
    expect(dialog).not.toHaveAttribute('aria-modal');
    expect(fireEvent.keyDown(dialog, { key: 'Tab' })).toBe(true);
  });

  it('Escape closes it and returns the focus from the dialog to the chip', () => {
    renderBasis({ answerBasis: [{ kind: 'web' }] });
    open();
    // The focus is in the dialog, so the chip has it again only through the restore.
    expect(screen.getByRole('dialog')).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(chip()).toHaveFocus();
  });

  it('a press outside closes it without pulling the focus back to the chip', () => {
    render(
      <MemoryRouter>
        <AnswerBasis answerBasis={[{ kind: 'web' }]} />
        <button type="button">elsewhere</button>
      </MemoryRouter>
    );
    open();
    const elsewhere = screen.getByRole('button', { name: 'elsewhere' });
    elsewhere.focus();
    fireEvent.mouseDown(elsewhere);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(elsewhere).toHaveFocus();
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
