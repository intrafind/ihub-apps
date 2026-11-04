// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

export const RANGES = ['today', '24h', '7d', '30d', '90d', '12m', 'custom'];
export const TABS = ['overview', 'breakdown', 'reliability', 'requests', 'limits'];
export const DIMENSIONS = ['user', 'group', 'app', 'model', 'provider', 'surface'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const DEFAULTS = {
  tab: 'overview',
  range: '7d',
  dim: 'user',
  sort: 'totalTokens',
  order: 'desc',
  metric: 'tokens'
};

/**
 * The usage reports' view state, kept in the URL so a view can be shared and
 * survives a reload: tab, range (with custom from/to), breakdown dimension
 * and sort, chart metric, auto-refresh, request-log filters.
 */
export default function useUsageReportState() {
  const [params, setParams] = useSearchParams();

  const state = useMemo(() => {
    const get = (key, allowed) => {
      const value = params.get(key);
      return value && (!allowed || allowed.includes(value)) ? value : DEFAULTS[key];
    };
    let range = get('range', RANGES);
    const from = params.get('from');
    const to = params.get('to');
    const customOk = DATE.test(from || '') && DATE.test(to || '') && from <= to;
    if (range === 'custom' && !customOk) range = DEFAULTS.range;
    return {
      tab: get('tab', TABS),
      range,
      from: range === 'custom' ? from : null,
      to: range === 'custom' ? to : null,
      dim: get('dim', DIMENSIONS),
      sort: params.get('sort') || DEFAULTS.sort,
      order: params.get('order') === 'asc' ? 'asc' : 'desc',
      metric: params.get('metric') === 'requests' ? 'requests' : 'tokens',
      auto: params.get('auto') === '1',
      filters: {
        user: params.get('f_user') || '',
        app: params.get('f_app') || '',
        model: params.get('f_model') || '',
        surface: params.get('f_surface') || '',
        outcome: params.get('f_outcome') || ''
      }
    };
  }, [params]);

  /** Merge changes into the URL; null/'' (or the default) removes a key. */
  const update = useCallback(
    changes => {
      setParams(
        prev => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(changes)) {
            if (value === null || value === undefined || value === '' || value === DEFAULTS[key]) {
              next.delete(key);
            } else {
              next.set(key, String(value));
            }
          }
          return next;
        },
        { replace: true }
      );
    },
    [setParams]
  );

  const rangeParams = useMemo(
    () =>
      state.range === 'custom'
        ? { range: 'custom', from: state.from, to: state.to }
        : { range: state.range },
    [state.range, state.from, state.to]
  );

  return { ...state, rangeParams, update };
}
