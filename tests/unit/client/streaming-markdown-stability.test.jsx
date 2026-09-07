/**
 * StreamingMarkdown owns its DOM through `dangerouslySetInnerHTML`. React
 * re-applies that prop whenever the object it is given is not reference-identical
 * to the previous one — it never compares the HTML string — so an unrelated
 * parent re-render (hovering a chat message toggles its action row) used to wipe
 * and rebuild the whole markdown subtree, discarding every rendered Mermaid
 * diagram inside it.
 */
import { useState } from 'react';
import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom';

import StreamingMarkdown from '../../../client/src/features/chat/components/StreamingMarkdown';

const DIAGRAM = '```mermaid\nflowchart TD\n  A[Start] --> B[End]\n```';
const CONTENT = `Some text\n\n${DIAGRAM}\n\nMore text`;

const diagramNode = () => document.querySelector('.mermaid-diagram-container');

/**
 * Mimics ChatMessage: local state that changes on hover (the action row's
 * opacity) while the markdown props stay exactly the same.
 */
function HoverableMessage({ content, streaming = false }) {
  const [hovered, setHovered] = useState(false);

  return (
    <div data-testid="message" onMouseEnter={() => setHovered(true)}>
      <span data-testid="actions">{hovered ? 'shown' : 'hidden'}</span>
      <StreamingMarkdown content={content} streaming={streaming} />
    </div>
  );
}

describe('StreamingMarkdown DOM stability', () => {
  test('keeps the rendered diagram node across an unrelated parent re-render', () => {
    render(<HoverableMessage content={CONTENT} />);

    const before = diagramNode();
    expect(before).not.toBeNull();
    // Something the Mermaid hook would have put into the container.
    before.dataset.processed = 'true';

    act(() => {
      screen.getByTestId('message').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      screen.getByTestId('message').dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    });

    expect(screen.getByTestId('actions')).toHaveTextContent('shown');
    // Same node, still marked processed: React left the subtree alone.
    expect(diagramNode()).toBe(before);
    expect(diagramNode().dataset.processed).toBe('true');
  });

  test('keeps the rendered diagram node when re-rendered with identical content', () => {
    const { rerender } = render(<StreamingMarkdown content={CONTENT} />);

    const before = diagramNode();
    before.dataset.processed = 'true';

    rerender(<StreamingMarkdown content={CONTENT} />);

    expect(diagramNode()).toBe(before);
    expect(diagramNode().dataset.processed).toBe('true');
  });

  test('still replaces the markup when the content actually changes', () => {
    const { rerender } = render(<StreamingMarkdown content={CONTENT} />);

    const before = diagramNode();
    expect(screen.getByText('Some text')).toBeInTheDocument();

    rerender(<StreamingMarkdown content={`${CONTENT}\n\nA new paragraph`} />);

    expect(screen.getByText('A new paragraph')).toBeInTheDocument();
    expect(diagramNode()).not.toBe(before);
  });
});
