import { createContext, useContext } from 'react';

/**
 * Lightweight context that lets descendants (e.g. `DynamicLanguageEditor`) read
 * the form-level validation errors without each call site having to forward
 * them as props.
 *
 * Provider value: `{ [fieldId: string]: string }` — same shape used by
 * `AdminFormErrorSummary`. Field IDs may be dot-paths (`description.en`).
 */
const FormValidationContext = createContext(null);

export function FormValidationProvider({ errors, children }) {
  return <FormValidationContext.Provider value={errors}>{children}</FormValidationContext.Provider>;
}

export function useFormValidationErrors() {
  return useContext(FormValidationContext);
}
