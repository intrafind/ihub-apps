import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowPathIcon,
  CircleStackIcon,
  CpuChipIcon,
  ExclamationTriangleIcon,
  ServerStackIcon
} from '@heroicons/react/24/outline';
import { makeAdminApiCall } from '../../../api/adminApi';
import {
  STORAGE_STATUS_STYLES,
  formatBytes,
  formatPercent,
  formatUptime
} from '../utils/systemResourcesFormat';

/** How often the page re-reads the numbers while it is visible. */
const REFRESH_INTERVAL_MS = 15000;

function UsageBar({ percent, status = 'ok', label }) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const styles = STORAGE_STATUS_STYLES[status] || STORAGE_STATUS_STYLES.ok;
  return (
    <div
      className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5 overflow-hidden"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      aria-label={label}
    >
      <div
        className={`${styles.bar} h-2.5 rounded-full transition-all duration-300`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function StatusBadge({ status }) {
  const { t } = useTranslation();
  const styles = STORAGE_STATUS_STYLES[status] || STORAGE_STATUS_STYLES.ok;
  const labels = {
    ok: t('admin.systemResources.status.ok', 'OK'),
    warning: t('admin.systemResources.status.warning', 'Running low'),
    critical: t('admin.systemResources.status.critical', 'Critical')
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${styles.badge}`}
    >
      {labels[status] || labels.ok}
    </span>
  );
}

function Section({ icon: SectionIcon, title, description, children }) {
  return (
    <section className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700">
      <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700">
        <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
          <SectionIcon className="w-5 h-5 text-gray-500 dark:text-gray-400" aria-hidden="true" />
          {title}
        </h2>
        {description && (
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{description}</p>
        )}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function StorageSection({ storage }) {
  const { t } = useTranslation();
  const pathLabels = {
    contents: t('admin.systemResources.paths.contents', 'Contents'),
    data: t('admin.systemResources.paths.data', 'Data'),
    uploads: t('admin.systemResources.paths.uploads', 'Uploads'),
    logs: t('admin.systemResources.paths.logs', 'Logs'),
    temp: t('admin.systemResources.paths.temp', 'Temp')
  };

  return (
    <Section
      icon={CircleStackIcon}
      title={t('admin.systemResources.storage.title', 'Disk space')}
      description={t(
        'admin.systemResources.storage.description',
        'Filesystems holding the directories iHub writes to. Running low at {{warning}}% used, critical at {{critical}}%.',
        {
          warning: storage.thresholds?.warningPercent ?? 80,
          critical: storage.thresholds?.criticalPercent ?? 90
        }
      )}
    >
      {storage.volumes.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('admin.systemResources.storage.none', 'No disk information available.')}
        </p>
      ) : (
        <ul className="space-y-5">
          {storage.volumes.map(volume => {
            const title = volume.paths.map(p => pathLabels[p.key] || p.key).join(' · ');
            const styles = STORAGE_STATUS_STYLES[volume.status] || STORAGE_STATUS_STYLES.ok;
            return (
              <li key={volume.paths[0].path}>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                      {title}
                    </span>
                    <StatusBadge status={volume.status} />
                  </div>
                  <span className={`text-sm font-medium tabular-nums ${styles.text}`}>
                    {t(
                      'admin.systemResources.storage.freeOfTotal',
                      '{{free}} free of {{total}} ({{percent}} used)',
                      {
                        free: formatBytes(volume.available),
                        total: formatBytes(volume.total),
                        percent: formatPercent(volume.usedPercent)
                      }
                    )}
                  </span>
                </div>
                <UsageBar
                  percent={volume.usedPercent}
                  status={volume.status}
                  label={t('admin.systemResources.storage.usedLabel', '{{name}} disk usage', {
                    name: title
                  })}
                />
                <ul className="mt-2 space-y-0.5">
                  {volume.paths.map(p => (
                    <li
                      key={p.key}
                      className="text-xs text-gray-500 dark:text-gray-400 flex gap-2 min-w-0"
                    >
                      <span className="shrink-0 w-16">{pathLabels[p.key] || p.key}</span>
                      <code className="font-mono truncate" title={p.path}>
                        {p.path}
                      </code>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function InfoItem({ label, value, hint }) {
  return (
    <div>
      <dt className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
        {label}
      </dt>
      <dd className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100 tabular-nums">
        {value}
        {hint && <span className="ml-1 font-normal text-gray-500 dark:text-gray-400">{hint}</span>}
      </dd>
    </div>
  );
}

function HostSection({ host }) {
  const { t } = useTranslation();
  const memoryStatus =
    host.memory.usedPercent >= 90 ? 'critical' : host.memory.usedPercent >= 80 ? 'warning' : 'ok';

  return (
    <Section
      icon={CpuChipIcon}
      title={t('admin.systemResources.host.title', 'Host')}
      description={t(
        'admin.systemResources.host.description',
        'Shared by all server processes on this machine or container.'
      )}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {t('admin.systemResources.host.memory', 'Memory')}
            </span>
            <span className="text-sm tabular-nums text-gray-700 dark:text-gray-300">
              {t('admin.systemResources.host.memoryUsed', '{{used}} of {{total}} used', {
                used: formatBytes(host.memory.used),
                total: formatBytes(host.memory.total)
              })}
            </span>
          </div>
          <UsageBar
            percent={host.memory.usedPercent}
            status={memoryStatus}
            label={t('admin.systemResources.host.memory', 'Memory')}
          />
          {host.memory.containerLimited && (
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              {t(
                'admin.systemResources.host.containerMemory',
                'Container memory limit (host has {{total}}).',
                { total: formatBytes(host.memory.hostTotal) }
              )}
            </p>
          )}
        </div>
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {t('admin.systemResources.host.cpu', 'CPU')}
            </span>
            <span className="text-sm tabular-nums text-gray-700 dark:text-gray-300">
              {formatPercent(host.cpu.utilizationPercent)}
            </span>
          </div>
          <UsageBar
            percent={host.cpu.utilizationPercent}
            label={t('admin.systemResources.host.cpu', 'CPU')}
          />
          {host.cpu.model && (
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400 truncate">
              {host.cpu.model}
            </p>
          )}
        </div>
      </div>

      <dl className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
        <InfoItem
          label={t('admin.systemResources.host.cores', 'CPU cores')}
          value={host.cpu.cores}
          hint={
            host.cpu.limitCores
              ? t('admin.systemResources.host.cpuLimit', '(limit {{cores}})', {
                  cores: host.cpu.limitCores
                })
              : null
          }
        />
        <InfoItem
          label={t('admin.systemResources.host.load', 'Load average')}
          value={host.cpu.loadAverage ? host.cpu.loadAverage.join(' / ') : '—'}
        />
        <InfoItem
          label={t('admin.systemResources.host.uptime', 'Host uptime')}
          value={formatUptime(host.uptimeSeconds)}
        />
        <InfoItem
          label={t('admin.systemResources.host.node', 'Node.js')}
          value={host.nodeVersion}
        />
        <InfoItem
          label={t('admin.systemResources.host.hostname', 'Hostname')}
          value={<span className="break-all">{host.hostname}</span>}
        />
        <InfoItem
          label={t('admin.systemResources.host.os', 'Operating system')}
          value={`${host.platform} ${host.arch}`}
          hint={host.osRelease}
        />
      </dl>
    </Section>
  );
}

function ProcessesSection({ processes, cluster }) {
  const { t } = useTranslation();

  const processName = proc => {
    if (proc.role === 'primary') return t('admin.systemResources.processes.primary', 'Primary');
    if (proc.role === 'standalone')
      return t('admin.systemResources.processes.standalone', 'Server');
    return t('admin.systemResources.processes.worker', 'Worker {{index}}', {
      index: proc.workerIndex ?? '?'
    });
  };

  const headers = [
    t('admin.systemResources.processes.process', 'Process'),
    t('admin.systemResources.processes.pid', 'PID'),
    t('admin.systemResources.processes.cpu', 'CPU'),
    t('admin.systemResources.processes.memory', 'Memory (RSS)'),
    t('admin.systemResources.processes.heap', 'Heap used / limit'),
    t('admin.systemResources.processes.eventLoop', 'Event-loop delay'),
    t('admin.systemResources.processes.uptime', 'Uptime')
  ];

  return (
    <Section
      icon={ServerStackIcon}
      title={t('admin.systemResources.processes.title', 'Server processes')}
      description={
        cluster.mode === 'cluster'
          ? t(
              'admin.systemResources.processes.clusterDescription',
              'Cluster with {{count}} workers. CPU is a percentage of one core, averaged over the last few seconds.',
              { count: cluster.configuredWorkers }
            )
          : t(
              'admin.systemResources.processes.standaloneDescription',
              'Single server process. CPU is a percentage of one core, averaged over the last few seconds.'
            )
      }
    >
      <div className="overflow-x-auto -mx-5">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead>
            <tr>
              {headers.map(header => (
                <th
                  key={header}
                  scope="col"
                  className="px-5 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide whitespace-nowrap"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50 text-sm">
            {processes.map(proc => (
              <tr key={proc.pid}>
                <td className="px-5 py-2.5 whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">
                  {processName(proc)}
                  {proc.current && (
                    <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-sm text-xs font-normal bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
                      {t('admin.systemResources.processes.current', 'served this page')}
                    </span>
                  )}
                </td>
                <td className="px-5 py-2.5 whitespace-nowrap tabular-nums text-gray-700 dark:text-gray-300">
                  {proc.pid}
                </td>
                <td className="px-5 py-2.5 whitespace-nowrap tabular-nums text-gray-700 dark:text-gray-300">
                  {formatPercent(proc.cpuPercent)}
                </td>
                <td className="px-5 py-2.5 whitespace-nowrap tabular-nums text-gray-700 dark:text-gray-300">
                  {formatBytes(proc.memory?.rss)}
                </td>
                <td className="px-5 py-2.5 whitespace-nowrap tabular-nums text-gray-700 dark:text-gray-300">
                  {formatBytes(proc.memory?.heapUsed)} / {formatBytes(proc.memory?.heapLimit)}
                </td>
                <td className="px-5 py-2.5 whitespace-nowrap tabular-nums text-gray-700 dark:text-gray-300">
                  {proc.eventLoopDelayMs
                    ? t('admin.systemResources.processes.delay', '{{mean}} ms (max {{max}})', {
                        mean: proc.eventLoopDelayMs.mean,
                        max: proc.eventLoopDelayMs.max
                      })
                    : '—'}
                </td>
                <td className="px-5 py-2.5 whitespace-nowrap tabular-nums text-gray-700 dark:text-gray-300">
                  {formatUptime(proc.uptimeSeconds)}
                </td>
              </tr>
            ))}
            {cluster.missingWorkers.map(index => (
              <tr key={`missing-${index}`} className="bg-red-50 dark:bg-red-900/20">
                <td className="px-5 py-2.5 whitespace-nowrap font-medium text-red-800 dark:text-red-300">
                  {t('admin.systemResources.processes.worker', 'Worker {{index}}', { index })}
                </td>
                <td
                  colSpan={headers.length - 1}
                  className="px-5 py-2.5 text-red-700 dark:text-red-300"
                >
                  {t(
                    'admin.systemResources.processes.missing',
                    'Did not respond. The worker may be restarting or overloaded.'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function AdminSystemResourcesPage() {
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // The timer fires every 15 s whether or not the last load has answered; a
  // slow answer overtaken by a newer one would otherwise overwrite it.
  const inFlightRef = useRef(false);

  const load = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setRefreshing(true);
    try {
      const response = await makeAdminApiCall('/admin/system/resources');
      setData(response.data);
      setError(null);
    } catch (err) {
      setError(
        err?.message ||
          t('admin.systemResources.loadError', 'Failed to load system resource information')
      );
    } finally {
      inFlightRef.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) load();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const storageStatus = data?.storage?.status;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {t('admin.systemResources.title', 'System resources')}
          </h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {t(
              'admin.systemResources.description',
              'CPU, memory and disk space as reported by each server process on this host.'
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {data?.collectedAt && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {t('admin.systemResources.updatedAt', 'Updated {{time}}', {
                time: new Date(data.collectedAt).toLocaleTimeString()
              })}
            </span>
          )}
          <button
            type="button"
            onClick={load}
            disabled={refreshing}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-60"
          >
            <ArrowPathIcon
              className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            {t('admin.systemResources.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-6 p-4 rounded-md bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300"
        >
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="animate-pulse space-y-6">
          {['storage', 'host', 'processes'].map(section => (
            <div key={section} className="h-40 bg-gray-200 dark:bg-gray-700 rounded-lg" />
          ))}
        </div>
      )}

      {data && (
        <div className="space-y-6">
          {(storageStatus === 'warning' || storageStatus === 'critical') && (
            <div
              role="alert"
              className={`flex items-start gap-3 p-4 rounded-md border ${
                storageStatus === 'critical'
                  ? 'bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200'
                  : 'bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200'
              }`}
            >
              <ExclamationTriangleIcon className="w-5 h-5 shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-sm">
                {storageStatus === 'critical'
                  ? t(
                      'admin.systemResources.storage.criticalAlert',
                      'Disk space is critically low. Free up space or enlarge the volume soon, or saving chats, uploads and configuration will start to fail.'
                    )
                  : t(
                      'admin.systemResources.storage.warningAlert',
                      'Disk space is running low. Plan to free up space or enlarge the volume.'
                    )}
              </p>
            </div>
          )}

          {data.cluster?.missingWorkers?.length > 0 && (
            <div
              role="alert"
              className="flex items-start gap-3 p-4 rounded-md border bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200"
            >
              <ExclamationTriangleIcon className="w-5 h-5 shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-sm">
                {t(
                  'admin.systemResources.processes.missingAlert',
                  '{{count}} of {{total}} workers did not report back.',
                  {
                    count: data.cluster.missingWorkers.length,
                    total: data.cluster.configuredWorkers
                  }
                )}
              </p>
            </div>
          )}

          <StorageSection storage={data.storage} />
          <HostSection host={data.host} />
          <ProcessesSection processes={data.processes} cluster={data.cluster} />
        </div>
      )}
    </div>
  );
}

export default AdminSystemResourcesPage;
