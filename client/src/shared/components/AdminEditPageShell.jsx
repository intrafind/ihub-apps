import AdminBreadcrumb from '../../features/admin/components/AdminBreadcrumb';
import ConfirmDialog from './ConfirmDialog';
import LoadingSpinner from './LoadingSpinner';

/**
 * Shared page chrome for admin "edit resource" pages (AdminGroupEditPage,
 * AdminAppEditPage, AdminModelEditPage, AdminPromptEditPage, AdminToolEditPage,
 * AdminUserEditPage). Wraps the breadcrumb, a loading state, the resource-specific
 * form body (`children`), any extra page content that sits outside the main
 * content column (e.g. a `ChangeHistoryDrawer`), and the "Unsaved Changes" confirm
 * dialog driven by `blocker` (see `useAdminResourceEditor` / `useUnsavedChanges`).
 *
 * The wrapper `className`s are intentionally left overridable via `outerClassName`
 * / `contentClassName` rather than hardcoded: the pages this replaces don't share
 * identical wrapper markup (e.g. AdminAppEditPage has no `min-h-screen` outer
 * wrapper at all, AdminToolEditPage uses `max-w-7xl` instead of `max-w-4xl`). Pass
 * the page's existing classNames through so the rendered output doesn't change.
 *
 * `ConfirmDialog` is a `position: fixed` overlay, so its exact position in the DOM
 * tree has no effect on layout - it's always rendered once here regardless of
 * `outerClassName`.
 *
 * @param {Object} props
 * @param {boolean} props.loading - when true, renders `loadingFallback` instead of
 *   the breadcrumb + children (matches every page's original early-return spinner).
 * @param {React.ReactNode} [props.loadingFallback] - defaults to a centered
 *   `LoadingSpinner` in a `min-h-screen` wrapper (the AdminGroupEditPage /
 *   AdminUserEditPage style). Pages with a different loading visual should pass
 *   their own node here to keep pixel-identical output.
 * @param {string} [props.outerClassName] - classes for the outermost wrapper div.
 *   Omit (or pass `''`/`undefined`) to skip the outer wrapper entirely, e.g. for
 *   pages whose root element IS the content column (AdminAppEditPage).
 * @param {string} [props.contentClassName] - classes for the inner max-width
 *   content div that holds the breadcrumb + form body. Defaults to the
 *   `max-w-4xl` column used by most of these pages.
 * @param {Array<{label: string, href?: string}>} props.breadcrumbs - passed
 *   straight through to `AdminBreadcrumb`.
 * @param {React.ReactNode} props.children - the page's form body (header,
 *   `DualModeEditor`, save/cancel row, etc).
 * @param {React.ReactNode} [props.extra] - rendered as a sibling after the content
 *   div, still inside the outer wrapper when there is one (e.g. a
 *   `ChangeHistoryDrawer`, which several pages render alongside the form).
 * @param {{state: 'blocked'|'unblocked', proceed: Function, reset: Function}} props.blocker -
 *   from `useAdminResourceEditor`/`useUnsavedChanges`; drives the "Unsaved Changes" dialog.
 */
function AdminEditPageShell({
  loading,
  loadingFallback,
  outerClassName,
  contentClassName = 'max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8',
  breadcrumbs,
  children,
  extra,
  blocker
}) {
  if (loading) {
    return (
      loadingFallback ?? (
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      )
    );
  }

  const content = (
    <div className={contentClassName}>
      <AdminBreadcrumb crumbs={breadcrumbs} />
      {children}
    </div>
  );

  return (
    <>
      {outerClassName ? (
        <div className={outerClassName}>
          {content}
          {extra}
        </div>
      ) : (
        <>
          {content}
          {extra}
        </>
      )}

      <ConfirmDialog
        isOpen={blocker?.state === 'blocked'}
        title="Unsaved Changes"
        message="You have unsaved changes. Leave anyway?"
        confirmLabel="Leave"
        denyLabel="Stay"
        danger={false}
        onConfirm={() => blocker?.proceed?.()}
        onDeny={() => blocker?.reset?.()}
      />
    </>
  );
}

/**
 * The plain-text Save/Cancel button row shared byte-for-byte by
 * AdminGroupEditPage, AdminPromptEditPage, and AdminUserEditPage (a `type="submit"`
 * button showing a spinner + "Saving..." label while `saving` is true, and a plain
 * `type="button"` Cancel button next to it). AdminAppEditPage, AdminModelEditPage,
 * and AdminToolEditPage use visually distinct button rows (icons, extra disabled
 * conditions, tab-conditional rendering) and render their own instead of using this.
 *
 * `cancelClassName` / `saveClassName` default to the exact classes used by
 * AdminGroupEditPage/AdminUserEditPage; pass an override to match small existing
 * differences (e.g. AdminPromptEditPage's cancel button uses `dark:text-gray-200`
 * instead of `dark:text-gray-300`).
 *
 * @param {Object} props
 * @param {() => void} props.onCancel
 * @param {React.ReactNode} props.cancelLabel
 * @param {boolean} props.saving
 * @param {React.ReactNode} props.saveLabel - shown when `saving` is false.
 * @param {React.ReactNode} props.savingLabel - shown next to the spinner when `saving` is true.
 * @param {boolean} [props.disabled=false] - additional disabled condition ORed with `saving`.
 * @param {string} [props.cancelClassName]
 * @param {string} [props.saveClassName]
 */
export function AdminSaveCancelButtons({
  onCancel,
  cancelLabel,
  saving,
  saveLabel,
  savingLabel,
  disabled = false,
  cancelClassName = 'px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500',
  saveClassName = 'px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50'
}) {
  return (
    <div className="flex justify-end space-x-4">
      <button type="button" onClick={onCancel} className={cancelClassName}>
        {cancelLabel}
      </button>
      <button type="submit" disabled={saving || disabled} className={saveClassName}>
        {saving ? (
          <>
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2 inline-block"></div>
            {savingLabel}
          </>
        ) : (
          saveLabel
        )}
      </button>
    </div>
  );
}

export default AdminEditPageShell;
