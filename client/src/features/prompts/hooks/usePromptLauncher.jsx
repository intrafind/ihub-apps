import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import PromptVariablesDialog from '../components/PromptVariablesDialog';
import { loadAutoVariables } from '../utils/autoVariables';
import { buildVariableFields, fillPromptVariables } from '../../../../../shared/promptVariables.js';

/**
 * Use a prompt: ask for its variables when it has any, then hand back the
 * final text. Nothing is ever sent — the caller puts the text into a chat
 * input (or on the clipboard), where the user can still change it.
 *
 * @returns {{launch: (prompt: Object, options?: Object) => Promise<null|{text: string,
 *   caret: number|null, appVariables: Object}>, dialog: JSX.Element|null}}
 *   `launch` resolves to null when the user cancelled. `appVariables` are the
 *   values of declared variables the text does not use, which the library
 *   passes to the prompt's app as `var_*` parameters.
 */
export default function usePromptLauncher() {
  const { i18n } = useTranslation();
  const [request, setRequest] = useState(null);

  const launch = useCallback(
    async (prompt, { includeAppVariables = false, submitLabel } = {}) => {
      const text = getLocalizedContent(prompt?.prompt, i18n.language) || '';
      const auto = await loadAutoVariables(i18n.language);
      const fields = buildVariableFields(text, prompt?.variables, {
        autoNames: auto.autoNames,
        includeUnused: includeAppVariables && Boolean(prompt?.appId)
      });
      if (fields.length === 0) {
        return { ...fillPromptVariables(text, {}, { autoValues: auto.values }), appVariables: {} };
      }
      return new Promise(resolve => {
        setRequest({ prompt, text, fields, autoValues: auto.values, submitLabel, resolve });
      });
    },
    [i18n.language]
  );

  const close = () => {
    request?.resolve(null);
    setRequest(null);
  };

  const submit = values => {
    const inText = {};
    const appVariables = {};
    for (const field of request.fields) {
      if (field.inText) inText[field.name] = values[field.name];
      else appVariables[field.name] = values[field.name];
    }
    const filled = fillPromptVariables(request.text, inText, { autoValues: request.autoValues });
    request.resolve({ ...filled, appVariables });
    setRequest(null);
  };

  const dialog = request ? (
    <PromptVariablesDialog
      prompt={request.prompt}
      text={request.text}
      fields={request.fields}
      autoValues={request.autoValues}
      submitLabel={request.submitLabel}
      onSubmit={submit}
      onClose={close}
    />
  ) : null;

  return { launch, dialog };
}
