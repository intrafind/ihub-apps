import { useCallback } from 'react';
import { fetchCurrentMailContext } from '../utilities/outlookMailContext';

/**
 * Returns a stable async function that reads the current Outlook mail item via Office.js
 * (keeps Office usage out of presentational components).
 * @returns {() => Promise<Awaited<ReturnType<typeof fetchCurrentMailContext>>>}
 */
export function useOutlookMailContextReader() {
  return useCallback(() => fetchCurrentMailContext(), []);
}
