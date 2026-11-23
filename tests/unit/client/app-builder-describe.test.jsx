// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The describe start of the app builder: the description box of the Start
 * screen (`DescribeStart`), the draft notice of the Essentials screen
 * (`DraftExtras`) and the map from a failed draft to its message
 * (`generateErrors`).
 *
 * The components are the real ones, with the real English and German texts.
 * `generate` stands for the call of the API module and is the only stub. The
 * two harnesses below stand for the create page: they hold the state the
 * components leave to the page and turn it into a draft and a request body
 * with the product code of the shared core (`draftFromGenerated`,
 * `buildCreatePayload`).
 */

import { useState } from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import i18next from 'i18next';
import en from '../../../shared/i18n/en.json';
import de from '../../../shared/i18n/de.json';
import { newAppDefaults } from '../../../shared/appDefaults.js';
import { APP_GENERATOR_DESCRIPTION_MAX } from '../../../shared/appGenerator.js';
import {
  buildCreatePayload,
  draftFromGenerated
} from '../../../client/src/features/admin/utils/appDraft.js';
import {
  GENERATE_CLIENT_ERROR_KEYS,
  GENERATE_ERROR_KEYS,
  descriptionProblem,
  generateErrorMessage,
  isCancelledRequest
} from '../../../client/src/features/admin/components/app-create/generateErrors.js';

const mockI18n = i18next.createInstance();

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockI18n.t.bind(mockI18n), i18n: mockI18n })
}));

// Icon reads the runtime base path through `import.meta`, which the Jest transform cannot parse.
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const DescribeStartModule = require('../../../client/src/features/admin/components/app-create/DescribeStart');
const DescribeStart = DescribeStartModule.default;
const { DESCRIBE_EXAMPLE_KEYS } = DescribeStartModule;
const DraftExtras =
  require('../../../client/src/features/admin/components/app-create/DraftExtras').default;

beforeAll(async () => {
  await mockI18n.init({
    lng: 'en',
    resources: { en: { translation: en }, de: { translation: de } },
    interpolation: { escapeValue: false },
    parseMissingKeyHandler: key => `MISSING:${key}`
  });
});

const TEXT = en.admin.apps.create;
const DESCRIPTION = 'An assistant that rewrites a difficult text in plain language.';
const NO_EXTRAS = { inputFields: true, webSearch: false, integrationIds: [] };

/** A failed request as axios rejects it: a problem response of the server. */
const problem = (code, extra = {}) => ({
  name: 'AxiosError',
  code: 'ERR_BAD_RESPONSE',
  response: { status: 500, data: { code, detail: `Detail of ${code}.`, ...extra } }
});

/** A failed request that got no response. */
const clientFailure = (code, message, name = 'AxiosError') => ({ name, code, message });

/** The answer of `POST /api/admin/apps/_generate`. */
function draftResult(overrides = {}) {
  return {
    app: {
      ...newAppDefaults('en'),
      id: 'plain-language-summary',
      name: { en: 'Plain-language summary' },
      description: { en: 'Rewrites a text so that everyone understands it.' },
      system: { en: 'You rewrite texts in plain language. Keep all facts.' },
      prompt: { en: 'Reading level: {{reading_level}}\n\n{{content}}' },
      allowEmptyContent: true,
      variables: [
        { name: 'text_kind', label: { en: 'Kind of text' }, type: 'string', required: false },
        {
          name: 'reading_level',
          label: { en: 'Reading level' },
          type: 'string',
          required: true,
          predefinedValues: [
            { value: 'general', label: { en: 'General readers' } },
            { value: 'easy', label: { en: 'Very easy language' } }
          ]
        }
      ]
    },
    suggestions: {
      websearch: true,
      integrations: [
        { id: 'jira', label: 'Jira', actions: ['searchIssues', 'getIssue'] },
        { id: 'wiki', label: 'Team wiki', actions: [] }
      ]
    },
    warnings: [],
    model: { id: 'gemini-flash', name: 'Gemini Flash' },
    ...overrides
  };
}

/** A promise the test settles by hand. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A `generate` whose every call waits for the test. `calls[i]` is `{ request, resolve, reject }`. */
function manualGenerate() {
  const calls = [];
  const generate = jest.fn(request => {
    const pending = deferred();
    calls.push({ request, resolve: pending.resolve, reject: pending.reject });
    return pending.promise;
  });
  return { generate, calls };
}

const settle = async action => {
  await act(async () => {
    action();
  });
};

/** The Start screen as far as the description box needs it. */
function StartHarness({ generate, onDraft = () => {}, initial = '', ...rest }) {
  const [description, setDescription] = useState(initial);
  return (
    <>
      <DescribeStart
        description={description}
        onDescriptionChange={setDescription}
        onDraft={onDraft}
        generate={generate}
        language="en"
        modelName="Gemini Flash"
        {...rest}
      />
      <button type="button">{TEXT.start.blank}</button>
    </>
  );
}

/**
 * Both screens as the create page wires them: the description survives the
 * screen change, a draft becomes `draftFromGenerated(result, extras)` plus
 * what the author typed, and "Create and test" hands over the request body.
 */
function CreateHarness({ generate, onCreate = () => {} }) {
  const [description, setDescription] = useState('');
  const [result, setResult] = useState(null);
  const [extras, setExtras] = useState(NO_EXTRAS);
  const [typed, setTyped] = useState({});

  const onDraft = next => {
    setResult(next);
    setExtras(NO_EXTRAS);
    setTyped({});
  };

  if (!result) {
    return (
      <DescribeStart
        description={description}
        onDescriptionChange={setDescription}
        onDraft={onDraft}
        generate={generate}
        language="en"
      />
    );
  }

  const draft = { ...draftFromGenerated(result, extras), ...typed };
  const field = (label, key) => (
    <label>
      {label}
      <textarea
        value={draft[key]?.en ?? ''}
        onChange={event => setTyped({ ...typed, [key]: { en: event.target.value } })}
      />
    </label>
  );
  return (
    <>
      <DraftExtras
        result={result}
        draft={draft}
        description={description}
        onDescriptionChange={setDescription}
        extras={extras}
        onExtrasChange={setExtras}
        onDraft={onDraft}
        generate={generate}
        language="en"
        edited={Object.keys(typed)}
      />
      {field(TEXT.essentials.name, 'name')}
      {field(TEXT.essentials.description, 'description')}
      {field(TEXT.essentials.instructions, 'system')}
      <button type="button" onClick={() => onCreate(buildCreatePayload(draft))}>
        {TEXT.submit}
      </button>
    </>
  );
}

const descriptionBox = () => screen.getByLabelText(TEXT.start.label);
const prepareButton = () => screen.getByRole('button', { name: TEXT.start.generate });
const type = (element, value) => fireEvent.change(element, { target: { value } });

/** Renders both screens, drafts once and returns what the test needs on Essentials. */
async function renderWithDraft(result = draftResult()) {
  const onCreate = jest.fn();
  const { generate, calls } = manualGenerate();
  render(<CreateHarness generate={generate} onCreate={onCreate} />);
  type(descriptionBox(), DESCRIPTION);
  fireEvent.click(prepareButton());
  await settle(() => calls[0].resolve(result));
  const create = () => {
    fireEvent.click(screen.getByRole('button', { name: TEXT.submit }));
    return onCreate.mock.calls.at(-1)[0];
  };
  return { generate, calls, create };
}

describe('generateErrors: the message of a failed draft', () => {
  const ERROR = 'admin.apps.create.error';
  // Every row of the first table of plan section 4.4: what the request rejected with, and its key.
  const ROWS = [
    ['503 APP_GENERATOR_NO_MODEL', problem('APP_GENERATOR_NO_MODEL'), `${ERROR}.noModel`],
    [
      '502 APP_GENERATOR_INVALID_ANSWER',
      problem('APP_GENERATOR_INVALID_ANSWER'),
      `${ERROR}.unreadable`
    ],
    ['NETWORK', problem('NETWORK'), `${ERROR}.model`],
    ['PROVIDER_ERROR', problem('PROVIDER_ERROR'), `${ERROR}.model`],
    ['EMPTY_RESPONSE', problem('EMPTY_RESPONSE'), `${ERROR}.model`],
    ['TIMEOUT', problem('TIMEOUT'), `${ERROR}.model`],
    [
      "the client's own 90-second timeout",
      clientFailure('ECONNABORTED', 'timeout of 90000ms exceeded'),
      `${ERROR}.model`
    ],
    ['AUTH_FAILED', problem('AUTH_FAILED'), `${ERROR}.modelSetup`],
    ['MODEL_NOT_FOUND', problem('MODEL_NOT_FOUND'), `${ERROR}.modelSetup`],
    ['INVALID_REQUEST', problem('INVALID_REQUEST'), `${ERROR}.modelSetup`],
    ['CONTEXT_WINDOW_EXCEEDED', problem('CONTEXT_WINDOW_EXCEEDED'), `${ERROR}.modelSetup`],
    ['429 QUOTA_EXCEEDED', problem('QUOTA_EXCEEDED'), `${ERROR}.quota`],
    ['422 CONTENT_POLICY', problem('CONTENT_POLICY'), `${ERROR}.refused`],
    [
      '429 RATE_LIMITED of the draft limit',
      problem('RATE_LIMITED', { details: { limiter: 'appGenerator' } }),
      `${ERROR}.tooManyDrafts`
    ],
    ['429 RATE_LIMITED without a limiter', problem('RATE_LIMITED'), `${ERROR}.busy`],
    [
      '429 RATE_LIMITED of another limiter',
      problem('RATE_LIMITED', { details: { limiter: 'adminApi' } }),
      `${ERROR}.busy`
    ],
    ['403 FEATURE_DISABLED', problem('FEATURE_DISABLED'), 'admin.apps.create.generatorOff']
  ];

  it.each(ROWS)('%s', (_label, error, key) => {
    expect(generateErrorMessage(error)).toEqual({ key });
    expect(mockI18n.exists(key)).toBe(true);
  });

  it('gives each row of the table a message of its own', () => {
    const keys = [...new Set(ROWS.map(([, , key]) => key))];
    const texts = keys.map(key => mockI18n.t(key));
    expect(keys).toHaveLength(9);
    expect(new Set(texts).size).toBe(keys.length);
  });

  it('shows nothing when the author cancelled', () => {
    expect(GENERATE_ERROR_KEYS.ABORTED).toBeNull();
    expect(generateErrorMessage(problem('ABORTED'))).toBeNull();
    const cancelled = clientFailure('ERR_CANCELED', 'canceled', 'CanceledError');
    expect(isCancelledRequest(cancelled)).toBe(true);
    expect(generateErrorMessage(cancelled)).toBeNull();
    expect(generateErrorMessage(clientFailure('aborted', 'aborted', 'AbortError'))).toBeNull();
    expect(isCancelledRequest(problem('RATE_LIMITED'))).toBe(false);
  });

  it('gives any other code the general message with the detail of the response', () => {
    expect(generateErrorMessage(problem('FORBIDDEN'))).toEqual({
      key: `${ERROR}.failed`,
      values: { detail: 'Detail of FORBIDDEN.' }
    });
    expect(generateErrorMessage(clientFailure('ERR_NETWORK', 'Network Error'))).toEqual({
      key: `${ERROR}.failed`,
      values: { detail: '' }
    });
    // A response that is no problem body (a proxy's HTML page) has no code and no detail.
    const html = { code: 'ERR_BAD_RESPONSE', response: { status: 502, data: '<html></html>' } };
    expect(generateErrorMessage(html)).toEqual({ key: `${ERROR}.failed`, values: { detail: '' } });
    expect(generateErrorMessage(undefined).key).toBe(`${ERROR}.failed`);
  });

  it('never picks a message from a text or from a key of Object.prototype', () => {
    expect(generateErrorMessage(problem('constructor')).key).toBe(`${ERROR}.failed`);
    const byPrototype = problem('RATE_LIMITED', { details: { limiter: 'toString' } });
    expect(generateErrorMessage(byPrototype)).toEqual({ key: `${ERROR}.busy` });
    const byText = { message: 'RATE_LIMITED timeout appGenerator', response: { data: {} } };
    expect(generateErrorMessage(byText).key).toBe(`${ERROR}.failed`);
  });

  it('does not advise "try again in a moment" where a retry cannot help', () => {
    for (const code of ['AUTH_FAILED', 'QUOTA_EXCEEDED', 'CONTENT_POLICY']) {
      const { key } = generateErrorMessage(problem(code));
      expect(mockI18n.t(key, { lng: 'en' })).not.toMatch(/try again in a moment/i);
      expect(mockI18n.t(key, { lng: 'de' })).not.toMatch(/gleich noch einmal/i);
    }
    const retry = generateErrorMessage(problem('PROVIDER_ERROR')).key;
    expect(mockI18n.t(retry, { lng: 'en' })).toMatch(/try again in a moment/i);
    expect(mockI18n.t(retry, { lng: 'de' })).toMatch(/gleich noch einmal/i);
  });

  it('checks the description as the server counts it, after trimming', () => {
    expect(descriptionProblem('')).toEqual({ key: `${ERROR}.empty` });
    expect(descriptionProblem('  \n ')).toEqual({ key: `${ERROR}.empty` });
    expect(descriptionProblem(undefined)).toEqual({ key: `${ERROR}.empty` });
    expect(descriptionProblem('x'.repeat(APP_GENERATOR_DESCRIPTION_MAX))).toBeNull();
    expect(descriptionProblem(` ${'x'.repeat(APP_GENERATOR_DESCRIPTION_MAX)} `)).toBeNull();
    expect(descriptionProblem('x'.repeat(APP_GENERATOR_DESCRIPTION_MAX + 1))).toEqual({
      key: `${ERROR}.tooLong`
    });
  });

  it('names only keys that are a text in English and German', () => {
    const leaves = value =>
      value === null
        ? []
        : typeof value === 'string'
          ? [value]
          : Object.values(value).flatMap(leaves);
    const keys = [
      ...leaves(GENERATE_ERROR_KEYS),
      ...leaves(GENERATE_CLIENT_ERROR_KEYS),
      ...leaves(DESCRIBE_EXAMPLE_KEYS)
    ];
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) {
      for (const lng of ['en', 'de']) {
        const text = mockI18n.t(key, { lng, detail: '' });
        expect(`${lng} ${key}: ${typeof text === 'string' && !text.startsWith('MISSING:')}`).toBe(
          `${lng} ${key}: true`
        );
      }
    }
  });
});

describe('DescribeStart: the description box of the Start screen', () => {
  it('shows the box with its label, hint, examples and the model that gets the description', () => {
    render(<StartHarness generate={jest.fn()} />);
    expect(screen.getByRole('heading', { name: TEXT.start.heading })).toBeInTheDocument();
    expect(descriptionBox()).toHaveAttribute('placeholder', TEXT.start.placeholder);
    expect(descriptionBox()).toHaveAccessibleDescription(TEXT.start.help);
    expect(screen.getByText(TEXT.start.privacy.replace('{{model}}', 'Gemini Flash'))).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('leaves out the line that names the model when the page knows none', () => {
    render(<StartHarness generate={jest.fn()} modelName={undefined} />);
    expect(screen.queryByText(/sent to the AI model/)).not.toBeInTheDocument();
  });

  it('fills the box from an example chip and does not send it', () => {
    const generate = jest.fn();
    render(<StartHarness generate={generate} initial="old text" />);
    fireEvent.click(screen.getByRole('button', { name: TEXT.start.examples.reply.chip }));
    expect(descriptionBox()).toHaveValue(TEXT.start.examples.reply.text);
    expect(descriptionBox()).toHaveFocus();
    expect(generate).not.toHaveBeenCalled();
  });

  it('sends the trimmed description with the language and a signal, and hands over the draft', async () => {
    const onDraft = jest.fn();
    const { generate, calls } = manualGenerate();
    render(<StartHarness generate={generate} onDraft={onDraft} />);
    type(descriptionBox(), `  ${DESCRIPTION}\n`);
    fireEvent.click(prepareButton());

    expect(generate).toHaveBeenCalledTimes(1);
    expect(calls[0].request).toEqual({
      description: DESCRIPTION,
      language: 'en',
      signal: expect.any(AbortSignal)
    });
    expect(calls[0].request.signal.aborted).toBe(false);

    const result = draftResult();
    await settle(() => calls[0].resolve(result));
    expect(onDraft).toHaveBeenCalledTimes(1);
    expect(onDraft).toHaveBeenCalledWith(result, DESCRIPTION);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('uses the UI language when the page names no content language', () => {
    const { generate, calls } = manualGenerate();
    render(<StartHarness generate={generate} initial={DESCRIPTION} language={undefined} />);
    fireEvent.click(prepareButton());
    expect(calls[0].request.language).toBe('en');
  });

  it('starts the draft on Ctrl+Enter and Cmd+Enter, not on Enter', () => {
    const { generate } = manualGenerate();
    render(<StartHarness generate={generate} initial={DESCRIPTION} />);
    fireEvent.keyDown(descriptionBox(), { key: 'Enter' });
    expect(generate).not.toHaveBeenCalled();
    fireEvent.keyDown(descriptionBox(), { key: 'Enter', ctrlKey: true });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('says what happens while the draft is prepared and keeps the text readable', async () => {
    const { generate, calls } = manualGenerate();
    render(<StartHarness generate={generate} initial={DESCRIPTION} />);
    fireEvent.click(prepareButton());

    const busy = screen.getByRole('button', { name: TEXT.start.generating });
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('status')).toHaveTextContent(TEXT.start.generating);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(descriptionBox()).toHaveValue(DESCRIPTION);
    expect(descriptionBox()).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: TEXT.cancel })).toBeVisible();

    await settle(() => calls[0].reject(problem('PROVIDER_ERROR')));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(prepareButton()).not.toHaveAttribute('aria-disabled');
    expect(descriptionBox()).not.toHaveAttribute('readonly');
  });

  it('runs one request at a time', () => {
    const { generate } = manualGenerate();
    render(<StartHarness generate={generate} initial={DESCRIPTION} />);
    fireEvent.click(prepareButton());
    fireEvent.click(screen.getByRole('button', { name: TEXT.start.generating }));
    fireEvent.click(screen.getByRole('button', { name: TEXT.start.generating }));
    fireEvent.keyDown(descriptionBox(), { key: 'Enter', metaKey: true });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('asks for a description before it sends anything', () => {
    const generate = jest.fn();
    render(<StartHarness generate={generate} initial="   " />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(prepareButton());
    expect(screen.getByRole('alert')).toHaveTextContent(TEXT.error.empty);
    expect(descriptionBox()).toHaveAttribute('aria-invalid', 'true');
    expect(descriptionBox()).toHaveAccessibleDescription(`${TEXT.start.help} ${TEXT.error.empty}`);
    expect(generate).not.toHaveBeenCalled();

    type(descriptionBox(), 'A');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(descriptionBox()).not.toHaveAttribute('aria-invalid');
  });

  it('refuses a description over 2,000 characters without cutting it', () => {
    const generate = jest.fn();
    const long = 'x'.repeat(APP_GENERATOR_DESCRIPTION_MAX + 1);
    render(<StartHarness generate={generate} initial={long} />);
    fireEvent.click(prepareButton());
    expect(screen.getByRole('alert')).toHaveTextContent(TEXT.error.tooLong);
    expect(descriptionBox()).toHaveValue(long);
    expect(generate).not.toHaveBeenCalled();
  });

  describe('a failed draft', () => {
    const FAILED = TEXT.error.failed.replace('{{detail}}', '').trim();
    const CASES = [
      ['APP_GENERATOR_NO_MODEL', problem('APP_GENERATOR_NO_MODEL'), TEXT.error.noModel],
      [
        'APP_GENERATOR_INVALID_ANSWER',
        problem('APP_GENERATOR_INVALID_ANSWER'),
        TEXT.error.unreadable
      ],
      ['NETWORK', problem('NETWORK'), TEXT.error.model],
      ['PROVIDER_ERROR', problem('PROVIDER_ERROR'), TEXT.error.model],
      ['EMPTY_RESPONSE', problem('EMPTY_RESPONSE'), TEXT.error.model],
      ['TIMEOUT', problem('TIMEOUT'), TEXT.error.model],
      [
        'the client timeout',
        clientFailure('ECONNABORTED', 'timeout of 90000ms exceeded'),
        TEXT.error.model
      ],
      ['AUTH_FAILED', problem('AUTH_FAILED'), TEXT.error.modelSetup],
      ['MODEL_NOT_FOUND', problem('MODEL_NOT_FOUND'), TEXT.error.modelSetup],
      ['INVALID_REQUEST', problem('INVALID_REQUEST'), TEXT.error.modelSetup],
      ['CONTEXT_WINDOW_EXCEEDED', problem('CONTEXT_WINDOW_EXCEEDED'), TEXT.error.modelSetup],
      ['QUOTA_EXCEEDED', problem('QUOTA_EXCEEDED'), TEXT.error.quota],
      ['CONTENT_POLICY', problem('CONTENT_POLICY'), TEXT.error.refused],
      [
        'RATE_LIMITED of the draft limit',
        problem('RATE_LIMITED', { details: { limiter: 'appGenerator' } }),
        TEXT.error.tooManyDrafts
      ],
      ['RATE_LIMITED without a limiter', problem('RATE_LIMITED'), TEXT.error.busy],
      ['FEATURE_DISABLED', problem('FEATURE_DISABLED'), TEXT.generatorOff],
      ['another code', problem('FORBIDDEN'), `${FAILED} Detail of FORBIDDEN.`],
      ['no response at all', clientFailure('ERR_NETWORK', 'Network Error'), FAILED],
      // The request stopped although the author did not cancel: it got no answer.
      [
        'an abort nobody asked for',
        clientFailure('ERR_CANCELED', 'canceled', 'CanceledError'),
        TEXT.error.model
      ]
    ];

    it.each(CASES)(
      '%s shows its message and keeps the description',
      async (_label, error, text) => {
        const onDraft = jest.fn();
        const { generate, calls } = manualGenerate();
        render(<StartHarness generate={generate} onDraft={onDraft} initial={DESCRIPTION} />);
        fireEvent.click(prepareButton());
        await settle(() => calls[0].reject(error));

        const alert = screen.getByRole('alert');
        expect(alert.textContent).toBe(text);
        expect(descriptionBox()).toHaveValue(DESCRIPTION);
        expect(descriptionBox()).not.toHaveAttribute('aria-invalid');
        expect(onDraft).not.toHaveBeenCalled();
        // The other starts stay reachable: nothing covers or disables them.
        expect(screen.getByRole('button', { name: TEXT.start.blank })).toBeEnabled();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      }
    );

    it.each(['AUTH_FAILED', 'QUOTA_EXCEEDED', 'CONTENT_POLICY'])(
      '%s does not say "try again in a moment"',
      async code => {
        const { generate, calls } = manualGenerate();
        render(<StartHarness generate={generate} initial={DESCRIPTION} />);
        fireEvent.click(prepareButton());
        await settle(() => calls[0].reject(problem(code)));
        expect(screen.getByRole('alert').textContent).not.toMatch(/try again in a moment/i);
      }
    );

    it('treats an answer without an app as a draft that cannot be used', async () => {
      const onDraft = jest.fn();
      const { generate, calls } = manualGenerate();
      render(<StartHarness generate={generate} onDraft={onDraft} initial={DESCRIPTION} />);
      fireEvent.click(prepareButton());
      await settle(() => calls[0].resolve({ suggestions: {} }));
      expect(screen.getByRole('alert')).toHaveTextContent(TEXT.error.unreadable);
      expect(onDraft).not.toHaveBeenCalled();
    });

    it('clears the old message when the author tries again', async () => {
      const onDraft = jest.fn();
      const { generate, calls } = manualGenerate();
      render(<StartHarness generate={generate} onDraft={onDraft} initial={DESCRIPTION} />);
      fireEvent.click(prepareButton());
      await settle(() => calls[0].reject(problem('PROVIDER_ERROR')));
      expect(screen.getByRole('alert')).toHaveTextContent(TEXT.error.model);

      // Typing does not hide what the server said.
      type(descriptionBox(), `${DESCRIPTION} More.`);
      expect(screen.getByRole('alert')).toHaveTextContent(TEXT.error.model);

      fireEvent.click(prepareButton());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(generate).toHaveBeenCalledTimes(2);
      expect(calls[1].request.description).toBe(`${DESCRIPTION} More.`);

      await settle(() => calls[1].reject(problem('QUOTA_EXCEEDED')));
      expect(screen.getByRole('alert').textContent).toBe(TEXT.error.quota);

      fireEvent.click(prepareButton());
      const result = draftResult();
      await settle(() => calls[2].resolve(result));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(onDraft).toHaveBeenCalledWith(result, `${DESCRIPTION} More.`);
    });
  });

  describe('Cancel', () => {
    it('aborts the request, shows no error and drops the late answer', async () => {
      const onDraft = jest.fn();
      const { generate, calls } = manualGenerate();
      render(<StartHarness generate={generate} onDraft={onDraft} initial={DESCRIPTION} />);
      fireEvent.click(prepareButton());
      fireEvent.click(screen.getByRole('button', { name: TEXT.cancel }));

      expect(calls[0].request.signal.aborted).toBe(true);
      expect(prepareButton()).not.toHaveAttribute('aria-disabled');
      expect(prepareButton()).toHaveFocus();
      expect(screen.queryByRole('button', { name: TEXT.cancel })).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toBeEmptyDOMElement();
      expect(descriptionBox()).toHaveValue(DESCRIPTION);

      await settle(() => calls[0].resolve(draftResult()));
      expect(onDraft).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it.each([
      [
        'the cancelled request of axios',
        clientFailure('ERR_CANCELED', 'canceled', 'CanceledError')
      ],
      ['a late failure of the server', problem('PROVIDER_ERROR')]
    ])('shows no error for %s', async (_label, error) => {
      const { generate, calls } = manualGenerate();
      render(<StartHarness generate={generate} initial={DESCRIPTION} />);
      fireEvent.click(prepareButton());
      fireEvent.click(screen.getByRole('button', { name: TEXT.cancel }));
      await settle(() => calls[0].reject(error));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('applies only the answer of the current request', async () => {
      const onDraft = jest.fn();
      const { generate, calls } = manualGenerate();
      render(<StartHarness generate={generate} onDraft={onDraft} initial={DESCRIPTION} />);
      fireEvent.click(prepareButton());
      fireEvent.click(screen.getByRole('button', { name: TEXT.cancel }));
      fireEvent.click(prepareButton());
      expect(generate).toHaveBeenCalledTimes(2);

      // The first, cancelled request answers while the second one runs.
      await settle(() => calls[0].resolve(draftResult({ model: { id: 'stale', name: 'Stale' } })));
      expect(onDraft).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: TEXT.start.generating })).toBeInTheDocument();

      const second = draftResult();
      await settle(() => calls[1].resolve(second));
      expect(onDraft).toHaveBeenCalledTimes(1);
      expect(onDraft).toHaveBeenCalledWith(second, DESCRIPTION);
    });

    it('cancels on Escape, but leaves Escape to an open dialog', () => {
      const { generate, calls } = manualGenerate();
      render(
        <>
          <StartHarness generate={generate} initial={DESCRIPTION} />
          <div role="dialog">
            <button type="button">In a dialog</button>
          </div>
        </>
      );
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(generate).not.toHaveBeenCalled();

      fireEvent.click(prepareButton());
      fireEvent.keyDown(screen.getByRole('button', { name: 'In a dialog' }), { key: 'Escape' });
      expect(calls[0].request.signal.aborted).toBe(false);

      fireEvent.keyDown(descriptionBox(), { key: 'Escape' });
      expect(calls[0].request.signal.aborted).toBe(true);
      expect(prepareButton()).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('stops the request when the screen goes away', async () => {
      const onDraft = jest.fn();
      const { generate, calls } = manualGenerate();
      const { unmount } = render(
        <StartHarness generate={generate} onDraft={onDraft} initial={DESCRIPTION} />
      );
      fireEvent.click(prepareButton());
      unmount();
      expect(calls[0].request.signal.aborted).toBe(true);
      await settle(() => calls[0].resolve(draftResult()));
      expect(onDraft).not.toHaveBeenCalled();
    });
  });
});

describe('DraftExtras: the draft notice of the Essentials screen', () => {
  const regenerateButton = () => screen.getByRole('button', { name: TEXT.draft.regenerate });
  const inputFieldsBox = () =>
    screen.getByRole('checkbox', {
      name: TEXT.draft.inputFields.replace('{{names}}', 'Kind of text, Reading level')
    });
  const webSearchBox = () => screen.getByRole('checkbox', { name: TEXT.draft.webSearch });
  const jiraBox = () => screen.getByRole('checkbox', { name: 'Jira: searchIssues, getIssue' });
  const wikiBox = () => screen.getByRole('checkbox', { name: 'Team wiki: all functions' });

  it('fills Essentials from the draft and shows the description in an editable box', async () => {
    await renderWithDraft();

    expect(screen.getByLabelText(TEXT.essentials.name)).toHaveValue('Plain-language summary');
    expect(screen.getByLabelText(TEXT.essentials.description)).toHaveValue(
      'Rewrites a text so that everyone understands it.'
    );
    expect(screen.getByLabelText(TEXT.essentials.instructions)).toHaveValue(
      'You rewrite texts in plain language. Keep all facts.'
    );

    expect(screen.getByText(TEXT.draft.intro)).toBeVisible();
    expect(descriptionBox()).toHaveValue(DESCRIPTION);
    expect(descriptionBox()).not.toHaveAttribute('readonly');
    type(descriptionBox(), 'Another description.');
    expect(descriptionBox()).toHaveValue('Another description.');
  });

  it('lists the input fields ticked and the suggestions unticked', async () => {
    await renderWithDraft();

    const also = screen.getByRole('group', { name: TEXT.draft.also });
    expect(within(also).getAllByRole('checkbox')).toEqual([inputFieldsBox()]);
    expect(inputFieldsBox()).toBeChecked();
    expect(inputFieldsBox()).toBeEnabled();
    expect(screen.queryByText(TEXT.draft.fieldsLocked)).not.toBeInTheDocument();

    const suggestions = screen.getByRole('group', { name: TEXT.draft.suggestions });
    expect(suggestions).toHaveAccessibleDescription(TEXT.draft.suggestionsHelp);
    expect(within(suggestions).getAllByRole('checkbox')).toEqual([
      webSearchBox(),
      jiraBox(),
      wikiBox()
    ]);
    for (const box of within(suggestions).getAllByRole('checkbox')) expect(box).not.toBeChecked();
  });

  it('shows neither list when the draft has no input field and no suggestion', async () => {
    const bare = draftResult({ suggestions: { websearch: false, integrations: [] } });
    bare.app.variables = [];
    bare.app.prompt = undefined;
    await renderWithDraft(bare);
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  describe('the request body', () => {
    it('has no connected system and no web search when nothing is ticked', async () => {
      const { create } = await renderWithDraft();
      const body = create();
      expect(body).not.toHaveProperty('integrations');
      expect(body).not.toHaveProperty('websearch');
      expect(body.enabled).toBe(false);
      expect(body.variables.map(variable => variable.name)).toEqual(['text_kind', 'reading_level']);
    });

    it('gets exactly the suggestion the author ticks', async () => {
      const { create } = await renderWithDraft();

      fireEvent.click(webSearchBox());
      expect(webSearchBox()).toBeChecked();
      let body = create();
      expect(body.websearch).toEqual({ enabled: true });
      expect(body).not.toHaveProperty('integrations');

      fireEvent.click(webSearchBox());
      fireEvent.click(jiraBox());
      body = create();
      expect(body).not.toHaveProperty('websearch');
      expect(body.integrations).toEqual({ jira: { actions: ['searchIssues', 'getIssue'] } });

      // A system without declared actions is bound whole.
      fireEvent.click(jiraBox());
      fireEvent.click(wikiBox());
      body = create();
      expect(body.integrations).toEqual({ wiki: {} });

      fireEvent.click(wikiBox());
      body = create();
      expect(body).not.toHaveProperty('integrations');
      expect(body).not.toHaveProperty('websearch');
    });

    it('loses the input fields and their template lines when "Input fields" is unticked', async () => {
      const { create } = await renderWithDraft();
      fireEvent.click(inputFieldsBox());
      expect(inputFieldsBox()).not.toBeChecked();

      let body = create();
      expect(body.variables ?? []).toEqual([]);
      expect(body.prompt).toEqual({ en: '{{content}}' });
      expect(JSON.stringify(body)).not.toContain('reading_level');

      fireEvent.click(inputFieldsBox());
      body = create();
      expect(body.variables.map(variable => variable.name)).toEqual(['text_kind', 'reading_level']);
      expect(body.prompt).toEqual({ en: 'Reading level: {{reading_level}}\n\n{{content}}' });
    });
  });

  it('reports what is ticked in the shape draftFromGenerated takes', () => {
    const onExtrasChange = jest.fn();
    const props = {
      result: draftResult(),
      description: DESCRIPTION,
      onDescriptionChange: () => {},
      onExtrasChange,
      onDraft: () => {},
      generate: jest.fn(),
      language: 'en'
    };
    const { rerender } = render(<DraftExtras {...props} />);
    // Without `extras`: input fields ticked, no suggestion ticked.
    expect(inputFieldsBox()).toBeChecked();
    expect(webSearchBox()).not.toBeChecked();

    fireEvent.click(wikiBox());
    expect(onExtrasChange).toHaveBeenLastCalledWith({ ...NO_EXTRAS, integrationIds: ['wiki'] });

    // The IDs keep the order of the suggestions, whatever the order of the clicks.
    rerender(<DraftExtras {...props} extras={{ integrationIds: ['wiki'] }} />);
    fireEvent.click(jiraBox());
    expect(onExtrasChange).toHaveBeenLastCalledWith({
      ...NO_EXTRAS,
      integrationIds: ['jira', 'wiki']
    });

    fireEvent.click(inputFieldsBox());
    expect(onExtrasChange).toHaveBeenLastCalledWith({
      inputFields: false,
      webSearch: false,
      integrationIds: ['wiki']
    });
  });

  describe('input fields the instructions use', () => {
    const lockedResult = () => {
      const result = draftResult();
      result.app.system = { en: 'Write for this reading level: {{reading_level}}.' };
      return result;
    };

    it('cannot be removed here, and the notice says where they can', async () => {
      await renderWithDraft(lockedResult());
      expect(inputFieldsBox()).toBeChecked();
      expect(inputFieldsBox()).toBeDisabled();
      expect(screen.getByText(TEXT.draft.fieldsLocked)).toBeVisible();
      expect(inputFieldsBox()).toHaveAccessibleDescription(TEXT.draft.fieldsLocked);
    });

    it('follow the instructions as the author edits them', async () => {
      await renderWithDraft();
      expect(inputFieldsBox()).toBeEnabled();

      type(
        screen.getByLabelText(TEXT.essentials.instructions),
        'Mind the level {{reading_level}}.'
      );
      expect(inputFieldsBox()).toBeDisabled();
      expect(screen.getByText(TEXT.draft.fieldsLocked)).toBeVisible();

      type(screen.getByLabelText(TEXT.essentials.instructions), 'Use plain words.');
      expect(inputFieldsBox()).toBeEnabled();
      expect(screen.queryByText(TEXT.draft.fieldsLocked)).not.toBeInTheDocument();
    });

    it('can be ticked again after they were removed', async () => {
      await renderWithDraft();
      fireEvent.click(inputFieldsBox());
      type(
        screen.getByLabelText(TEXT.essentials.instructions),
        'Mind the level {{reading_level}}.'
      );
      expect(inputFieldsBox()).not.toBeChecked();
      expect(inputFieldsBox()).toBeEnabled();
    });
  });

  describe('what the notice says about the draft', () => {
    it.each([
      ['FIELD_DROPPED', true],
      ['STARTER_DROPPED', true],
      ['TEXT_SHORTENED', true],
      ['CATEGORY_REPLACED', false],
      ['FIELD_ADDED_TO_TEMPLATE', false],
      ['KEY_IGNORED', false],
      ['constructor', false]
    ])('warning %s: "left out" shown is %s', async (code, shown) => {
      await renderWithDraft(draftResult({ warnings: [{ code, field: 'variables' }] }));
      expect(screen.queryAllByText(TEXT.draft.leftOut)).toHaveLength(shown ? 1 : 0);
    });
  });

  describe('"Prepare a new draft"', () => {
    it('sends the edited description without asking while the draft is untouched', async () => {
      const { generate, calls } = await renderWithDraft();
      type(descriptionBox(), '  A stricter assistant.  ');
      fireEvent.click(regenerateButton());

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(generate).toHaveBeenCalledTimes(2);
      expect(calls[1].request).toEqual({
        description: 'A stricter assistant.',
        language: 'en',
        signal: expect.any(AbortSignal)
      });
      expect(screen.getByRole('status')).toHaveTextContent(TEXT.start.generating);

      const next = draftResult();
      next.app.name = { en: 'Strict summary' };
      await settle(() => calls[1].resolve(next));
      expect(screen.getByLabelText(TEXT.essentials.name)).toHaveValue('Strict summary');
      expect(descriptionBox()).toHaveValue('  A stricter assistant.  ');
      // The end is announced as the start was.
      expect(screen.getByRole('status')).toHaveTextContent(TEXT.draft.intro);
    });

    it('asks first when the author changed a field of the draft', async () => {
      const { generate, calls } = await renderWithDraft();
      type(screen.getByLabelText(TEXT.essentials.name), 'My own name');
      fireEvent.click(regenerateButton());

      let dialog = screen.getByRole('alertdialog');
      expect(dialog).toHaveTextContent(TEXT.draft.regenerateWarning);
      expect(generate).toHaveBeenCalledTimes(1);

      fireEvent.click(within(dialog).getByRole('button', { name: en.common.cancel }));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(generate).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText(TEXT.essentials.name)).toHaveValue('My own name');

      fireEvent.click(regenerateButton());
      dialog = screen.getByRole('alertdialog');
      fireEvent.click(within(dialog).getByRole('button', { name: TEXT.draft.regenerate }));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(generate).toHaveBeenCalledTimes(2);
      expect(calls[1].request.description).toBe(DESCRIPTION);

      const next = draftResult();
      next.app.name = { en: 'Second draft' };
      await settle(() => calls[1].resolve(next));
      expect(screen.getByLabelText(TEXT.essentials.name)).toHaveValue('Second draft');
    });

    it('asks before a draft replaces what the author changed while it was prepared', async () => {
      const { generate, calls } = await renderWithDraft();
      // Untouched draft: no question at the click.
      fireEvent.click(regenerateButton());
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(generate).toHaveBeenCalledTimes(2);
      type(screen.getByLabelText(TEXT.essentials.name), 'My corrected name');

      const next = draftResult();
      next.app.name = { en: 'Second draft' };
      await settle(() => calls[1].resolve(next));
      let dialog = screen.getByRole('alertdialog');
      expect(dialog).toHaveTextContent(TEXT.draft.arrived.body);
      expect(screen.getByLabelText(TEXT.essentials.name)).toHaveValue('My corrected name');

      fireEvent.click(within(dialog).getByRole('button', { name: TEXT.draft.arrived.keep }));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(screen.getByLabelText(TEXT.essentials.name)).toHaveValue('My corrected name');

      // The same again, and this time the author takes the new draft.
      fireEvent.click(regenerateButton());
      fireEvent.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: TEXT.draft.regenerate })
      );
      type(screen.getByLabelText(TEXT.essentials.name), 'Another name');
      await settle(() => calls[2].resolve(next));
      dialog = screen.getByRole('alertdialog');
      fireEvent.click(within(dialog).getByRole('button', { name: TEXT.draft.arrived.use }));
      expect(screen.getByLabelText(TEXT.essentials.name)).toHaveValue('Second draft');
    });

    it('a create request cancels the draft request, so no late draft replaces the screen', async () => {
      const { generate, calls } = manualGenerate();
      const onDraft = jest.fn();
      const props = {
        result: draftResult(),
        description: DESCRIPTION,
        onDescriptionChange: () => {},
        onExtrasChange: () => {},
        onDraft,
        generate,
        language: 'en'
      };
      const { rerender } = render(<DraftExtras {...props} />);
      fireEvent.click(regenerateButton());
      expect(calls[0].request.signal.aborted).toBe(false);
      rerender(<DraftExtras {...props} creating />);
      expect(calls[0].request.signal.aborted).toBe(true);
      await settle(() => calls[0].resolve(draftResult()));
      expect(onDraft).not.toHaveBeenCalled();
      // And none is started while the app is being created.
      fireEvent.click(regenerateButton());
      expect(generate).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['a flag', true, true],
      ['a list of fields', ['system'], true],
      ['a set of fields', new Set(['name']), true],
      ['no flag', false, false],
      ['an empty list', [], false],
      ['an empty set', new Set(), false]
    ])('reads "edited" given as %s', (_label, edited, asks) => {
      const generate = jest.fn(() => new Promise(() => {}));
      render(
        <DraftExtras
          result={draftResult()}
          description={DESCRIPTION}
          onDescriptionChange={() => {}}
          extras={NO_EXTRAS}
          onExtrasChange={() => {}}
          onDraft={() => {}}
          generate={generate}
          language="en"
          edited={edited}
        />
      );
      fireEvent.click(regenerateButton());
      expect(screen.queryAllByRole('alertdialog')).toHaveLength(asks ? 1 : 0);
      expect(generate).toHaveBeenCalledTimes(asks ? 0 : 1);
    });

    it('reports an empty description instead of asking', async () => {
      const { generate } = await renderWithDraft();
      type(screen.getByLabelText(TEXT.essentials.name), 'My own name');
      type(descriptionBox(), ' ');
      fireEvent.click(regenerateButton());
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent(TEXT.error.empty);
      expect(generate).toHaveBeenCalledTimes(1);
    });

    it('keeps the draft and names the cause when the new draft fails', async () => {
      const { calls, create } = await renderWithDraft();
      fireEvent.click(webSearchBox());
      fireEvent.click(regenerateButton());
      await settle(() =>
        calls[1].reject(problem('RATE_LIMITED', { details: { limiter: 'appGenerator' } }))
      );

      expect(screen.getByRole('alert').textContent).toBe(TEXT.error.tooManyDrafts);
      expect(descriptionBox()).toHaveValue(DESCRIPTION);
      expect(screen.getByLabelText(TEXT.essentials.name)).toHaveValue('Plain-language summary');
      expect(webSearchBox()).toBeChecked();
      expect(create().websearch).toEqual({ enabled: true });

      fireEvent.click(regenerateButton());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('runs one request at a time, and Cancel drops the late answer', async () => {
      const { generate, calls } = await renderWithDraft();
      fireEvent.click(regenerateButton());
      const busy = screen.getByRole('button', { name: TEXT.start.generating });
      expect(busy).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(busy);
      expect(generate).toHaveBeenCalledTimes(2);

      fireEvent.click(screen.getByRole('button', { name: TEXT.cancel }));
      expect(calls[1].request.signal.aborted).toBe(true);
      expect(regenerateButton()).toHaveFocus();

      const late = draftResult();
      late.app.name = { en: 'Late draft' };
      await settle(() => calls[1].resolve(late));
      expect(screen.getByLabelText(TEXT.essentials.name)).toHaveValue('Plain-language summary');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toBeEmptyDOMElement();
    });
  });

  it('offers "Start over" only when the page handles it', () => {
    const onStartOver = jest.fn();
    const props = {
      result: draftResult(),
      description: DESCRIPTION,
      onDescriptionChange: () => {},
      extras: NO_EXTRAS,
      onExtrasChange: () => {},
      onDraft: () => {},
      generate: jest.fn()
    };
    const { rerender } = render(<DraftExtras {...props} />);
    expect(screen.queryByRole('button', { name: TEXT.startOver })).not.toBeInTheDocument();
    rerender(<DraftExtras {...props} onStartOver={onStartOver} />);
    fireEvent.click(screen.getByRole('button', { name: TEXT.startOver }));
    expect(onStartOver).toHaveBeenCalledTimes(1);
  });

  it('names an input field by its label in the content language, else by its name', () => {
    const result = draftResult();
    result.app.variables = [
      { name: 'tone', label: { en: 'Tone', de: 'Ton' }, type: 'string' },
      { name: 'length', label: 'Length', type: 'string' },
      { name: 'audience', type: 'string' }
    ];
    render(
      <DraftExtras
        result={result}
        description={DESCRIPTION}
        onDescriptionChange={() => {}}
        onExtrasChange={() => {}}
        onDraft={() => {}}
        generate={jest.fn()}
        language="de"
      />
    );
    expect(
      screen.getByRole('checkbox', {
        name: TEXT.draft.inputFields.replace('{{names}}', 'Ton, Length, audience')
      })
    ).toBeChecked();
  });
});
