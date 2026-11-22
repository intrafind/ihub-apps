// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createContext, use } from 'react';
import DynamicLanguageEditor from '../../../../shared/components/DynamicLanguageEditor';

/**
 * The language the texts of the app in the form are written in first
 * (`primaryLanguageOf(app, uiLanguage)`). The form sets it once; the sections
 * read it, so that a text with one language shows one input without a
 * language code. Outside the form there is none, and the sections behave as
 * the language component does by default.
 */
const AppFormLanguageContext = createContext(undefined);

export const AppFormLanguageProvider = AppFormLanguageContext.Provider;

/**
 * The language a new text of the app is written in, or `undefined` outside
 * the app form.
 *
 * @returns {string|undefined}
 */
export function useAppFormLanguage() {
  return use(AppFormLanguageContext);
}

/**
 * Whether the texts of the form offer the machine translation. It calls an
 * admin route, so a form that people without admin rights use (the editor of
 * a personal app) sets false. Outside a provider the button is offered.
 */
const AppFormTranslateContext = createContext(true);

export const AppFormTranslateProvider = AppFormTranslateContext.Provider;

/**
 * A text of the app in its languages: `DynamicLanguageEditor` in the
 * one-language mode of the form it is rendered in.
 *
 * @param {object} props - The props of `DynamicLanguageEditor`.
 * @returns {JSX.Element}
 */
function AppLanguageField(props) {
  const primaryLanguage = useAppFormLanguage();
  const translate = use(AppFormTranslateContext);
  return (
    <DynamicLanguageEditor primaryLanguage={primaryLanguage} translate={translate} {...props} />
  );
}

export default AppLanguageField;
