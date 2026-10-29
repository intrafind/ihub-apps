// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * One titled card of the people directory editor (Source, Access, Network, …).
 * The heading names the section for screen readers through `aria-labelledby`,
 * so the sections are landmarks a keyboard user can jump between.
 *
 * @param {Object} props
 * @param {string} props.id - Base id; the heading gets `${id}-title`
 * @param {string} props.title - Section heading
 * @param {string} [props.description] - One or two sentences under the heading
 * @param {React.ReactNode} props.children - Section content
 */
function FormSection({ id, title, description, children }) {
  const titleId = `${id}-title`;
  return (
    <section
      aria-labelledby={titleId}
      className="bg-white dark:bg-gray-800 shadow-xs border border-gray-200 dark:border-gray-700 rounded-lg p-6"
    >
      <h2 id={titleId} className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        {title}
      </h2>
      {description && (
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{description}</p>
      )}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

export default FormSection;
