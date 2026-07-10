import { useCallback, useEffect, useRef, useState } from 'react';
import { useUnsavedChanges } from './useUnsavedChanges';

/** Route-param sentinel every Admin*EditPage uses for "creating a new resource". */
const NEW_RESOURCE_ID = 'new';

/**
 * Shared load / dirty-tracking / save orchestration for admin "edit resource" pages
 * (AdminGroupEditPage, AdminAppEditPage, AdminModelEditPage, AdminPromptEditPage,
 * AdminToolEditPage, AdminUserEditPage). These pages all repeat the same scaffold:
 * branch on `resourceId === 'new'` to build a default object vs. loading the existing
 * resource, wire up `useUnsavedChanges` for the "Unsaved Changes" confirm dialog, and
 * save via a method/url ternary + an API call. This hook centralizes that scaffold so
 * each page only has to supply the resource-specific pieces.
 *
 * Deliberately NOT handled here: navigation after save, and the `saving` UI flag.
 * Pages differ on both (some show a toast before navigating, some navigate
 * immediately; disabling the Save button also usually needs to wrap validation
 * that happens before `save()` is ever called), so both stay in each page's own
 * `handleSave`, which should call `await save()` and then `navigate(...)` itself.
 *
 * @param {Object} params
 * @param {string} params.resourceId - route param identifying the resource being edited.
 *   The sentinel value `'new'` means "creating a new resource" and skips loading.
 * @param {(id: string) => (any | Promise<any>)} params.loadResource - fetch the existing
 *   resource by id and resolve with the object that becomes the editable `data`. May run
 *   additional page-specific side effects (e.g. seeding other local state) as long as it
 *   still resolves with that object; throwing populates `error`.
 * @param {() => (any | Promise<any>)} params.makeDefault - build the default object used
 *   when `resourceId === 'new'`. May close over router state (e.g. `location.state`) to
 *   pre-fill from a template.
 * @param {(data: any, resourceId: string) => Promise<any>} params.saveResource - persist
 *   `data`. Implements the method/url ternary + API call the page already knows about.
 *   Whatever it returns is returned from `save()`; whatever it throws is thrown from
 *   `save()` (and `markSaved()` is skipped in that case).
 * @returns {{
 *   data: any,
 *   setData: (updater: any) => void,
 *   initialData: any,
 *   loading: boolean,
 *   error: string|null,
 *   setError: (message: string|null) => void,
 *   isNew: boolean,
 *   save: () => Promise<any>,
 *   blocker: { state: 'blocked'|'unblocked', proceed: Function, reset: Function },
 *   markSaved: () => void
 * }}
 *
 * @example
 * const { data: group, setData: setGroup, loading, error, setError, save, blocker } =
 *   useAdminResourceEditor({
 *     resourceId: groupId,
 *     loadResource: async id => {
 *       const response = await makeAdminApiCall('/admin/groups');
 *       const groupData = response.data.groups[id];
 *       if (!groupData) throw new Error('Group not found');
 *       return groupData;
 *     },
 *     makeDefault: () => ({ id: '', name: '', description: '', enabled: true }),
 *     saveResource: async (data, id) => {
 *       const method = id === 'new' ? 'POST' : 'PUT';
 *       const url = id === 'new' ? '/admin/groups' : `/admin/groups/${id}`;
 *       await makeAdminApiCall(url, { method, body: data });
 *     }
 *   });
 */
export function useAdminResourceEditor({ resourceId, loadResource, makeDefault, saveResource }) {
  const isNew = resourceId === NEW_RESOURCE_ID;

  // Compute "new resource" defaults synchronously (not inside the effect below)
  // so the very first render already has real `data`/`initialData` instead of
  // `null` while `loading` is already `false` -- this mirrors how every page
  // previously seeded a `useState` literal directly for the `resourceId === 'new'`
  // case, and avoids handing a form component a `null` value it isn't guarding
  // against. `useRef` (not `useState`) so this only ever runs once per mount,
  // even though the same value is also read by two separate `useState`
  // initializers below (calling `makeDefault` twice would, e.g., generate two
  // different random ids for AdminUserEditPage's default user).
  const mountDefaultsRef = useRef(undefined);
  if (mountDefaultsRef.current === undefined) {
    mountDefaultsRef.current = isNew ? makeDefault() : null;
  }

  const [data, setData] = useState(mountDefaultsRef.current);
  const [initialData, setInitialData] = useState(mountDefaultsRef.current);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState(null);

  // Keep the latest callbacks in refs so the loading effect below can depend
  // only on `resourceId` (matching what each page already did with its own
  // `// eslint-disable-line @eslint-react/exhaustive-deps` effects) without
  // re-running every render just because the page passed a fresh inline
  // function this time.
  const loadResourceRef = useRef(loadResource);
  loadResourceRef.current = loadResource;
  const makeDefaultRef = useRef(makeDefault);
  makeDefaultRef.current = makeDefault;
  const saveResourceRef = useRef(saveResource);
  saveResourceRef.current = saveResource;

  // Tracks whether the effect below is running for the very first time, so it
  // can skip redoing the "new resource" defaults computation that
  // `mountDefaultsRef` already handled synchronously above for the initial
  // mount. Subsequent `resourceId` changes (e.g. switching from an existing
  // resource to 'new', or between two different resources, without the page
  // unmounting -- React Router keeps the component mounted across route-param
  // changes on the same route) always recompute fresh via this effect.
  const isFirstRunRef = useRef(true);

  useEffect(() => {
    const isFirstRun = isFirstRunRef.current;
    isFirstRunRef.current = false;

    if (isFirstRun && resourceId === NEW_RESOURCE_ID) {
      // Already handled synchronously via mountDefaultsRef above.
      return undefined;
    }

    let cancelled = false;

    async function run() {
      if (resourceId === NEW_RESOURCE_ID) {
        const defaults = await makeDefaultRef.current();
        if (cancelled) return;
        setData(defaults);
        setInitialData(defaults);
        setError(null);
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        const loaded = await loadResourceRef.current(resourceId);
        if (cancelled) return;
        setData(loaded);
        setInitialData(loaded);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();

    return () => {
      cancelled = true;
    };
  }, [resourceId]);

  const { blocker, markSaved } = useUnsavedChanges(initialData, data);

  const save = useCallback(async () => {
    const result = await saveResourceRef.current(data, resourceId);
    markSaved();
    return result;
  }, [data, resourceId, markSaved]);

  return {
    data,
    setData,
    initialData,
    loading,
    error,
    setError,
    isNew,
    save,
    blocker,
    markSaved
  };
}
