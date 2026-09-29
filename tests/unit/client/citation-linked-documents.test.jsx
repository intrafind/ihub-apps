import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { transformStoredMessage } from '../../../client/src/features/chat/hooks/useChatMessages';

/**
 * Documents found by the iFinder tools (issue #2597).
 *
 * A turn that answers with the iFinder tools lists the documents its searches
 * found in the same Documents panel as an iAssistant answer, so each one has
 * the preview / download / "Add to email" menu. Such a turn usually runs
 * several searches, so the panel puts the documents the answer links to first
 * and folds away the ones that were only found along the way.
 */

const interpolate = (text, options) =>
  String(text).replace(/\{\{(\w+)\}\}/g, (_, name) => options?.[name] ?? '');
const mockT = (key, def, options) => {
  if (typeof def === 'string') return interpolate(def, options);
  if (def && typeof def === 'object' && def.defaultValue) return interpolate(def.defaultValue, def);
  return key;
};
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } })
}));

jest.mock('../../../client/src/api/endpoints/documents', () => ({
  __esModule: true,
  fetchIFinderDocument: jest.fn(),
  fetchIFinderDocumentMetadata: jest.fn().mockResolvedValue({})
}));

// `debugLog` reads `import.meta`, which the Jest transform cannot compile.
jest.mock('../../../client/src/utils/debugLog', () => ({
  __esModule: true,
  debugLog: () => {}
}));

jest.mock('../../../client/src/features/workflows/components/AppSelectionModal', () => ({
  __esModule: true,
  default: () => null
}));

const CitationPanel = require('../../../client/src/features/chat/components/CitationPanel').default;
const { isCitationLinkedIn } = require('../../../client/src/features/chat/utils/citationDocuments');

/** A document as `services/integrations/iFinderCitations.js` sends it. */
const toolDocument = (id, title, deepLink) => ({
  document_id: id,
  title,
  additional_document_metadata: {
    id,
    title,
    ...(deepLink ? { 'accessInfo.deepLink': deepLink } : {})
  },
  links: [{ type: 'ACCESS', documentId: id, searchProfile: 'sales' }]
});

const contract = toolDocument(
  'sp-7f3a9c11',
  'Supplier contract ACME',
  'https://sp.example/sites/legal/acme.pdf'
);
const agreement = toolDocument('fs-0042aa99', 'Framework agreement');
const minutes = toolDocument('fs-1234abcd', 'Board minutes', 'https://sp.example/minutes');

const citations = { references: [], resultItems: [agreement, contract, minutes] };

const tileTitles = () =>
  screen
    .getAllByText(/Supplier contract ACME|Framework agreement|Board minutes/)
    .map(node => node.textContent);

describe('isCitationLinkedIn', () => {
  it('finds the deep link of a markdown link', () => {
    expect(
      isCitationLinkedIn(contract, 'See [the contract](https://sp.example/sites/legal/acme.pdf).')
    ).toBe(true);
  });

  it('finds the id in the link title', () => {
    expect(
      isCitationLinkedIn(
        agreement,
        '[Framework agreement](https://x.example/fa "Files · fs-0042aa99")'
      )
    ).toBe(true);
    expect(isCitationLinkedIn(agreement, 'The id is fs-0042aa99.')).toBe(true);
  });

  it('does not match a longer id or link that merely starts the same', () => {
    expect(isCitationLinkedIn(agreement, 'see fs-0042aa990 and fs-0042aa99.pdf')).toBe(false);
    expect(isCitationLinkedIn(minutes, '(https://sp.example/minutes-2024)')).toBe(false);
    expect(isCitationLinkedIn(minutes, '(https://sp.example/minutes/2024)')).toBe(false);
  });

  it('ignores ids too short to tell apart from prose, and empty answers', () => {
    const shortId = toolDocument('42', 'Short');
    expect(isCitationLinkedIn(shortId, 'We found 42 documents.')).toBe(false);
    expect(isCitationLinkedIn(contract, '')).toBe(false);
    expect(isCitationLinkedIn(contract, undefined)).toBe(false);
  });
});

describe('CitationPanel with documents found by the iFinder tools', () => {
  it('offers the document menu for every found document', async () => {
    const user = userEvent.setup();
    render(<CitationPanel citations={{ references: [], resultItems: [contract] }} content="" />);

    await user.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByText('Preview (PDF)')).toBeInTheDocument();
    expect(screen.getByText('Download')).toBeInTheDocument();
    expect(screen.getByTitle('Open in browser')).toBeInTheDocument();
  });

  it('lists every document, in order, when the answer links to none', () => {
    render(<CitationPanel citations={citations} content="Nothing relevant was found." />);

    expect(tileTitles()).toEqual([
      'Framework agreement',
      'Supplier contract ACME',
      'Board minutes'
    ]);
    expect(screen.getAllByText('Mentioned')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /more document/ })).not.toBeInTheDocument();
  });

  it('puts the linked documents first as referenced and folds the others away', async () => {
    const user = userEvent.setup();
    const content =
      'The notice period is three months ' +
      '([Supplier contract ACME](https://sp.example/sites/legal/acme.pdf "SharePoint · sp-7f3a9c11")).';
    render(<CitationPanel citations={citations} content={content} />);

    expect(tileTitles()).toEqual(['Supplier contract ACME']);
    expect(screen.getByText('Referenced')).toBeInTheDocument();
    expect(screen.queryByText('Mentioned')).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: 'Show 2 more documents' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);

    expect(tileTitles()).toEqual([
      'Supplier contract ACME',
      'Framework agreement',
      'Board minutes'
    ]);
    expect(screen.getAllByText('Mentioned')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Show fewer documents' }));
    expect(tileTitles()).toEqual(['Supplier contract ACME']);
  });

  it('keeps documents with passages listed even when they are not linked', () => {
    const withPassage = {
      references: [
        { document_id: 'fs-1234abcd', title: 'Board minutes', content: 'Passage', index: 1 }
      ],
      resultItems: [agreement, contract, minutes]
    };
    render(
      <CitationPanel
        citations={withPassage}
        content="See https://sp.example/sites/legal/acme.pdf for the details."
      />
    );

    expect(tileTitles()).toEqual(['Supplier contract ACME', 'Board minutes']);
    const toggle = screen.getByRole('button', { name: 'Show 1 more document' });
    expect(within(toggle.parentElement).getAllByText('Referenced')).toHaveLength(2);
  });
});

describe('a reopened chat', () => {
  it('brings back the documents stored with the answer, with their document menu', async () => {
    const user = userEvent.setup();
    const content =
      'See [Supplier contract ACME](https://sp.example/sites/legal/acme.pdf "SharePoint · sp-7f3a9c11").';
    const message = transformStoredMessage({
      id: 'm2',
      role: 'assistant',
      content,
      citations: { references: [], resultItems: [agreement, contract] }
    });
    expect(message.citations).toEqual({ references: [], resultItems: [agreement, contract] });

    render(<CitationPanel citations={message.citations} content={message.content} />);
    expect(tileTitles()).toEqual(['Supplier contract ACME']);
    expect(screen.getByText('Referenced')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByText('Preview (PDF)')).toBeInTheDocument();
    expect(screen.getByText('Download')).toBeInTheDocument();
  });

  it('a stored answer without documents gets no panel', () => {
    expect(
      transformStoredMessage({ id: 'm1', role: 'assistant', content: 'x' }).citations
    ).toBeUndefined();
    expect(
      transformStoredMessage({
        id: 'm1',
        role: 'assistant',
        content: 'x',
        citations: { references: [], resultItems: [] }
      }).citations
    ).toBeUndefined();
    expect(
      transformStoredMessage({ id: 'm1', role: 'assistant', content: 'x', citations: 'junk' })
        .citations
    ).toBeUndefined();
  });
});
