import { useEffect, useRef, useState } from 'react';

/**
 * Editor for a config value that is an object or array rather than a scalar.
 *
 * Binding such a value straight to a text input renders "[object Object]" and
 * the first keystroke replaces the structure with a string. This keeps the
 * text the user is typing in local state, parses it on every change, and only
 * writes back once it parses — so a half-typed edit never corrupts the config.
 *
 * @param {object} props
 * @param {string} props.label - Field label
 * @param {object|Array|undefined} props.value - Current parsed value
 * @param {function} props.onChange - Receives the parsed value, or undefined when cleared
 * @param {string} [props.placeholder] - Textarea placeholder
 * @param {string} [props.helpText] - Hint shown under the field
 * @param {number} [props.rows=6] - Textarea height
 * @param {'object'|'array'} [props.expect] - Reject a parsed value of the wrong shape
 */
function JsonField({ label, value, onChange, placeholder, helpText, rows = 6, expect }) {
  const serialize = v => {
    if (v === undefined || v === null) return '';
    if (typeof v === 'string') return v;
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return '';
    }
  };

  const [text, setText] = useState(() => serialize(value));
  const [error, setError] = useState(null);
  // Only re-seed the textarea when the value changes from the outside (a
  // different node selected), never while the user is mid-edit.
  const lastEmitted = useRef(serialize(value));

  useEffect(() => {
    const incoming = serialize(value);
    if (incoming !== lastEmitted.current) {
      setText(incoming);
      lastEmitted.current = incoming;
      setError(null);
    }
  }, [value]);

  const handleChange = next => {
    setText(next);
    if (!next.trim()) {
      setError(null);
      lastEmitted.current = '';
      onChange(undefined);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(next);
    } catch (err) {
      setError(err.message);
      return;
    }
    if (
      expect === 'object' &&
      (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    ) {
      setError('Expected a JSON object, e.g. { "key": "value" }');
      return;
    }
    if (expect === 'array' && !Array.isArray(parsed)) {
      setError('Expected a JSON array, e.g. ["one", "two"]');
      return;
    }
    setError(null);
    lastEmitted.current = serialize(parsed);
    onChange(parsed);
  };

  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
        {label}
      </label>
      <textarea
        value={text}
        onChange={e => handleChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        spellCheck={false}
        className={`w-full text-sm font-mono border rounded px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 ${
          error ? 'border-red-400 dark:border-red-600' : 'border-gray-300 dark:border-gray-600'
        }`}
      />
      {error ? (
        <p className="text-xs text-red-500 mt-0.5">{error} — the last valid value is kept.</p>
      ) : (
        helpText && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{helpText}</p>
      )}
    </div>
  );
}

export default JsonField;
