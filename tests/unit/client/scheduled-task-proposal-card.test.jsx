import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import { ScheduledTaskProposalCard } from '../../../client/src/features/tasks/components/ScheduledTaskProposalCard';
import { fetchScheduledTasks } from '../../../client/src/api';

/**
 * The confirmation card of a task the assistant proposes in a chat. It shows
 * what will be saved, so whether the task will remember between runs, and the
 * notify mode that only exists with memory, have to be on it before Save.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => {
    const t = (key, fallback, values) => {
      if (typeof fallback !== 'string') return key;
      return fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values?.[name] ?? ''));
    };
    return { t, i18n: { language: 'en' } };
  }
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span data-testid="icon" />
}));

jest.mock('../../../client/src/features/tasks/hooks/useScheduledTasks', () => ({
  useScheduledTasksAvailable: () => true
}));

jest.mock('../../../client/src/api', () => ({
  createScheduledTask: jest.fn(),
  deleteScheduledTask: jest.fn(),
  fetchScheduledTasks: jest.fn(),
  pauseScheduledTask: jest.fn(),
  resumeScheduledTask: jest.fn(),
  updateScheduledTask: jest.fn()
}));

const SUMMARY = {
  name: 'OpenWebUI changelog',
  appName: 'Chat',
  scheduleDescription: 'Every Monday at 08:00',
  instructions: 'Summarize the latest features.',
  notify: 'always'
};

async function renderCard(proposal) {
  render(
    <MemoryRouter>
      <ScheduledTaskProposalCard
        proposal={{ proposalId: 'p-1', draft: {}, ...proposal }}
        chatId="chat-1"
      />
    </MemoryRouter>
  );
  // A create card looks up whether it was saved already (once per page load); let that settle.
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

const rowValue = label => screen.getByText(label, { selector: 'dt' }).nextSibling;

describe('ScheduledTaskProposalCard: memory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
    fetchScheduledTasks.mockResolvedValue({ items: [] });
  });

  it('says that the task will remember between runs', async () => {
    await renderCard({ action: 'create', summary: { ...SUMMARY, memory: true } });
    expect(rowValue('Remember between runs')).toHaveTextContent('Yes');
  });

  it('says that the task will not remember between runs', async () => {
    await renderCard({ action: 'create', summary: { ...SUMMARY, memory: false } });
    expect(rowValue('Remember between runs')).toHaveTextContent('No');
  });

  it('shows the row on a proposal to change a task as well', async () => {
    await renderCard({
      action: 'update',
      taskId: 'st-1',
      summary: { ...SUMMARY, memory: true }
    });
    expect(rowValue('Remember between runs')).toHaveTextContent('Yes');
  });

  it('shows no row when the summary does not say (an older proposal)', async () => {
    await renderCard({ action: 'create', summary: SUMMARY });
    expect(screen.queryByText('Remember between runs')).not.toBeInTheDocument();
  });

  it('shows no row on a proposal to delete a task', async () => {
    await renderCard({
      action: 'delete',
      taskId: 'st-1',
      summary: { ...SUMMARY, memory: true }
    });
    expect(screen.queryByText('Remember between runs')).not.toBeInTheDocument();
  });

  it('names the notify mode "only when something changed"', async () => {
    await renderCard({
      action: 'create',
      summary: { ...SUMMARY, memory: true, notify: 'changes' }
    });
    expect(rowValue('Notify me')).toHaveTextContent(
      'Only when something changed (and on failures)'
    );
  });

  it('does not add a notify row for the other modes', async () => {
    await renderCard({
      action: 'create',
      summary: { ...SUMMARY, memory: true, notify: 'failure' }
    });
    expect(screen.queryByText('Notify me')).not.toBeInTheDocument();
  });
});
