// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Projects in the chat (#1036, slice 5): the knowledge badge names a single
 * project and links a user project, a citation shows where a project document
 * came from, and the preview falls back to the text when the original is
 * discarded (spec 2 §5.1). The chat's own project chips are covered in
 * `chat-attached-projects.test.jsx`.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';

const mockApi = {
  fetchProjects: jest.fn()
};
jest.mock('../../../client/src/api', () => ({
  fetchProjects: (...args) => mockApi.fetchProjects(...args),
  fetchProjectList: (...args) =>
    Promise.resolve(mockApi.fetchProjects(...args)).then(items => ({ items, warnings: [] })),
  fetchProjectsConfig: () => Promise.resolve({})
}));
const mockFetchSourceContent = jest.fn();
jest.mock('../../../client/src/api/endpoints/integrationFiles', () => ({
  fetchIntegrationFileContent: (...args) => mockFetchSourceContent(...args)
}));
jest.mock('../../../client/src/features/documentPreview/components/PdfPassageViewer', () => ({
  __esModule: true,
  default: () => <div data-testid="pdf-viewer" />
}));
jest.mock('../../../client/src/shared/hooks/chatListStore', () => ({
  invalidateChatsCache: jest.fn()
}));

let mockPlatform = { projects: { enabled: true, userProjects: true } };
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({ platformConfig: mockPlatform, isLoading: false })
}));
jest.mock('../../../client/src/shared/contexts/authContextValue', () => ({
  useOptionalAuth: () => ({ isAuthenticated: true, isLoading: false, user: { id: 'u_17' } })
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
const mockI18n = { t: mockT, i18n: { language: 'en-GB' } };
jest.mock('react-i18next', () => ({ useTranslation: () => mockI18n }));

const ItemProvenance =
  require('../../../client/src/features/projects/components/ItemProvenance').default;
const AnswerBasis = require('../../../client/src/features/chat/components/AnswerBasis').default;
const DocumentPreviewModal =
  require('../../../client/src/features/documentPreview/components/DocumentPreviewModal').default;
const TextPassageViewer =
  require('../../../client/src/features/documentPreview/components/TextPassageViewer').default;
const {
  invalidateProjectsList
} = require('../../../client/src/features/projects/hooks/useProjects');

const PROJECTS = [
  { id: 'prj_case', ownership: 'user', name: 'Case 2026-114', permissions: { canUse: true } },
  { id: 'prj_wiki', ownership: 'user', name: 'Team wiki', permissions: { canUse: true } },
  { id: 'faq', ownership: 'admin', name: { en: 'FAQ' }, permissions: { canUse: true } }
];

const renderInRouter = ui => render(<MemoryRouter>{ui}</MemoryRouter>);

beforeEach(() => {
  Object.values(mockApi).forEach(fn => fn.mockReset());
  mockFetchSourceContent.mockReset();
  mockApi.fetchProjects.mockResolvedValue(PROJECTS);
  mockPlatform = { projects: { enabled: true, userProjects: true } };
  invalidateProjectsList();
});

describe('knowledge badge and provenance', () => {
  test('names the kind of a project on the chip, and links to the project from the popover', () => {
    renderInRouter(
      <AnswerBasis
        answerBasis={[{ kind: 'project' }]}
        knowledgeScope={{
          projects: [{ id: 'prj_case', name: 'Case 2026-114', mode: 'loaded', contributed: true }]
        }}
      />
    );
    // The chip says only the kind: no name, no mode.
    const chip = screen.getByTestId('answer-basis-chip');
    expect(chip).toHaveTextContent('Project');
    expect(chip).not.toHaveTextContent('Case 2026-114');
    fireEvent.click(chip);
    const link = screen.getByRole('link', { name: 'Open project Case 2026-114' });
    expect(link).toHaveAttribute('href', '/projects/prj_case');
  });

  test('several projects are one kind on the chip, each listed in the popover, none linked unless it has a page', () => {
    renderInRouter(
      <AnswerBasis
        answerBasis={[{ kind: 'project' }]}
        knowledgeScope={{
          projects: [
            { id: 'faq', name: 'FAQ', mode: 'loaded', contributed: true },
            { id: 'prj_case', name: 'Case', mode: 'searched', contributed: true }
          ]
        }}
      />
    );
    expect(screen.getByTestId('answer-basis-chip')).toHaveTextContent('Project');
    fireEvent.click(screen.getByTestId('answer-basis-chip'));
    expect(screen.getAllByTestId('answer-basis-project')).toHaveLength(2);
    // Only the user project has a page to open.
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  test('shows "picked from" with the snapshot date, and "uploaded"', () => {
    const { rerender } = render(
      <ItemProvenance
        provenance={{ origin: 'picked', kind: 'google-drive', at: '2026-10-12T08:00:00Z' }}
      />
    );
    expect(screen.getByText('Picked from Google Drive')).toBeInTheDocument();
    expect(screen.getByText('text taken 12 Oct 2026')).toBeInTheDocument();
    rerender(<ItemProvenance provenance={{ origin: 'uploaded' }} />);
    expect(screen.getByText('Uploaded')).toBeInTheDocument();
    rerender(<ItemProvenance provenance={undefined} />);
    expect(screen.queryByTestId('item-provenance')).not.toBeInTheDocument();
  });
});

describe('DocumentPreviewModal text mode', () => {
  const projectSource = {
    provider: 'project',
    ref: { id: 'itm_1', scope: 'prj_case' },
    provenance: { origin: 'uploaded', kind: 'upload' }
  };

  test('shows a project document as text with the passage highlighted', async () => {
    mockFetchSourceContent.mockResolvedValue({
      data: 'Rent is due monthly. Notice is three months.'
    });
    render(
      <DocumentPreviewModal
        source={projectSource}
        title="Lease.pdf"
        passages={['Notice is three months.']}
        onClose={() => {}}
      />
    );
    const viewer = await screen.findByTestId('text-passage-viewer');
    expect(mockFetchSourceContent).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'text', responseType: 'text' })
    );
    expect(within(viewer).getByText('Notice is three months.').tagName).toBe('MARK');
    expect(screen.getByText('Extracted text (the original is not kept)')).toBeInTheDocument();
  });

  test('falls back to the text when the PDF answers "original discarded"', async () => {
    mockFetchSourceContent
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { response: { status: 410 } }))
      .mockResolvedValueOnce({ data: 'Only text here.' });
    render(
      <DocumentPreviewModal
        source={{ provider: 'other', ref: { id: 'd1' } }}
        title="Doc"
        passages={[]}
        onClose={() => {}}
      />
    );
    expect(await screen.findByTestId('text-passage-viewer')).toHaveTextContent('Only text here.');
    expect(mockFetchSourceContent.mock.calls[0][0]).toMatchObject({ format: 'pdf' });
    expect(mockFetchSourceContent.mock.calls[1][0]).toMatchObject({ format: 'text' });
    expect(screen.queryByTestId('pdf-viewer')).not.toBeInTheDocument();
  });
});

describe('TextPassageViewer scrolling', () => {
  const TEXT = 'Rent is due monthly. Notice is three months. Deposit is two rents.';
  let scrolled;
  let originalScroll;

  beforeEach(() => {
    scrolled = [];
    originalScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
      scrolled.push(this.textContent);
    };
  });

  afterEach(() => {
    HTMLElement.prototype.scrollIntoView = originalScroll;
  });

  test('scrolls to the passage of each chip, though each has a single match', () => {
    // The modal hands a stable callback, so a new selection that again has
    // one match at index 0 changes nothing the state report depends on.
    const onStateChange = jest.fn();
    const controlRef = { current: null };
    const { rerender } = render(
      <TextPassageViewer
        text={TEXT}
        passages={['Notice is three months.']}
        controlRef={controlRef}
        onStateChange={onStateChange}
      />
    );
    expect(scrolled).toEqual(['Notice is three months.']);

    rerender(
      <TextPassageViewer
        text={TEXT}
        passages={['Deposit is two rents.']}
        controlRef={controlRef}
        onStateChange={onStateChange}
      />
    );
    expect(scrolled).toEqual(['Notice is three months.', 'Deposit is two rents.']);

    // "Next" on the only match brings it back into view.
    act(() => controlRef.current.nextMatch());
    expect(scrolled).toEqual([
      'Notice is three months.',
      'Deposit is two rents.',
      'Deposit is two rents.'
    ]);
  });
});
