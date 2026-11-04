// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatBucket, formatCompact, formatNumber, formatPercent } from './usageFormat';

const WIDTH = 760;
const HEIGHT = 240;
const PAD = { top: 12, right: 12, bottom: 28, left: 52 };

function niceMax(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find(s => s * magnitude >= value / 1.0001) || 10;
  return step * magnitude;
}

/**
 * Stacked bar chart over a usage series. Loaded lazily (React.lazy), so the
 * charts stay out of the admin bundle until a report shows one.
 *
 * @param {Object} props
 * @param {Array<Object>} props.points - series points `{ t, ...values }`
 * @param {Array<{key: string, label: string, className: string, value?: Function}>} props.stacks
 * @param {'hour'|'day'} props.granularity
 * @param {'number'|'percent'} [props.format]
 * @param {string} props.title - accessible name
 */
export default function UsageChart({ points, stacks, granularity, format = 'number', title }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [hover, setHover] = useState(null);

  const rows = useMemo(
    () =>
      (points || []).map(p => {
        const values = stacks.map(s => Math.max(0, (s.value ? s.value(p) : p[s.key]) || 0));
        return { t: p.t, values, total: values.reduce((a, b) => a + b, 0) };
      }),
    [points, stacks]
  );
  const max = niceMax(Math.max(0, ...rows.map(r => r.total)));
  const fmt = v => (format === 'percent' ? formatPercent(v, lang, 0) : formatCompact(v, lang));
  const fmtFull = v => (format === 'percent' ? formatPercent(v, lang, 1) : formatNumber(v, lang));
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const slot = rows.length ? innerW / rows.length : innerW;
  const barW = Math.max(1, Math.min(28, slot * 0.7));
  const labelEvery = Math.max(1, Math.ceil(rows.length / 8));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => f * max);

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-label={title}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map(v => {
          const y = PAD.top + innerH - (v / max) * innerH;
          return (
            <g key={v}>
              <line
                x1={PAD.left}
                x2={WIDTH - PAD.right}
                y1={y}
                y2={y}
                className="stroke-gray-200 dark:stroke-gray-700"
                strokeWidth="1"
              />
              <text
                x={PAD.left - 6}
                y={y + 4}
                textAnchor="end"
                className="fill-gray-500 text-[10px] dark:fill-gray-400"
              >
                {fmt(v)}
              </text>
            </g>
          );
        })}
        {rows.map((row, i) => {
          const x = PAD.left + i * slot + (slot - barW) / 2;
          let y = PAD.top + innerH;
          return (
            <g key={row.t} onMouseEnter={() => setHover(i)}>
              <rect
                x={PAD.left + i * slot}
                y={PAD.top}
                width={slot}
                height={innerH}
                className={hover === i ? 'fill-gray-100 dark:fill-gray-700/50' : 'fill-transparent'}
              />
              {row.values.map((v, si) => {
                const h = (v / max) * innerH;
                y -= h;
                return v > 0 ? (
                  <rect
                    key={stacks[si].key}
                    x={x}
                    y={y}
                    width={barW}
                    height={h}
                    className={stacks[si].className}
                  />
                ) : null;
              })}
              {i % labelEvery === 0 && (
                <text
                  x={PAD.left + i * slot + slot / 2}
                  y={HEIGHT - 8}
                  textAnchor="middle"
                  className="fill-gray-500 text-[10px] dark:fill-gray-400"
                >
                  {formatBucket(row.t, granularity, lang)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && rows[hover] && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-md border border-gray-200 bg-white px-3 py-2 text-xs shadow-lg dark:border-gray-700 dark:bg-gray-900"
          style={{
            left: `${Math.min(75, ((PAD.left + hover * slot) / WIDTH) * 100)}%`
          }}
        >
          <p className="font-medium text-gray-900 dark:text-gray-100">
            {formatBucket(rows[hover].t, granularity, lang)}
          </p>
          {stacks.map((s, si) => (
            <p key={s.key} className="flex items-center gap-1.5 text-gray-600 dark:text-gray-300">
              <span className={`inline-block h-2 w-2 rounded-sm ${s.swatch}`} />
              {s.label}: {fmtFull(rows[hover].values[si])}
            </p>
          ))}
          {stacks.length > 1 && (
            <p className="mt-0.5 text-gray-500">
              {t('admin.usage.reports.chart.total', 'Total')}: {fmtFull(rows[hover].total)}
            </p>
          )}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-4 text-xs text-gray-600 dark:text-gray-400">
        {stacks.map(s => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className={`inline-block h-2.5 w-2.5 rounded-sm ${s.swatch}`} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
