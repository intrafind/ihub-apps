import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ProvenanceDetails } from '../../../client/src/features/chat/components/ProvenanceInfo';
import { transformStoredMessage } from '../../../client/src/features/chat/hooks/useChatMessages';

/**
 * The "AI generated" details of an output (EU AI Act Art. 50(2)): the server's
 * provenance object as model, time, marking and content hash, shown in the "Details" of
 * the chip under the answer. Nothing is inferred on the client, and no wording claims
 * more than the record. (The chip itself is covered by `answer-basis.test.jsx`.)
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => fallback || key, i18n: { language: 'en' } })
}));

jest.mock('../../../client/src/utils/debugLog', () => ({ debugLog: jest.fn() }));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));

const HASH = 'a'.repeat(30) + 'b'.repeat(34);
const provenance = {
  spec: 'intrafind-provenance/1.0',
  ai_generated: true,
  model: { id: 'gpt-x', watermark: { by: 'provider', scheme: 'synthid', applied: true } },
  output_id: '01JC8M2T6V0Q4W7R9XK3B5N1ZD',
  created_at: '2026-11-05T10:12:03.412Z',
  content_hash: { alg: 'sha-256', normalization: 'nfc-trim', value: HASH }
};

describe('ProvenanceDetails', () => {
  it('shows model, marking, hash and output id', () => {
    render(<ProvenanceDetails provenance={provenance} />);
    expect(screen.getByTestId('provenance-model')).toHaveTextContent('gpt-x');
    expect(screen.getByText('Marked by the provider (declared)')).toBeInTheDocument();
    expect(screen.getByText('01JC8M2T6V0Q4W7R9XK3B5N1ZD')).toBeInTheDocument();
    // Shortened, with the full hash on hover and on copy.
    expect(screen.getByTestId('provenance-hash')).toHaveAttribute('title', HASH);
    expect(screen.getByTestId('provenance-hash').textContent).not.toBe(HASH);
  });

  it('says "not marked" for an unmarked model and never claims authorship either way', () => {
    const { container } = render(
      <ProvenanceDetails
        provenance={{
          ...provenance,
          model: { id: 'm', watermark: { by: 'none', applied: false } }
        }}
      />
    );
    expect(container).toHaveTextContent('Not marked by the model');
    expect(container).toHaveTextContent('No match does not mean a person wrote it');
    expect(container.textContent).not.toMatch(/authentic|human-written/i);
  });

  it('names the model by its display name and id when the model list has it', () => {
    render(
      <ProvenanceDetails
        provenance={provenance}
        models={[{ id: 'gpt-x', name: { en: 'GPT X', de: 'GPT X' } }]}
      />
    );
    expect(screen.getByTestId('provenance-model')).toHaveTextContent('GPT X (gpt-x)');
  });

  it('keeps the bare id for a model that is not in the list', () => {
    render(<ProvenanceDetails provenance={provenance} models={[]} />);
    expect(screen.getByTestId('provenance-model')).toHaveTextContent(/^gpt-x$/);
  });

  it('speaks of the image, not the text, for an image provenance object', () => {
    const { container } = render(
      <ProvenanceDetails
        provenance={{
          ...provenance,
          kind: 'image',
          content_hash: { alg: 'sha-256', normalization: 'none', value: HASH }
        }}
      />
    );
    expect(container).toHaveTextContent(
      'The provenance record keeps this hash, not the image itself'
    );
    expect(container).not.toHaveTextContent('not the text');
  });

  it('copies the full hash', async () => {
    const writeText = jest.fn().mockResolvedValue();
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ProvenanceDetails provenance={provenance} />);
    fireEvent.click(screen.getByText('Copy hash'));
    expect(writeText).toHaveBeenCalledWith(HASH);
  });
});

describe('stored message', () => {
  it('keeps the provenance object on the chat message', () => {
    const message = transformStoredMessage({
      id: 'm1',
      role: 'assistant',
      content: 'Hi',
      provenance
    });
    expect(message.provenance).toEqual(provenance);
  });

  it('has none for an answer stored before provenance existed', () => {
    expect(
      transformStoredMessage({ id: 'm2', role: 'assistant', content: 'Hi' }).provenance
    ).toBeUndefined();
  });
});
