import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import ScheduledRunBanner from '../../../client/src/features/tasks/components/ScheduledRunBanner';
import { answerScheduledTaskApproval, fetchScheduledTaskRun } from '../../../client/src/api';

/**
 * The banner of a scheduled run's chat follows a run that is still going. The
 * answer of a run that was waiting for approval lands in the store when the run
 * ends, so that is when the chat is told to read itself again — not when the
 * approval was given, and not for a run that had already finished.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => <span data-testid="icon" />
}));

jest.mock('../../../client/src/api', () => ({
  fetchScheduledTaskRun: jest.fn(),
  answerScheduledTaskApproval: jest.fn()
}));

jest.mock('../../../client/src/features/tasks/hooks/useScheduledTasksConfig', () => ({
  useScheduledTasksEnabled: () => true
}));

const ORIGIN = {
  createdVia: 'scheduled-task',
  taskId: 'st-1',
  runId: 'r1',
  taskName: 'Morning digest'
};

const run = status => ({ id: 'r1', status, scheduledFor: '2026-10-01T06:00:00.000Z' });

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function renderBanner(onRunChanged) {
  return render(
    <MemoryRouter>
      <ScheduledRunBanner origin={ORIGIN} onRunChanged={onRunChanged} />
    </MemoryRouter>
  );
}

describe('ScheduledRunBanner', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    fetchScheduledTaskRun.mockReset();
    answerScheduledTaskApproval.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('tells the chat to re-read once a run it followed has finished', async () => {
    fetchScheduledTaskRun
      .mockResolvedValueOnce(run('queued'))
      .mockResolvedValueOnce(run('running'))
      .mockResolvedValue(run('succeeded'));
    const onRunChanged = jest.fn();
    renderBanner(onRunChanged);
    await flush();
    expect(screen.getByRole('link', { name: 'Morning digest' })).toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(4000);
    });
    await flush();
    expect(onRunChanged).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(4000);
    });
    await flush();
    expect(onRunChanged).toHaveBeenCalledTimes(1);

    // Finished runs are not polled, and the chat is not told twice.
    await act(async () => {
      jest.advanceTimersByTime(12000);
    });
    expect(onRunChanged).toHaveBeenCalledTimes(1);
    expect(fetchScheduledTaskRun).toHaveBeenCalledTimes(3);
  });

  it('tells the chat when an approved run it opened on is already over at the next read', async () => {
    fetchScheduledTaskRun
      .mockResolvedValueOnce({
        ...run('awaiting_approval'),
        approval: { toolId: 'dangerous', interactionId: 'i1' }
      })
      .mockResolvedValue(run('succeeded'));
    answerScheduledTaskApproval.mockResolvedValue({});
    const onRunChanged = jest.fn();
    renderBanner(onRunChanged);
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    });
    await flush();
    await flush();
    expect(answerScheduledTaskApproval).toHaveBeenCalled();
    expect(onRunChanged).toHaveBeenCalledTimes(1);
  });

  it('notices an approval answered elsewhere and re-reads the chat when that run ends', async () => {
    fetchScheduledTaskRun
      .mockResolvedValueOnce({
        ...run('awaiting_approval'),
        approval: { toolId: 'dangerous', interactionId: 'i1' }
      })
      .mockResolvedValue(run('succeeded'));
    const onRunChanged = jest.fn();
    renderBanner(onRunChanged);
    await flush();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();

    // Approved on the task page; the waiting run is re-read on a slower poll.
    await act(async () => {
      jest.advanceTimersByTime(15000);
    });
    await flush();
    expect(onRunChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('leaves the chat alone for a run that had already finished when it opened', async () => {
    fetchScheduledTaskRun.mockResolvedValue(run('succeeded'));
    const onRunChanged = jest.fn();
    renderBanner(onRunChanged);
    await flush();
    await act(async () => {
      jest.advanceTimersByTime(8000);
    });
    expect(onRunChanged).not.toHaveBeenCalled();
  });
});
