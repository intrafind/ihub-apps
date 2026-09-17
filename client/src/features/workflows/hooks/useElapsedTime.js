import { useEffect, useState } from 'react';

/**
 * Returns a live-updating elapsed-time string between `startedAt` and either
 * `completedAt` (if provided) or `Date.now()`. While the workflow is still
 * running the value ticks every second; once completed it freezes at the
 * final duration.
 *
 * Internal `now` state is updated only from the interval callback, never
 * synchronously inside the effect, so the hook is render-pure.
 *
 * @param {string|number|null|undefined} startedAt - ISO string or epoch ms.
 * @param {string|number|null|undefined} completedAt - Optional end timestamp.
 * @returns {{ elapsedMs: number, formatted: string, minutes: number, seconds: number }}
 *   Elapsed time + a "Xm Ys" / "Ys" formatted string. `elapsedMs` is 0 when
 *   `startedAt` is missing.
 */
export function useElapsedTime(startedAt, completedAt) {
  const start = startedAt ? new Date(startedAt).getTime() : null;
  const end = completedAt ? new Date(completedAt).getTime() : null;

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!start || end) return undefined;
    const intervalId = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(intervalId);
  }, [start, end]);

  if (!start) {
    return { elapsedMs: 0, formatted: '', minutes: 0, seconds: 0 };
  }

  const effectiveEnd = end ?? now;
  const elapsedMs = Math.max(0, effectiveEnd - start);
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const formatted = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

  return { elapsedMs, formatted, minutes, seconds };
}

export default useElapsedTime;
