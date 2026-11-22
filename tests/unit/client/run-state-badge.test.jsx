// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import fs from 'fs';
import path from 'path';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';
import { RUN_STATUSES } from '../../../shared/runEvents.js';
import RunStateBadge, {
  RUN_STATES,
  RUN_STATE_BY_STATUS,
  runStateFromStatus
} from '../../../client/src/shared/components/RunStateBadge';

/**
 * The run state badge (#3782, #3196): every state renders icon plus text in
 * English and German from the real locale files, a value it does not know is
 * shown as it is, and every status the server sends today has a state.
 */

const mockI18n = i18next.createInstance();
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: ({ name, className = '' }) => (
    <span data-testid="icon" data-name={name} className={className} />
  )
}));

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en }, de: { translation: de } },
    parseMissingKeyHandler: key => `MISSING:${key}`,
    saveMissing: false
  });
});

afterEach(async () => {
  await mockI18n.changeLanguage('en');
});

/** The locale key of a state: `no_change` → `noChange`. */
const keyOf = state => state.replace(/_(\w)/g, (_, c) => c.toUpperCase());

describe('RunStateBadge', () => {
  test.each(['en', 'de'])('renders every state with its text in %s', async lang => {
    await mockI18n.changeLanguage(lang);
    const locale = lang === 'en' ? en : de;
    for (const state of RUN_STATES) {
      const { unmount } = render(<RunStateBadge state={state} />);
      const badge = screen.getByTestId('run-state-badge');
      expect(badge).toHaveAttribute('data-state', state);
      expect(typeof locale.runState[keyOf(state)]).toBe('string');
      expect(badge).toHaveTextContent(locale.runState[keyOf(state)]);
      expect(badge.textContent).not.toMatch(/MISSING:/);
      // Icon plus text: the icon is decoration.
      expect(badge.querySelector('[aria-hidden="true"] [data-testid="icon"]')).not.toBeNull();
      unmount();
    }
  });

  test('every runState string is used by a state, and both languages have the same keys', () => {
    const used = new Set([...RUN_STATES.map(state => keyOf(state)), 'stalledSince']);
    expect(Object.keys(en.runState).sort((a, b) => a.localeCompare(b))).toEqual(
      [...used].sort((a, b) => a.localeCompare(b))
    );
    expect(Object.keys(de.runState).sort((a, b) => a.localeCompare(b))).toEqual(
      Object.keys(en.runState).sort((a, b) => a.localeCompare(b))
    );
  });

  test('the German words follow the glossary of the epic', async () => {
    await mockI18n.changeLanguage('de');
    const words = {
      done: 'Erledigt',
      blocked: 'Blockiert',
      needs_attention: 'Aktion erforderlich',
      no_change: 'Keine Änderung',
      running: 'Läuft',
      scheduled: 'Geplant',
      // Names no one: the badge is also seen by someone who is not waited for.
      waiting: 'Wartet auf Antwort'
    };
    for (const [state, word] of Object.entries(words)) {
      const { unmount } = render(<RunStateBadge state={state} />);
      expect(screen.getByTestId('run-state-badge')).toHaveTextContent(word);
      unmount();
    }
  });

  test('a run that waits names no one: an admin or a group may see it, not only the person waited for', async () => {
    const { unmount } = render(<RunStateBadge state="waiting" />);
    expect(screen.getByTestId('run-state-badge')).toHaveTextContent('Waiting for an answer');
    expect(screen.getByTestId('run-state-badge').textContent).not.toMatch(/\byou\b/i);
    unmount();
    // "Needs you" / "Wartet auf Sie" belong to the viewer's own list, not to the badge.
    for (const locale of [en, de]) {
      expect(locale.runState.waiting).not.toMatch(/\b(you|Sie)\b/);
    }
  });

  test('a stalled run can say since when', async () => {
    render(<RunStateBadge state="stalled" since="14:30" />);
    expect(screen.getByTestId('run-state-badge')).toHaveTextContent('No progress since 14:30');
    await mockI18n.changeLanguage('de');
    render(<RunStateBadge state="stalled" since="14:30" />);
    expect(screen.getByText('Kein Fortschritt seit 14:30')).toBeInTheDocument();
  });

  test('the running icon spins only without reduced motion, and shows a clock under it', () => {
    render(<RunStateBadge state="running" />);
    const icons = screen.getAllByTestId('icon');
    const spinner = icons.find(icon => icon.dataset.name === 'spinner');
    const still = icons.find(icon => icon.dataset.name === 'clock');
    expect(spinner.className).toMatch(/animate-spin/);
    expect(spinner.className).toMatch(/motion-reduce:hidden/);
    expect(still.className).toMatch(/motion-reduce:inline-block/);
  });

  test('a value it does not know is shown as it is, neutral, marked unknown', () => {
    render(<RunStateBadge state="teleported" />);
    const badge = screen.getByTestId('run-state-badge');
    expect(badge).toHaveTextContent('teleported');
    expect(badge).toHaveAttribute('data-state', 'unknown');
    expect(badge.className).toMatch(/bg-gray-100/);
  });

  test('without the icon it is text only', () => {
    render(<RunStateBadge state="done" showIcon={false} />);
    expect(screen.queryByTestId('icon')).toBeNull();
    expect(screen.getByTestId('run-state-badge')).toHaveTextContent('Done');
  });
});

describe('the statuses the server sends', () => {
  const taskModel = fs.readFileSync(
    path.resolve(__dirname, '../../../server/services/scheduler/tasks/taskModel.js'),
    'utf8'
  );
  const scheduledRunStatuses = [
    ...taskModel
      .match(/export const RUN_STATUSES = Object\.freeze\(\[([^\]]*)\]\)/)[1]
      .matchAll(/'([a-z_]+)'/g)
  ].map(match => match[1]);

  test('every run status has a state (shared/runEvents.js)', () => {
    expect(Object.keys(RUN_STATE_BY_STATUS.run).sort((a, b) => a.localeCompare(b))).toEqual(
      [...RUN_STATUSES].sort((a, b) => a.localeCompare(b))
    );
    for (const status of RUN_STATUSES) {
      expect(RUN_STATES).toContain(runStateFromStatus('run', status));
    }
  });

  test('every scheduled-run status has a state (taskModel.js)', () => {
    expect(scheduledRunStatuses.length).toBeGreaterThan(0);
    expect(
      Object.keys(RUN_STATE_BY_STATUS.scheduledRun).sort((a, b) => a.localeCompare(b))
    ).toEqual([...scheduledRunStatuses].sort((a, b) => a.localeCompare(b)));
    for (const status of scheduledRunStatuses) {
      expect(RUN_STATES).toContain(runStateFromStatus('scheduledRun', status));
    }
  });

  test("a run's paused waits for the person; a status of another source is not guessed", () => {
    expect(runStateFromStatus('run', 'paused')).toBe('waiting');
    expect(runStateFromStatus('scheduledRun', 'awaiting_approval')).toBe('waiting');
    expect(runStateFromStatus('scheduledRun', 'completed')).toBe('completed');
    expect(runStateFromStatus('nowhere', 'running')).toBe('running');
    expect(runStateFromStatus('run', 'toString')).toBe('toString');
  });
});
