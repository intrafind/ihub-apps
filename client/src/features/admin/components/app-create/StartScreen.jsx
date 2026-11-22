// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { HELP_CLASS, SECONDARY_BUTTON_CLASS } from '../formStyles';
import { CARD_GRID_CLASS, DISCLOSURE_BUTTON_CLASS, LINK_BUTTON_CLASS } from './createStyles';
import AppPickCard from './AppPickCard';
import ExistingAppPicker from './ExistingAppPicker';
import TemplateGallery from './TemplateGallery';

/** The colour of the "Copy an existing app" card: a quiet grey beside the templates' colours. */
const COPY_CARD_COLOR = '#475569';

/**
 * Screen 1 of "New app": the ways to start.
 *
 * It shows what a newcomer needs and nothing else: the description box (the
 * caller's `describe` slot), the templates with "Copy an existing app" as the
 * last card, and "Start empty". The two starts few people need sit under one
 * collapsed line, "Other ways to start": create a link app, and the
 * Marketplace.
 *
 * The screen makes no request of its own and names no path: the lists come
 * from the caller's functions, and the Marketplace link is shown only when
 * the caller hands over where it leads.
 *
 * @param {object} props
 * @param {object} [props.source] - What the create page offers (section 11.3 of the
 *   personal apps plan). `source.starts` says which starts are shown; without a
 *   source every start is.
 * @param {React.ReactNode} props.describe - The description box, or what
 *   stands in its place (no model, drafting switched off).
 * @param {() => Promise<object[]>} props.fetchTemplates - The templates.
 * @param {() => Promise<object[]>} props.fetchExistingApps - The apps that can be copied.
 * @param {string} props.language - The language of names and descriptions.
 * @param {(template: object) => void} props.onPickTemplate
 * @param {() => void} props.onStartBlank
 * @param {(app: object) => void} props.onPickExisting
 * @param {() => void} props.onStartLink
 * @param {string|null} [props.marketplaceHref] - Where the Marketplace is, for
 *   someone who may open it.
 * @returns {JSX.Element}
 */
function StartScreen({
  source,
  describe,
  fetchTemplates,
  fetchExistingApps,
  language,
  onPickTemplate,
  onStartBlank,
  onPickExisting,
  onStartLink,
  marketplaceHref = null
}) {
  const { t } = useTranslation();
  const otherId = useId();
  const [otherOpen, setOtherOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const offers = start => source?.starts?.[start] !== false;
  const showMarketplace = offers('marketplace') && Boolean(marketplaceHref);
  const otherStarts = offers('link') || showMarketplace;
  // The card that opens the copy dialog; the dialog gives the focus back to it when it closes.
  const copyCard = offers('copy') ? (
    <li className="flex">
      <AppPickCard
        name={t('admin.apps.create.start.copy')}
        description={t('admin.apps.create.start.copyHelp')}
        icon="document-duplicate"
        color={COPY_CARD_COLOR}
        onPick={() => setPickerOpen(true)}
      />
    </li>
  ) : null;

  return (
    <div className="space-y-6">
      {describe}

      <p className="flex items-center gap-3 text-sm text-gray-600 dark:text-gray-400">
        <span className="h-px flex-1 bg-gray-200 dark:bg-gray-700" aria-hidden="true" />
        {t('admin.apps.create.start.or')}
        <span className="h-px flex-1 bg-gray-200 dark:bg-gray-700" aria-hidden="true" />
      </p>

      {offers('templates') ? (
        <TemplateGallery
          fetchTemplates={fetchTemplates}
          language={language}
          onPick={onPickTemplate}
          trailing={copyCard}
        />
      ) : (
        copyCard && <ul className={CARD_GRID_CLASS}>{copyCard}</ul>
      )}

      {offers('empty') && (
        <div>
          <button
            type="button"
            className={`${SECONDARY_BUTTON_CLASS} w-full sm:w-auto`}
            onClick={onStartBlank}
          >
            {t('admin.apps.create.start.blank')}
          </button>
        </div>
      )}

      {otherStarts && (
        <div>
          <button
            type="button"
            className={DISCLOSURE_BUTTON_CLASS}
            aria-expanded={otherOpen}
            aria-controls={otherId}
            onClick={() => setOtherOpen(open => !open)}
          >
            <Icon
              name={otherOpen ? 'chevron-down' : 'chevron-right'}
              size="sm"
              aria-hidden="true"
            />
            {t('admin.apps.create.start.other')}
          </button>
          <div id={otherId}>
            {otherOpen && (
              <ul className="mt-3 space-y-3 pl-5">
                {offers('link') && (
                  <li>
                    <button type="button" className={LINK_BUTTON_CLASS} onClick={onStartLink}>
                      {t('admin.apps.create.start.link.action')}
                    </button>
                    <p className={HELP_CLASS}>{t('admin.apps.create.start.link.help')}</p>
                  </li>
                )}
                {showMarketplace && (
                  <li>
                    <Link to={marketplaceHref} className={LINK_BUTTON_CLASS}>
                      {t('admin.apps.create.start.marketplace')}
                    </Link>
                  </li>
                )}
              </ul>
            )}
          </div>
        </div>
      )}

      {offers('copy') && (
        <ExistingAppPicker
          isOpen={pickerOpen}
          onClose={() => setPickerOpen(false)}
          fetchApps={fetchExistingApps}
          language={language}
          onPick={app => {
            setPickerOpen(false);
            onPickExisting(app);
          }}
        />
      )}
    </div>
  );
}

export default StartScreen;
