// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The asterisk after the label of a required field. Hidden from screen
 * readers: the control itself carries `required` / `aria-required`.
 *
 * Exactly one per label: a label text passed to a component that adds its own
 * mark (`DynamicLanguageEditor` with `required`) must not contain one.
 *
 * @returns {JSX.Element}
 */
function RequiredMark() {
  return (
    <span className="text-red-500 ml-1" aria-hidden="true">
      *
    </span>
  );
}

export default RequiredMark;
