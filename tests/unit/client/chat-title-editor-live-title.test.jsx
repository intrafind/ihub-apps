import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';

/**
 * The rename field when the stored title changes underneath it (#2314).
 *
 * A generated title reaches the client with the next chat list fetch, which
 * can land while a row is open for renaming. The field follows the stored
 * title as long as the user has typed nothing; once they have, what they are
 * typing is never replaced.
 */

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) })
}));

import ChatTitleEditor from '../../../client/src/features/chat/components/ChatTitleEditor';

const field = () => screen.getByRole('textbox');

describe('ChatTitleEditor with a title that changes while open', () => {
  it('follows the stored title while the draft is untouched', () => {
    const { rerender } = render(
      <ChatTitleEditor value="Can you help me with" onCommit={() => {}} />
    );
    expect(field()).toHaveValue('Can you help me with');
    rerender(<ChatTitleEditor value="Heating inspection" onCommit={() => {}} />);
    expect(field()).toHaveValue('Heating inspection');
  });

  it('keeps what the user is typing', () => {
    const { rerender } = render(
      <ChatTitleEditor value="Can you help me with" onCommit={() => {}} />
    );
    fireEvent.change(field(), { target: { value: 'My own title' } });
    rerender(<ChatTitleEditor value="Heating inspection" onCommit={() => {}} />);
    expect(field()).toHaveValue('My own title');
  });

  it('commits the typed title, not the generated one', () => {
    const onCommit = jest.fn();
    const { rerender } = render(
      <ChatTitleEditor value="Can you help me with" onCommit={onCommit} />
    );
    fireEvent.change(field(), { target: { value: 'My own title' } });
    rerender(<ChatTitleEditor value="Heating inspection" onCommit={onCommit} />);
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('My own title');
  });
});
