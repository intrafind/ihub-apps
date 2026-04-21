import { useEffect } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import AppCard from '../../../../shared/components/AppCard';
import { officeLocale } from '../../utilities/officeLocale';

export default function ItemSelectorDialog({ items, isOpen, onSelect, onClose }) {
  useEffect(() => {
    if (!isOpen) return;
    const handler = e => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 shrink-0">
          <h2 className="text-base font-semibold text-slate-900">Select an App</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1 text-slate-500 hover:text-slate-900 hover:bg-slate-100"
          >
            <XMarkIcon className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <div className="overflow-y-auto p-4">
          <div className="grid gap-3 grid-cols-1">
            {items && items.length ? (
              items.map(item => (
                <AppCard
                  key={item.id}
                  app={item}
                  variant="compact"
                  onClick={onSelect}
                  language={officeLocale}
                />
              ))
            ) : (
              <p className="px-4 py-2 text-sm text-slate-400">No apps available</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
