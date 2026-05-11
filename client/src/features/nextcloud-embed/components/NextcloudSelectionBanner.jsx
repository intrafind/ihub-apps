import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEmbeddedHost } from '../../office/contexts/EmbeddedHostContext';
import { getCurrentSelection, onSelectionChange } from '../utilities/nextcloudSelectionBridge';
import Icon from '../../../shared/components/Icon';

/**
 * Banner shown above the apps list when the iHub UI is mounted inside the
 * Nextcloud embed and the user arrived with a file selection. Hints how many
 * documents are queued and that the user should pick an app to attach them
 * to. No-op outside the Nextcloud embed or when no selection exists.
 */
function NextcloudSelectionBanner() {
  const host = useEmbeddedHost();
  const { t } = useTranslation();
  const [count, setCount] = useState(() => {
    const sel = getCurrentSelection();
    return sel?.paths?.length || 0;
  });

  useEffect(() => {
    // Stay in sync if the parent Nextcloud frame posts a new selection while
    // the user is sitting on the apps list.
    const unsubscribe = onSelectionChange(sel => {
      setCount(sel?.paths?.length || 0);
    });
    return () => unsubscribe();
  }, []);

  if (host?.kind !== 'nextcloud') return null;
  if (count <= 0) return null;

  return (
    <div
      role="status"
      className="mb-6 flex items-start gap-3 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900 dark:border-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-100"
    >
      <Icon name="info" className="mt-0.5 h-5 w-5 flex-shrink-0" />
      <div>
        <p className="font-medium">{t('pages.appsList.nextcloudSelection.title', { count })}</p>
        <p className="mt-0.5 opacity-80">{t('pages.appsList.nextcloudSelection.description')}</p>
      </div>
    </div>
  );
}

export default NextcloudSelectionBanner;
