// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import AdminLoadError from './AdminLoadError';

/**
 * Show a settings form only once the data it saves has loaded.
 *
 * Takes the result of `useAdminConfigLoad` and renders:
 * - `loading`: a spinner (or `loadingFallback`);
 * - `failed`: `AdminLoadError` for the first required source that failed, with
 *   an in-place Retry, the `Retry-After` countdown, and the 403/404 variants;
 * - `ready`: `children`.
 *
 * The form is not rendered at all while not ready (not rendered disabled): a
 * greyed-out form would still show default values as if they were stored.
 * Pass `children` as a function when its JSX reads loaded data, so nothing is
 * evaluated before the data exists.
 *
 * @param {object} props
 * @param {{status: 'loading'|'ready'|'failed', errors: object, retry: Function, retrying?: boolean, retryAfterSeconds?: number}} props.load
 *   What `useAdminConfigLoad` returned
 * @param {string} props.resourceLabel - What is loaded, for "Couldn't load {resource}"
 * @param {string[]} [props.sources] - Only these sources gate this part of the page
 *   (a page with several independently saved sections). Defaults to all required ones.
 * @param {boolean} [props.framed=false] - Passed to `AdminLoadError`
 * @param {string} [props.className] - Passed to `AdminLoadError`
 * @param {React.ReactNode} [props.loadingFallback] - Shown while loading
 * @param {{label: string, onClick: function}} [props.action] - e.g. "Back to …" for a 404
 * @param {React.ReactNode|(() => React.ReactNode)} props.children - The form
 *
 * @example
 * <AdminLoadGate load={load} resourceLabel={t('admin.auth.resource', 'authentication settings')}>
 *   {() => <PlatformFormEditor value={config} onChange={setConfig} />}
 * </AdminLoadGate>
 */
function AdminLoadGate({
  load,
  resourceLabel,
  sources,
  framed = false,
  className = '',
  loadingFallback,
  action,
  children
}) {
  const { status, errors = {}, retry, retrying = false, retryAfterSeconds = 0 } = load;

  let gateStatus = status;
  // The first failed required source; with `sources`, the first failed one of those.
  let error = load.error ?? null;
  if (sources) {
    // Gate on the named sources only; the hook's overall status covers all of them.
    const states = sources.map(key => load.sourceStatus?.[key] ?? 'loading');
    const failedKey = sources.find(key => load.sourceStatus?.[key] === 'failed');
    error = failedKey ? errors[failedKey] : null;
    if (failedKey) gateStatus = 'failed';
    else if (states.includes('loading')) gateStatus = 'loading';
    else gateStatus = 'ready';
  }

  if (gateStatus === 'loading') {
    return (
      loadingFallback ?? (
        <div className="flex items-center justify-center py-16">
          <LoadingSpinner size="lg" />
        </div>
      )
    );
  }

  if (gateStatus === 'failed') {
    return (
      <AdminLoadError
        resourceLabel={resourceLabel}
        message={error?.detail}
        status={error?.status ?? null}
        onRetry={retry}
        retrying={retrying}
        retryAfterSeconds={retryAfterSeconds}
        framed={framed}
        className={className}
        action={action}
      />
    );
  }

  return typeof children === 'function' ? children() : children;
}

export default AdminLoadGate;
