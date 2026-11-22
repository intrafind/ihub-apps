// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { CALLOUT_CLASS } from '../formStyles';
import { NOTE_KEYS } from './createKeys';
import { LINK_BUTTON_CLASS } from './createStyles';
import DraftExtras from './DraftExtras';

/**
 * What the page says above its screens: that a draft came back after a
 * reload (either screen), and that the app to copy is gone or could not be
 * loaded (Start screen only, where the author can still choose a start).
 *
 * @param {object} props
 * @param {object} props.state - The page's state (`useAppDraft`).
 * @param {{ status: string, retry: () => void }} props.copy - The copy source (`useCopySource`).
 * @param {() => void} props.onStartOver
 * @returns {JSX.Element|null}
 */
function CreateNotices({ state, copy, onStartOver }) {
  const { t } = useTranslation();
  const copyProblem =
    state.screen === 'start' && (copy.status === 'gone' || copy.status === 'failed')
      ? copy.status
      : null;
  if (!state.restored && !copyProblem) return null;
  return (
    <div className="mb-6 space-y-3">
      {state.restored && (
        <p role="status" className={CALLOUT_CLASS.info}>
          {t('admin.apps.create.restored')}{' '}
          <button type="button" className={LINK_BUTTON_CLASS} onClick={onStartOver}>
            {t('admin.apps.create.startOver')}
          </button>
        </p>
      )}
      {copyProblem === 'gone' && (
        <p role="alert" className={CALLOUT_CLASS.warning}>
          {t('admin.apps.create.copy.sourceGone')}
        </p>
      )}
      {copyProblem === 'failed' && (
        <p role="alert" className={CALLOUT_CLASS.warning}>
          {t('admin.apps.create.copy.loadError')}{' '}
          <button type="button" className={LINK_BUTTON_CLASS} onClick={copy.retry}>
            {t('admin.apps.create.retry')}
          </button>
        </p>
      )}
    </div>
  );
}

/**
 * The notice at the top of the Essentials screen, by start: the draft notice
 * of an AI draft, "Started from the template …", or "Copied from …". An empty
 * start and a link app have no notice.
 *
 * @param {object} props
 * @param {object} [props.source] - What the create page offers; handed on to the draft notice.
 * @param {object} props.state - The page's state (`useAppDraft`).
 * @param {string} props.language - The content language of a new draft.
 * @param {(request: object) => Promise<object>} props.generate - The draft request.
 * @param {(text: string) => void} props.onDescriptionChange
 * @param {(extras: object) => void} props.onExtrasChange
 * @param {(result: object, description: string) => void} props.onDraft
 * @param {boolean} [props.creating] - The create request runs.
 * @param {() => void} props.onStartOver
 * @returns {JSX.Element|null}
 */
export function EssentialsNotice({
  source,
  state,
  language,
  generate,
  onDescriptionChange,
  onExtrasChange,
  onDraft,
  creating,
  onStartOver
}) {
  const { t } = useTranslation();
  if (state.start === 'generated' && state.generated) {
    return (
      <DraftExtras
        source={source}
        result={state.generated}
        draft={state.draft}
        description={state.description}
        onDescriptionChange={onDescriptionChange}
        extras={state.extras}
        onExtrasChange={onExtrasChange}
        onDraft={onDraft}
        generate={generate}
        language={language}
        edited={state.edited}
        creating={creating}
        onStartOver={onStartOver}
      />
    );
  }
  const noteKey = NOTE_KEYS[state.start];
  if (!noteKey) return null;
  return <p className={CALLOUT_CLASS.info}>{t(noteKey, { name: state.source?.name ?? '' })}</p>;
}

export default CreateNotices;
