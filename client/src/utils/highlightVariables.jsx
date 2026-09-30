/**
 * Render a prompt text with its `{{variable}}` placeholders highlighted — the
 * one placeholder syntax the prompt library uses.
 *
 * @param {string} text - Prompt text.
 * @returns {JSX.Element[]}
 */
export const highlightVariables = text =>
  String(text ?? '')
    .split(/(\{\{[a-zA-Z_][a-zA-Z0-9_-]*\}\})/g)
    .map((part, idx) =>
      /^\{\{[a-zA-Z_][a-zA-Z0-9_-]*\}\}$/.test(part) ? (
        <span key={idx} className="text-indigo-600 dark:text-indigo-400 font-semibold">
          {part}
        </span>
      ) : (
        <span key={idx}>{part}</span>
      )
    );
