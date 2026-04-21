import { useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { officeLocale, SUPPORTED_LANGUAGES, setOfficeLocale } from '../../utilities/officeLocale';

export default function SettingsDialog({ user, isOpen, onClose }) {
  const [selectedLanguage, setSelectedLanguage] = useState(officeLocale);

  const handleSave = () => {
    if (selectedLanguage !== officeLocale) {
      setOfficeLocale(selectedLanguage);
    } else {
      onClose?.();
    }
  };

  const displayName =
    user?.name || user?.preferred_username || user?.username || user?.email || 'User';
  const initials = displayName
    .split(' ')
    .map(w => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-sm mx-4">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <h2 className="text-base font-semibold text-slate-900">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1 text-slate-500 hover:text-slate-900 hover:bg-slate-100"
          >
            <XMarkIcon className="h-5 w-5" aria-hidden />
          </button>
        </div>

        <div className="p-4 flex flex-col gap-5">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
              Account
            </p>
            <div className="flex items-center gap-3 px-3 py-2.5 bg-slate-50 rounded-lg border border-slate-200">
              <div className="flex-shrink-0 w-9 h-9 rounded-full bg-slate-800 flex items-center justify-center text-white text-sm font-semibold">
                {initials}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900 truncate">{displayName}</p>
                {user?.email && <p className="text-xs text-slate-500 truncate">{user.email}</p>}
              </div>
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
              Language
            </p>
            <select
              value={selectedLanguage}
              onChange={e => setSelectedLanguage(e.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-400"
            >
              {SUPPORTED_LANGUAGES.map(({ key, label }) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-200">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="rounded-lg px-4 py-2 text-sm font-medium bg-slate-900 text-white hover:bg-slate-700"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
