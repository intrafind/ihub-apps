// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Improve with AI" on the instructions (slice 2 of the chat builder plan,
 * concepts/app-builder-rework-2026-11/04-chat-builder-implementation-plan.md):
 *
 * - The button shows only with `onImprove`, for editable instructions that are
 *   not empty.
 * - The dialog sends one turn that may change the instructions only and never
 *   asks back (`fields: ['system']`, `allowQuestions: false`), shows the text
 *   before and after, and "Use this text" hands the whole new value to the
 *   form. It saves nothing.
 *
 * The personal editor's wiring (over `POST /api/apps/_revise`) is in
 * user-app-conversation.test.jsx.
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';

const mockI18n = i18next.createInstance();
const mockT = (...args) => mockI18n.t(...args);
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: mockI18n })
}));
// The language field names the admin API module (machine translation); no request is made here.
jest.mock('../../../client/src/api/client', () => ({ __esModule: true, apiClient: jest.fn() }));
jest.mock('../../../client/src/utils/runtimeBasePath', () => ({
  buildPath: p => p,
  buildApiUrl: p => `/api${p}`
}));
jest.mock('../../../client/src/api/endpoints/projects.js', () => ({
  CRAWL_REQUEST_TIMEOUT_MS: 1000
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const SystemInstructionsSection =
  require('../../../client/src/features/admin/components/app-form/SystemInstructionsSection').default;
const ImproveInstructionsDialog =
  require('../../../client/src/features/admin/components/app-form/ImproveInstructionsDialog').default;

const IMPROVE = en.admin.apps.edit.improve;
const SYSTEM = { en: 'Answer questions.', de: 'Beantworte Fragen.' };

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en }, de: { translation: de } },
    interpolation: { escapeValue: false }
  });
});

describe('the button', () => {
  const renderSection = props =>
    render(
      <SystemInstructionsSection
        app={{ system: SYSTEM }}
        onChange={() => {}}
        t={mockT}
        {...props}
      />
    );

  test('is there only with onImprove', () => {
    const { unmount } = renderSection();
    expect(screen.queryByRole('button', { name: IMPROVE.action })).not.toBeInTheDocument();
    unmount();
    const onImprove = jest.fn();
    renderSection({ onImprove });
    fireEvent.click(screen.getByRole('button', { name: IMPROVE.action }));
    expect(onImprove).toHaveBeenCalled();
  });

  test('is not there for empty or read-only instructions', () => {
    const { unmount } = renderSection({ onImprove: jest.fn(), app: { system: { en: '  ' } } });
    expect(screen.queryByRole('button', { name: IMPROVE.action })).not.toBeInTheDocument();
    unmount();
    renderSection({ onImprove: jest.fn(), readOnly: true });
    expect(screen.queryByRole('button', { name: IMPROVE.action })).not.toBeInTheDocument();
  });
});

describe('the dialog', () => {
  function renderDialog(answer) {
    const refine = jest.fn(async () => answer);
    const onUse = jest.fn();
    const onClose = jest.fn();
    render(
      <ImproveInstructionsDialog
        isOpen
        onClose={onClose}
        refine={refine}
        draft={{ name: { en: 'Helper' }, system: SYSTEM }}
        language="en"
        onUse={onUse}
      />
    );
    return { refine, onUse, onClose };
  }

  const CHANGE = {
    reply: 'change',
    text: 'Shorter now.',
    question: null,
    patch: { system: { en: 'Answer briefly.', de: 'Beantworte Fragen.' } },
    changed: ['system'],
    suggestions: { websearch: false, integrations: [] },
    warnings: [],
    model: { id: 'stub', name: 'Stub' }
  };

  test('a chip sends one turn for the instructions only, without questions', async () => {
    const { refine } = renderDialog(CHANGE);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: IMPROVE.chips.shorter }));
    });
    expect(refine).toHaveBeenCalledTimes(1);
    const [request] = refine.mock.calls[0];
    expect(request).toMatchObject({
      draft: { name: { en: 'Helper' }, system: SYSTEM },
      conversation: [{ role: 'author', text: IMPROVE.requests.shorter }],
      fields: ['system'],
      allowQuestions: false,
      language: 'en'
    });
    expect(request.signal).toBeInstanceOf(AbortSignal);
    for (const chip of ['shorter', 'formal', 'steps', 'unsure']) {
      expect(screen.getByRole('button', { name: IMPROVE.chips[chip] })).toBeInTheDocument();
    }
  });

  test('shows before and after; "Use this text" hands over the whole value and saves nothing', async () => {
    const { onUse, onClose } = renderDialog(CHANGE);
    fireEvent.change(screen.getByRole('textbox', { name: IMPROVE.inputLabel }), {
      target: { value: 'Make it brief' }
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: IMPROVE.submit }));
    });
    expect(screen.getByTestId('improve-before')).toHaveTextContent('Answer questions.');
    expect(screen.getByTestId('improve-after')).toHaveTextContent('Answer briefly.');
    fireEvent.click(screen.getByRole('button', { name: IMPROVE.use }));
    expect(onUse).toHaveBeenCalledWith({ en: 'Answer briefly.', de: 'Beantworte Fragen.' });
    expect(onClose).toHaveBeenCalled();
  });

  test('an answer without a new text offers nothing to use', async () => {
    renderDialog({ ...CHANGE, reply: 'message', patch: {}, changed: [], text: 'Already fine.' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: IMPROVE.chips.formal }));
    });
    expect(screen.getByText(IMPROVE.noChange)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: IMPROVE.use })).not.toBeInTheDocument();
  });

  test('a failure says why', async () => {
    const refine = jest.fn(async () => {
      const error = new Error('429');
      error.response = {
        status: 429,
        data: { code: 'RATE_LIMITED', details: { limiter: 'appRevise' } }
      };
      throw error;
    });
    render(
      <ImproveInstructionsDialog
        isOpen
        onClose={() => {}}
        refine={refine}
        draft={{ system: SYSTEM }}
        language="en"
        onUse={() => {}}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: IMPROVE.chips.steps }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      en.admin.apps.conversation.error.tooManyTurns
    );
  });
});
