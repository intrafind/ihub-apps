// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../../utils/localizeContent';
import { CALLOUT_CLASS } from '../formStyles';
import AppPickCard from './AppPickCard';
import { CARD_GRID_CLASS, LINK_BUTTON_CLASS } from './createStyles';

/**
 * The templates a new app can start from, as cards. The list comes from the
 * caller's `fetchTemplates`; the component makes no request of its own. When
 * the list cannot be loaded, the row says so and offers to try again, and the
 * rest of the screen keeps working.
 *
 * `trailing` is one more card after the templates ("Copy an existing app"),
 * as a list item. It shows while the templates load and when they cannot be
 * loaded. When there are no templates it stands in its own grid with no
 * Templates heading, since it is not a template. All cards of the grid have
 * the same size.
 *
 * @param {object} props
 * @param {() => Promise<Array<{ id: string, name: object, description?: object, icon?: string,
 *   color?: string, hasInputFields?: boolean }>>} props.fetchTemplates
 * @param {string} props.language - The language of names and descriptions.
 * @param {(template: object) => void} props.onPick
 * @param {React.ReactNode} [props.trailing] - A card after the templates, as an `<li>`.
 * @returns {JSX.Element|null}
 */
function TemplateGallery({ fetchTemplates, language, onPick, trailing = null }) {
  const { t } = useTranslation();
  const headingId = useId();
  const [templates, setTemplates] = useState(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    fetchTemplates()
      .then(items => {
        if (!current) return;
        setTemplates(Array.isArray(items) ? items : []);
        setFailed(false);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [fetchTemplates, attempt]);

  const retry = useCallback(() => {
    setFailed(false);
    setAttempt(count => count + 1);
  }, []);

  // An installation without templates shows no empty heading; the trailing
  // card, which is not a template, then stands alone without one.
  if (!failed && templates && templates.length === 0) {
    return trailing ? <ul className={CARD_GRID_CLASS}>{trailing}</ul> : null;
  }

  const cards = (templates || []).map(template => (
    <li key={template.id} className="flex">
      <AppPickCard
        name={getLocalizedContent(template.name, language) || template.id}
        description={getLocalizedContent(template.description, language)}
        icon={template.icon}
        color={template.color}
        badge={template.hasInputFields ? t('admin.apps.create.start.badge.inputFields') : null}
        onPick={() => onPick(template)}
      />
    </li>
  ));

  return (
    <section aria-labelledby={headingId} aria-busy={!failed && !templates ? 'true' : undefined}>
      <h2 id={headingId} className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        {t('admin.apps.create.start.templates.heading')}
      </h2>
      {failed && (
        <p role="alert" className={`mt-2 ${CALLOUT_CLASS.warning}`}>
          {t('admin.apps.create.start.templates.loadError')}{' '}
          <button type="button" className={LINK_BUTTON_CLASS} onClick={retry}>
            {t('admin.apps.create.retry')}
          </button>
        </p>
      )}
      {(!failed || trailing) && (
        <ul className={`mt-2 ${CARD_GRID_CLASS}`}>
          {!failed && cards}
          {trailing}
        </ul>
      )}
    </section>
  );
}

export default TemplateGallery;
