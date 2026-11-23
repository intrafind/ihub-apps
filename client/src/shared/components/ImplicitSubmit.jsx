// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The submit button of a form whose visible Save is the bottom save bar, outside the form.
 *
 * A browser submits a form on Enter in a field only when the form has a submit button (or
 * a single text field). The save bar's Save is not inside the form, so without this the
 * Enter key would stop saving. Put it first in the form: it is then the default button.
 *
 * It is not seen, not announced and not reachable with Tab; the bar's Save stays the
 * button of the page. It is disabled while a save runs, so Enter cannot save twice.
 *
 * @param {Object} props
 * @param {boolean} [props.disabled=false] - A save is running
 * @returns {JSX.Element}
 *
 * @example
 * <form onSubmit={handleSubmit}>
 *   <ImplicitSubmit disabled={saving} />
 *   …fields…
 * </form>
 */
export default function ImplicitSubmit({ disabled = false }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      tabIndex={-1}
      aria-hidden="true"
      className="sr-only"
      data-testid="implicit-submit"
    />
  );
}
