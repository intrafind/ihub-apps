import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import ProvenanceInfo from '../../../client/src/features/chat/components/ProvenanceInfo';
import { transformStoredMessage } from '../../../client/src/features/chat/hooks/useChatMessages';

/**
 * The "AI generated" details under an answer (EU AI Act Art. 50(2)): a button that
 * opens the server's provenance object as model, time, marking and content hash.
 * Nothing is inferred on the client, and no wording claims more than the record.
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

describe('ProvenanceInfo', () => {
  it('renders nothing without a provenance object', () => {
    const { container } = render(<ProvenanceInfo provenance={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is a closed button first, then shows model, marking, hash and output id', () => {
    render(<ProvenanceInfo provenance={provenance} />);
    const button = screen.getByTestId('provenance-button');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('provenance-panel')).not.toBeInTheDocument();

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const panel = screen.getByTestId('provenance-panel');
    expect(panel).toHaveTextContent('gpt-x');
    expect(panel).toHaveTextContent('Marked by the provider (declared)');
    expect(panel).toHaveTextContent('01JC8M2T6V0Q4W7R9XK3B5N1ZD');
    // Shortened, with the full hash on hover and on copy.
    expect(screen.getByTestId('provenance-hash')).toHaveAttribute('title', HASH);
    expect(screen.getByTestId('provenance-hash').textContent).not.toBe(HASH);
  });

  it('says "not marked" for an unmarked model and never claims authorship either way', () => {
    render(
      <ProvenanceInfo
        provenance={{
          ...provenance,
          model: { id: 'm', watermark: { by: 'none', applied: false } }
        }}
      />
    );
    fireEvent.click(screen.getByTestId('provenance-button'));
    const panel = screen.getByTestId('provenance-panel');
    expect(panel).toHaveTextContent('Not marked by the model');
    expect(panel).toHaveTextContent('No match does not mean a person wrote it');
    expect(panel.textContent).not.toMatch(/authentic|human-written/i);
  });

  it('names the model by its display name and id when the model list has it', () => {
    render(
      <ProvenanceInfo
        provenance={provenance}
        models={[{ id: 'gpt-x', name: { en: 'GPT X', de: 'GPT X' } }]}
      />
    );
    fireEvent.click(screen.getByTestId('provenance-button'));
    expect(screen.getByTestId('provenance-model')).toHaveTextContent('GPT X (gpt-x)');
  });

  it('keeps the bare id for a model that is not in the list', () => {
    render(<ProvenanceInfo provenance={provenance} models={[]} />);
    fireEvent.click(screen.getByTestId('provenance-button'));
    expect(screen.getByTestId('provenance-model')).toHaveTextContent(/^gpt-x$/);
  });

  it('speaks of an image for an image provenance object', () => {
    render(
      <ProvenanceInfo
        provenance={{
          ...provenance,
          kind: 'image',
          content_hash: { alg: 'sha-256', normalization: 'none', value: HASH }
        }}
        placement="bottom"
      />
    );
    const button = screen.getByTestId('provenance-button');
    expect(button).toHaveAttribute('aria-label', 'AI-generated image: details');
    fireEvent.click(button);
    const panel = screen.getByTestId('provenance-panel');
    expect(panel).toHaveTextContent('AI-generated image');
    expect(panel).toHaveTextContent('The provenance record keeps this hash, not the image itself');
    expect(panel.className).toContain('top-full');
  });

  // jsdom lays nothing out: give the panel a height so "room" means something.
  const realOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => 300
    });
  });
  afterAll(() => {
    if (realOffsetHeight)
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', realOffsetHeight);
  });

  it('opens below when there is no room above (an answer at the top of the chat)', () => {
    render(<ProvenanceInfo provenance={provenance} />);
    const button = screen.getByTestId('provenance-button');
    button.getBoundingClientRect = () => ({ top: 40, bottom: 64, left: 0, right: 24 });
    fireEvent.click(button);
    expect(screen.getByTestId('provenance-panel').className).toContain('top-full');
  });

  it('opens above when there is room above', () => {
    render(<ProvenanceInfo provenance={provenance} />);
    const button = screen.getByTestId('provenance-button');
    button.getBoundingClientRect = () => ({ top: 600, bottom: 624, left: 0, right: 24 });
    fireEvent.click(button);
    expect(screen.getByTestId('provenance-panel').className).toContain('bottom-full');
  });

  it('closes on Escape and on a click outside', () => {
    render(
      <div>
        <span data-testid="outside">outside</span>
        <ProvenanceInfo provenance={provenance} />
      </div>
    );
    fireEvent.click(screen.getByTestId('provenance-button'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('provenance-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('provenance-button'));
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByTestId('provenance-panel')).not.toBeInTheDocument();
  });

  it('copies the full hash', async () => {
    const writeText = jest.fn().mockResolvedValue();
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ProvenanceInfo provenance={provenance} />);
    fireEvent.click(screen.getByTestId('provenance-button'));
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
