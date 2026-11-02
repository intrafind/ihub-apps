// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId } from 'react';

/**
 * Track, thumb and "on" offset per size. The track carries a 2px transparent
 * border, so the thumb travels exactly the inner width minus its own width.
 */
const SIZES = {
  sm: { track: 'h-5 w-9', thumb: 'h-4 w-4', on: 'translate-x-4' },
  md: { track: 'h-6 w-11', thumb: 'h-5 w-5', on: 'translate-x-5' }
};

/**
 * Switch — the one on/off control of the client (WAI-ARIA "switch" pattern).
 *
 * Renders a native `<button role="switch" aria-checked>`, so Space and Enter
 * toggle it, it is in the tab order, and it is disabled by `disabled` or by an
 * enclosing `<fieldset disabled>` without extra code.
 *
 * Every switch needs an accessible name. Give it one of:
 *   - `label`: a visible label rendered by the switch itself (a `<label>` that
 *     also toggles the switch on click), optionally with a `description`;
 *   - `aria-labelledby`: the id of a visible label the screen renders itself
 *     (pair it with `<label htmlFor={id}>` when that label is a `<label>`);
 *   - `aria-label`: when there is no visible label at all (a switch in a table
 *     row whose name is the row's title, for example).
 *
 * Any other prop (`data-testid`, `title`, `name`, `onBlur`, …) is passed to
 * the button. `role`, `aria-checked`, `type` and `onClick` cannot be
 * overridden.
 *
 * @param {Object} props
 * @param {boolean} props.checked - Whether the switch is on.
 * @param {(nextChecked: boolean, event: React.MouseEvent<HTMLButtonElement>) => void} props.onChange
 *   Called with the new value when the user toggles the switch.
 * @param {boolean} [props.disabled=false] - Disables the switch.
 * @param {'sm'|'md'} [props.size='md'] - `md` is 44×24px, `sm` is 36×20px.
 * @param {string} [props.id] - Id of the button; generated when omitted.
 * @param {React.ReactNode} [props.label] - Visible label rendered next to the switch.
 * @param {React.ReactNode} [props.description] - Help text under the label,
 *   wired to the switch with `aria-describedby`.
 * @param {'start'|'end'} [props.labelPosition='end'] - `start` puts the label
 *   before the switch and spreads the row (settings-list layout); `end` puts it
 *   after the switch.
 * @param {string} [props.className] - Classes for the outermost element: the
 *   row when a label or description is rendered, the button otherwise.
 * @param {string} [props.aria-label] - Accessible name without a visible label.
 * @param {string} [props.aria-labelledby] - Id(s) of the element(s) naming the switch.
 * @param {string} [props.aria-describedby] - Id(s) of the element(s) describing the switch.
 * @returns {JSX.Element}
 *
 * @example
 * // Label and description rendered by the switch
 * <Switch
 *   checked={settings.enabled}
 *   onChange={enabled => update({ enabled })}
 *   label={t('admin.example.enable', 'Enable example')}
 *   description={t('admin.example.enableHelp', 'What switching it on does.')}
 *   labelPosition="start"
 * />
 *
 * @example
 * // A label the screen lays out itself
 * <span id="pwa-enabled-label">{t('admin.ui.pwa.enable', 'Enable PWA')}</span>
 * <Switch checked={pwa.enabled} onChange={toggle} aria-labelledby="pwa-enabled-label" />
 */
function Switch({
  checked,
  onChange,
  disabled = false,
  size = 'md',
  id,
  label,
  description,
  labelPosition = 'end',
  className = '',
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  ...buttonProps
}) {
  const generatedId = useId();
  const switchId = id || `switch-${generatedId}`;
  const labelId = `${switchId}-label`;
  const descriptionId = `${switchId}-description`;
  const hasLabel = label !== undefined && label !== null && label !== '';
  const hasDescription = description !== undefined && description !== null && description !== '';
  const isOn = Boolean(checked);
  const dimensions = SIZES[size] || SIZES.md;

  const labelledBy = ariaLabelledBy || (hasLabel && !ariaLabel ? labelId : undefined);
  const describedBy =
    [ariaDescribedBy, hasDescription ? descriptionId : null].filter(Boolean).join(' ') || undefined;
  const hasRow = hasLabel || hasDescription;

  const button = (
    <button
      {...buttonProps}
      type="button"
      role="switch"
      id={switchId}
      aria-checked={isOn}
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={event => onChange?.(!isOn, event)}
      className={`relative inline-flex ${dimensions.track} shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out motion-reduce:transition-none focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 dark:focus-visible:ring-indigo-400 dark:focus-visible:ring-offset-gray-800 disabled:cursor-not-allowed disabled:opacity-50 ${
        isOn ? 'bg-indigo-600' : 'bg-gray-200 dark:bg-gray-600'
      } ${hasRow ? '' : className}`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none inline-block ${dimensions.thumb} transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out motion-reduce:transition-none ${
          isOn ? dimensions.on : 'translate-x-0'
        }`}
      />
    </button>
  );

  if (!hasRow) return button;

  const text = (
    <span className={`min-w-0 ${labelPosition === 'start' ? 'flex-1' : ''}`}>
      {hasLabel && (
        <label
          id={labelId}
          htmlFor={switchId}
          className={`block text-sm font-medium text-gray-900 dark:text-gray-100 ${
            disabled ? 'cursor-not-allowed' : 'cursor-pointer'
          }`}
        >
          {label}
        </label>
      )}
      {hasDescription && (
        <span id={descriptionId} className="mt-0.5 block text-sm text-gray-500 dark:text-gray-400">
          {description}
        </span>
      )}
    </span>
  );

  return (
    <div
      className={`flex items-center gap-3 ${labelPosition === 'start' ? 'justify-between' : ''} ${className}`}
    >
      {labelPosition === 'start' ? text : button}
      {labelPosition === 'start' ? button : text}
    </div>
  );
}

export default Switch;
