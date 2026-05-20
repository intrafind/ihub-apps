import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { fetchInbox, writeInbox } from '../../../api/agentsAdminApi';

// Parse a checklist-style markdown body into structured items so the form
// editor can manipulate them. Lines that don't match the checkbox shape are
// preserved as a header/footer block so we don't corrupt user-authored
// markdown when saving.
function parseBody(body) {
  const lines = body.split('\n');
  const items = [];
  const beforeLines = [];
  const afterLines = [];
  let seenItem = false;
  let trailingBlank = false;
  for (const line of lines) {
    const m = line.match(/^[-*]\s+\[( |x|X)\]\s+(?:\(([Pp][123])\)\s+)?(.+?)(?:\s+--\s+(.*))?$/);
    if (m) {
      seenItem = true;
      trailingBlank = false;
      items.push({
        status: m[1].toLowerCase() === 'x' ? 'done' : 'open',
        priority: m[2] ? m[2].toLowerCase() : '',
        text: m[3].trim(),
        note: m[4] ? m[4].trim() : ''
      });
    } else if (!seenItem) {
      beforeLines.push(line);
    } else {
      // Capture trailing blank lines + anything after the item block.
      afterLines.push(line);
      trailingBlank = line.trim() === '';
    }
  }
  // Strip a single trailing newline we'll add back in serialize.
  if (trailingBlank && afterLines.length && afterLines[afterLines.length - 1] === '') {
    afterLines.pop();
  }
  return { before: beforeLines.join('\n'), items, after: afterLines.join('\n') };
}

function serializeBody(parsed) {
  const lines = [];
  if (parsed.before && parsed.before.trim() !== '') lines.push(parsed.before);
  for (const it of parsed.items) {
    const box = it.status === 'done' ? '[x]' : '[ ]';
    const prio = it.priority ? `(${it.priority.toUpperCase()}) ` : '';
    const note = it.note ? `  -- ${it.note}` : '';
    lines.push(`- ${box} ${prio}${it.text}${note}`);
  }
  if (parsed.after && parsed.after.trim() !== '') lines.push(parsed.after);
  return lines.join('\n') + (lines.length ? '\n' : '');
}

export default function AdminAgentInboxEditPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { inboxId } = useParams();

  const [parsed, setParsed] = useState({ before: '', items: [], after: '' });
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [view, setView] = useState('form'); // 'form' | 'raw'
  const [rawBody, setRawBody] = useState('');

  const [newText, setNewText] = useState('');
  const [newPriority, setNewPriority] = useState('p2');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchInbox(inboxId);
        const data = res?.data || {};
        const body = data.body || `# ${inboxId}\n`;
        setParsed(parseBody(body));
        setRawBody(body);
        setVersion(data.version || 0);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [inboxId]);

  function syncRawFromForm(next = parsed) {
    setRawBody(serializeBody(next));
  }

  function addItem() {
    if (!newText.trim()) return;
    const next = {
      ...parsed,
      items: [
        ...parsed.items,
        { status: 'open', priority: newPriority, text: newText.trim(), note: '' }
      ]
    };
    setParsed(next);
    syncRawFromForm(next);
    setNewText('');
  }

  function updateItem(idx, partial) {
    const items = parsed.items.slice();
    items[idx] = { ...items[idx], ...partial };
    const next = { ...parsed, items };
    setParsed(next);
    syncRawFromForm(next);
  }

  function removeItem(idx) {
    const items = parsed.items.filter((_, i) => i !== idx);
    const next = { ...parsed, items };
    setParsed(next);
    syncRawFromForm(next);
  }

  function moveItem(idx, dir) {
    const items = parsed.items.slice();
    const j = idx + dir;
    if (j < 0 || j >= items.length) return;
    const [m] = items.splice(idx, 1);
    items.splice(j, 0, m);
    const next = { ...parsed, items };
    setParsed(next);
    syncRawFromForm(next);
  }

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const body = view === 'raw' ? rawBody : serializeBody(parsed);
      const res = await writeInbox(inboxId, body, version);
      setVersion(res?.data?.version || version + 1);
      // Re-sync the parsed view from whatever we sent so future edits start
      // from the canonical state.
      const reparsed = parseBody(body);
      setParsed(reparsed);
      setRawBody(body);
    } catch (err) {
      const code = err?.response?.data?.error;
      setError(
        code === 'VERSION_CONFLICT'
          ? t(
              'admin.agents.inbox.conflict',
              'Conflict — someone else updated the inbox. Reload to merge.'
            )
          : err.message
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <AdminAuth>
        <AdminNavigation />
        <div className="p-8 text-gray-600">{t('common.loading', 'Loading…')}</div>
      </AdminAuth>
    );
  }

  const openCount = parsed.items.filter(i => i.status === 'open').length;
  const doneCount = parsed.items.length - openCount;

  return (
    <AdminAuth>
      <div className="bg-gray-50 min-h-screen dark:bg-gray-900">
        <AdminNavigation />
        <div className="max-w-3xl mx-auto py-8 px-4">
          <div className="flex justify-between items-center mb-4">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {t('admin.agents.inbox.title', 'Inbox')} —{' '}
                <span className="font-mono">{inboxId}</span>
              </h1>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t('admin.agents.inbox.summary', '{{open}} open · {{done}} done · version {{v}}', {
                  open: openCount,
                  done: doneCount,
                  v: version
                })}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setView(view === 'form' ? 'raw' : 'form')}
                className="px-3 py-2 text-sm border bg-white rounded hover:bg-gray-50"
              >
                {view === 'form'
                  ? t('admin.common.viewRaw', 'Raw')
                  : t('admin.common.viewForm', 'Form')}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded disabled:opacity-50"
              >
                {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
              </button>
              <button
                onClick={() => navigate('/admin/agents/inboxes')}
                className="px-3 py-2 text-sm border bg-white rounded hover:bg-gray-50"
              >
                {t('common.back', 'Back')}
              </button>
            </div>
          </div>

          {error && (
            <div className="mb-3 p-3 bg-red-50 border border-red-200 text-red-800 rounded">
              {error}
            </div>
          )}

          {view === 'raw' ? (
            <>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                {t(
                  'admin.agents.inbox.rawHint',
                  'Items use GitHub-style checklist syntax: "- [ ] (P1) text". Optional "(P1)/(P2)/(P3)" prefix sets priority. The "-- note" suffix is shown when an agent marks an item done.'
                )}
              </p>
              <textarea
                className="w-full h-[480px] font-mono text-sm p-3 border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100"
                value={rawBody}
                onChange={e => {
                  setRawBody(e.target.value);
                  setParsed(parseBody(e.target.value));
                }}
              />
            </>
          ) : (
            <>
              {/* Add new item */}
              <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-4 mb-4">
                <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
                  {t('admin.agents.inbox.addItem', 'Add item')}
                </h2>
                <div className="flex gap-2">
                  <select
                    value={newPriority}
                    onChange={e => setNewPriority(e.target.value)}
                    className="rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                  >
                    <option value="">{t('admin.agents.inbox.noPriority', 'No priority')}</option>
                    <option value="p1">P1</option>
                    <option value="p2">P2</option>
                    <option value="p3">P3</option>
                  </select>
                  <input
                    type="text"
                    value={newText}
                    onChange={e => setNewText(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') addItem();
                    }}
                    placeholder={t(
                      'admin.agents.inbox.itemPlaceholder',
                      'Describe a task the agent should do'
                    )}
                    className="flex-1 rounded-lg border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                  />
                  <button
                    onClick={addItem}
                    className="px-3 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700"
                  >
                    {t('common.add', 'Add')}
                  </button>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                  {t(
                    'admin.agents.inbox.addHint',
                    'New items go in as "open". The agent picks the highest-priority open item via read_inbox.'
                  )}
                </p>
              </div>

              {/* Items */}
              <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-4">
                <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">
                  {t('admin.agents.inbox.items', 'Items')} ({parsed.items.length})
                </h2>
                {parsed.items.length === 0 ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {t('admin.agents.inbox.empty', 'No items yet. Add one above.')}
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {parsed.items.map((item, idx) => (
                      <li
                        key={idx}
                        className="flex items-start gap-2 p-2 border border-gray-200 dark:border-gray-700 rounded"
                      >
                        <input
                          type="checkbox"
                          checked={item.status === 'done'}
                          onChange={e =>
                            updateItem(idx, { status: e.target.checked ? 'done' : 'open' })
                          }
                          className="h-4 w-4 mt-1 text-indigo-600 border-gray-300 rounded"
                        />
                        <select
                          value={item.priority}
                          onChange={e => updateItem(idx, { priority: e.target.value })}
                          className="rounded border-gray-300 shadow-sm text-xs dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                        >
                          <option value="">—</option>
                          <option value="p1">P1</option>
                          <option value="p2">P2</option>
                          <option value="p3">P3</option>
                        </select>
                        <input
                          type="text"
                          value={item.text}
                          onChange={e => updateItem(idx, { text: e.target.value })}
                          className={`flex-1 rounded border-gray-300 shadow-sm text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 ${
                            item.status === 'done' ? 'line-through text-gray-400' : ''
                          }`}
                        />
                        <div className="flex flex-col gap-1">
                          <button
                            type="button"
                            onClick={() => moveItem(idx, -1)}
                            disabled={idx === 0}
                            title={t('common.moveUp', 'Move up')}
                            className="text-xs text-gray-500 hover:text-indigo-600 disabled:opacity-30"
                          >
                            ▲
                          </button>
                          <button
                            type="button"
                            onClick={() => moveItem(idx, 1)}
                            disabled={idx === parsed.items.length - 1}
                            title={t('common.moveDown', 'Move down')}
                            className="text-xs text-gray-500 hover:text-indigo-600 disabled:opacity-30"
                          >
                            ▼
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeItem(idx)}
                          title={t('common.delete', 'Delete')}
                          className="text-xs text-red-500 hover:text-red-700"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </AdminAuth>
  );
}
