// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useMemo } from 'react';
import useFeatureFlags from '../../../../shared/hooks/useFeatureFlags';

/** The preview feature of the conversation; off unless an admin switched it on. */
export const APP_BUILDER_CHAT_FEATURE = 'appBuilderChat';

/** The query parameter of the editor's view: `?view=conversation`. */
export const VIEW_PARAM = 'view';
/** The value of {@link VIEW_PARAM} that shows the conversation in place of the form. */
export const CONVERSATION_VIEW = 'conversation';

/**
 * The query of the editor's URL after a create: `?created=1`, and after a
 * create from a description, with the conversation switched on,
 * `?created=1&view=conversation` (owner decision 4 of the chat builder plan).
 *
 * @param {string|undefined} origin - How the app was started (`generated`, `blank`, …).
 * @param {{ isEnabled: (id: string, fallback: boolean) => boolean }} flags - `FeatureFlags`.
 * @returns {string}
 */
export function arrivalQuery(origin, flags) {
  const conversation =
    origin === 'generated' &&
    flags.isEnabled('appGenerator', true) &&
    flags.isEnabled(APP_BUILDER_CHAT_FEATURE, false);
  return conversation ? `?created=1&${VIEW_PARAM}=${CONVERSATION_VIEW}` : '?created=1';
}

/**
 * The platform's feature switches, read as the client reads `appGenerator`
 * (`useFeatureFlags().isEnabled`).
 *
 * The conversation needs `appBuilderChat` (preview, default off). The admin
 * editor also needs `appGenerator` (default on). The personal pages read it
 * from `GET /api/apps/_config`: the create page from `generator` (create
 * rights), the editor from `generatorEnabled` together with the caller's
 * edit rights on the app (`offersAiChanges` in `userAppForm.js`).
 *
 * @returns {{ chat: boolean, generator: boolean }}
 */
export function useAppBuilderFeatures() {
  const flags = useFeatureFlags();
  return useMemo(
    () => ({
      chat: flags.isEnabled(APP_BUILDER_CHAT_FEATURE, false),
      generator: flags.isEnabled('appGenerator', true)
    }),
    [flags]
  );
}

export default useAppBuilderFeatures;
