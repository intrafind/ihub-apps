// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { modelDisplayName, pickDraftModel } from './createFlow';
import DescribeStart from './DescribeStart';
import NoModelNotice from './NoModelNotice';

/**
 * What stands at the top of the Start screen: the description box, or the
 * reason there is none.
 *
 * - Drafting is switched off on the installation: one line says so.
 * - No model can prepare a draft: the notice says so before the first click,
 *   and the other starts stay usable.
 * - Otherwise the description box, which names the model the description is
 *   sent to.
 *
 * While the models are loading, nothing is shown: a box that turns into a
 * notice a moment later would be worse than a short gap.
 *
 * @param {object} props
 * @param {object} [props.source] - What the create page offers; handed on to the description box.
 * @param {boolean} props.enabled - Whether drafting with AI is switched on.
 * @param {object[]|null|undefined} props.models - The models the author may
 *   use; `undefined` while loading, `null` when the list could not be loaded.
 * @param {string} [props.configuredModelId] - The draft model an administrator
 *   chose (`platformConfig.appGenerator.modelId`); empty for the automatic choice.
 * @param {string|null} [props.modelSetupHref] - Where a model is set up, for
 *   someone who may open that page.
 * @param {string} props.language - The content language of a draft.
 * @param {string} props.description
 * @param {(text: string) => void} props.onDescriptionChange
 * @param {(result: object, description: string) => void} props.onDraft
 * @param {(request: object) => Promise<object>} props.generate - The draft request.
 * @returns {JSX.Element|null}
 */
function DescribeSlot({
  source,
  enabled,
  models,
  configuredModelId = '',
  modelSetupHref = null,
  language,
  description,
  onDescriptionChange,
  onDraft,
  generate
}) {
  const { t } = useTranslation();
  if (!enabled) {
    return (
      <p className="text-sm text-gray-700 dark:text-gray-300">
        {t('admin.apps.create.generatorOff')}
      </p>
    );
  }
  if (models === undefined) return null;
  const model = pickDraftModel(models, configuredModelId);
  // A list that could not be loaded says nothing about the models: the box
  // stays, and the draft request answers for itself.
  if (Array.isArray(models) && !model) return <NoModelNotice setupHref={modelSetupHref} />;
  return (
    <DescribeStart
      source={source}
      description={description}
      onDescriptionChange={onDescriptionChange}
      onDraft={onDraft}
      generate={generate}
      language={language}
      modelName={modelDisplayName(model, language)}
    />
  );
}

export default DescribeSlot;
