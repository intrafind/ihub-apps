// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  INPUT_CLASS,
  PRIMARY_BUTTON_CLASS,
  RADIO_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../formStyles';
import { REVISE_AUTHOR_TEXT_MAX } from '../../../../../../shared/appRevision.js';

/** The value of the "Something else" radio; a choice text can never be it. */
const OTHER = '\u0000other';

/**
 * The builder's question (plan 3.1): its wording as the legend of a radio
 * group, one radio per choice, "Something else" with a text field when the
 * builder allows it, and "Skip". Answering sends the chosen text as the
 * author's next message.
 *
 * Only the newest entry is `interactive`; an older question shows its wording
 * without controls.
 *
 * @param {object} props
 * @param {{ text: string, choices: string[], allowOther: boolean }} props.question
 * @param {boolean} props.interactive
 * @param {(answer: string) => void} props.onAnswer
 * @param {() => void} props.onSkip
 * @returns {JSX.Element}
 */
function QuestionCard({ question, interactive, onAnswer, onSkip }) {
  const { t } = useTranslation();
  const baseId = useId();
  const [picked, setPicked] = useState(null);
  const [other, setOther] = useState('');
  const choices = question.choices || [];
  const freeOnly = choices.length === 0;
  const allowOther = question.allowOther !== false || freeOnly;
  const answer = picked === OTHER || freeOnly ? other.trim() : picked;
  const legendId = `${baseId}-legend`;
  const otherId = `${baseId}-other`;

  if (!interactive) {
    return <p className="text-sm text-gray-900 dark:text-gray-100">{question.text}</p>;
  }

  const submit = event => {
    event.preventDefault();
    if (answer) onAnswer(answer);
  };

  return (
    <form onSubmit={submit} className="space-y-2">
      <fieldset>
        <legend id={legendId} className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {question.text}
        </legend>
        {!freeOnly && (
          <div role="radiogroup" aria-labelledby={legendId} className="mt-2 space-y-1">
            {choices.map(choice => (
              <label
                key={choice}
                className="flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200"
              >
                <input
                  type="radio"
                  name={`${baseId}-choice`}
                  className={`${RADIO_CLASS} mt-0.5`}
                  checked={picked === choice}
                  onChange={() => setPicked(choice)}
                />
                {choice}
              </label>
            ))}
            {allowOther && (
              <label className="flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200">
                <input
                  type="radio"
                  name={`${baseId}-choice`}
                  className={`${RADIO_CLASS} mt-0.5`}
                  checked={picked === OTHER}
                  onChange={() => setPicked(OTHER)}
                />
                {t('admin.apps.conversation.question.other')}
              </label>
            )}
          </div>
        )}
        {allowOther && (freeOnly || picked === OTHER) && (
          <div className="mt-2">
            <label htmlFor={otherId} className="sr-only">
              {t('admin.apps.conversation.question.otherLabel')}
            </label>
            <input
              id={otherId}
              type="text"
              className={INPUT_CLASS}
              value={other}
              maxLength={REVISE_AUTHOR_TEXT_MAX}
              placeholder={t('admin.apps.conversation.question.otherLabel')}
              onChange={event => setOther(event.target.value)}
            />
          </div>
        )}
      </fieldset>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={SECONDARY_BUTTON_CLASS} onClick={onSkip}>
          {t('admin.apps.conversation.question.skip')}
        </button>
        <button type="submit" className={PRIMARY_BUTTON_CLASS} disabled={!answer}>
          {t('admin.apps.conversation.question.answer')}
        </button>
      </div>
    </form>
  );
}

export default QuestionCard;
