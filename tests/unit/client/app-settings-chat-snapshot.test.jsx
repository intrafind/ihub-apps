import { renderHook, act, waitFor } from '@testing-library/react';

jest.mock('../../../client/src/api', () => ({
  fetchModels: jest.fn(),
  fetchStyles: jest.fn()
}));
jest.mock('../../../client/src/shared/contexts/UIConfigContext', () => ({
  useUIConfig: jest.fn()
}));

import { fetchModels, fetchStyles } from '../../../client/src/api';
import { useUIConfig } from '../../../client/src/shared/contexts/UIConfigContext';
import useAppSettings from '../../../client/src/shared/hooks/useAppSettings';

/**
 * A stored chat's settings are a snapshot, frozen when the chat was hydrated.
 * They are the last of three layers `useAppSettings` applies, which is what
 * makes reopening a chat come back with the tools it was answered with — and
 * is also what made them win forever. The effect that applies them re-runs on
 * the identity of `app`, and `AppChat` refetches the app whenever the
 * interface language changes, so a re-run replayed a snapshot from before the
 * user had touched anything on top of what they had since chosen.
 */

const MODELS = [
  { id: 'model-a', name: 'A' },
  { id: 'model-b', name: 'B' }
];

/** A fresh app object each call — what a refetch hands back. */
const makeApp = (overrides = {}) => ({
  id: 'acme',
  color: '#123456',
  websearch: { enabledByDefault: true },
  ...overrides
});

beforeEach(() => {
  sessionStorage.clear();
  fetchModels.mockReset().mockResolvedValue(MODELS);
  fetchStyles.mockReset().mockResolvedValue([]);
  useUIConfig.mockReturnValue({ setHeaderColor: jest.fn() });
});

/**
 * Render the hook and settle it, in the order the real surface does it: the
 * models request resolves first, and the app arrives after. Handing the app
 * over while `modelsLoading` is still true skips initialization but still runs
 * the save effect, which writes the untouched `useState` defaults to
 * sessionStorage — and the browser layer then overrides the app's own defaults
 * with them.
 */
async function settled(initialProps) {
  const rendered = renderHook(
    ({ appId = 'acme', app, chatSettings }) => useAppSettings(appId, app, { chatSettings }),
    { initialProps: { ...initialProps, app: null } }
  );
  await waitFor(() => expect(rendered.result.current.modelsLoading).toBe(false));
  await act(async () => {
    rendered.rerender(initialProps);
  });
  return rendered;
}

test("a chat's stored settings are applied when they arrive", async () => {
  const app = makeApp({ websearch: { enabledByDefault: false } });
  const { result, rerender } = await settled({ app, chatSettings: null });
  expect(result.current.websearchEnabled).toBe(false);

  // Hydration completes and hands the chat's own settings over.
  await act(async () => {
    rerender({ app, chatSettings: { websearchEnabled: true } });
  });
  expect(result.current.websearchEnabled).toBe(true);
});

test('leaving a chat stops its snapshot applying, rather than the app default returning', async () => {
  const app = makeApp({ websearch: { enabledByDefault: false } });
  const { result, rerender } = await settled({
    app,
    chatSettings: { websearchEnabled: true }
  });
  expect(result.current.websearchEnabled).toBe(true);

  // `AppChat` drops the previous chat's snapshot the moment the chat changes,
  // rather than waiting for the next one's document to arrive. What the chat
  // falls back to is the *browser* layer, not the app's default: the save
  // effect has written every setting to sessionStorage by now, so the value
  // the user was last answered with is still what a fresh chat starts from.
  await act(async () => {
    rerender({ app, chatSettings: null });
  });
  expect(result.current.websearchEnabled).toBe(true);

  // The point of the reset: the chat that was left no longer has a say. Turn
  // the toggle off here and refetch the app, and nothing replays the old
  // chat's `true` over it.
  act(() => {
    result.current.setWebsearchEnabled(false);
  });
  await act(async () => {
    rerender({ app: makeApp({ websearch: { enabledByDefault: false } }), chatSettings: null });
  });
  expect(result.current.websearchEnabled).toBe(false);
});

test('a toggle the user changed survives the app being refetched', async () => {
  // The regression: the interface language changes, `AppChat` refetches the
  // app, and the effect re-runs on the new object. It used to replay the
  // chat's frozen snapshot over the user's choice.
  const { result, rerender } = await settled({
    app: makeApp(),
    chatSettings: { websearchEnabled: true }
  });
  expect(result.current.websearchEnabled).toBe(true);

  act(() => {
    result.current.setWebsearchEnabled(false);
  });
  expect(result.current.websearchEnabled).toBe(false);

  await act(async () => {
    rerender({ app: makeApp(), chatSettings: { websearchEnabled: true } });
  });
  expect(result.current.websearchEnabled).toBe(false);
});

test('re-reading the same chat does not replay its snapshot either', async () => {
  // Toggling incognito off and on re-hydrates the same chat, so an equal
  // snapshot arrives under a new object identity.
  const app = makeApp();
  const { result, rerender } = await settled({
    app,
    chatSettings: { temperature: 0.2 }
  });
  expect(result.current.temperature).toBe(0.2);

  act(() => {
    result.current.setTemperature(1.1);
  });

  await act(async () => {
    rerender({ app, chatSettings: { temperature: 0.2 } });
  });
  expect(result.current.temperature).toBe(1.1);
});

test('following a link to another app waits for that app, rather than initializing on the old one', async () => {
  // The route changes a render before the fetch resolves, so `appId` names the
  // new app while `app` is still the old one. Initializing in that gap resolved
  // the new app's saved settings against the old app's config — and, worse,
  // marked the app as initialized, so the real one never applied its own
  // defaults when it arrived.
  const acme = makeApp({ id: 'acme', websearch: { enabledByDefault: true } });
  const beta = makeApp({ id: 'beta', websearch: { enabledByDefault: false } });

  const { result, rerender } = await settled({ appId: 'acme', app: acme, chatSettings: null });
  expect(result.current.websearchEnabled).toBe(true);

  await act(async () => {
    rerender({ appId: 'beta', app: acme, chatSettings: null });
  });
  await act(async () => {
    rerender({ appId: 'beta', app: beta, chatSettings: null });
  });

  expect(result.current.websearchEnabled).toBe(false);
});
