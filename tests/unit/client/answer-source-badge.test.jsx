import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import AnswerSourceBadge from '../../../client/src/features/chat/components/AnswerSourceBadge';

/**
 * The badge under an assistant answer names where the answer came from. An
 * Outlook answer grounded in the user's own email and its attachments must not
 * be labelled as "external" knowledge (issue #2451).
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: key => key })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name }) => <span data-testid="icon" data-name={name} />
}));

const renderBadge = sources => render(<AnswerSourceBadge answerSource={{ sources }} />);

describe('AnswerSourceBadge', () => {
  it('labels email-only context as email content', () => {
    renderBadge(['email']);
    expect(screen.getByText('chatMessage.answerSource.email')).toBeInTheDocument();
  });

  it('labels email plus attachments as email and attachments, not mixed', () => {
    renderBadge(['email', 'file']);
    expect(screen.getByText('chatMessage.answerSource.emailWithFiles')).toBeInTheDocument();
    expect(screen.getByTestId('icon')).toHaveAttribute('data-name', 'mail');
    expect(screen.queryByText('chatMessage.answerSource.mixed')).not.toBeInTheDocument();
  });

  it('keeps the mixed label when email is combined with another kind of source', () => {
    renderBadge(['email', 'websearch']);
    expect(screen.getByText('chatMessage.answerSource.mixed')).toBeInTheDocument();
  });

  it('keeps the file label for uploads without email', () => {
    renderBadge(['file']);
    expect(screen.getByText('chatMessage.answerSource.file')).toBeInTheDocument();
  });

  it('labels iFinder answers as iFinder documents, not web search', () => {
    renderBadge(['ifinder']);
    expect(screen.getByText('chatMessage.answerSource.ifinder')).toBeInTheDocument();
    expect(screen.queryByText('chatMessage.answerSource.websearch')).not.toBeInTheDocument();
  });
});
