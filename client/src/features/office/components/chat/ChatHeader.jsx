import { useState, useRef, useEffect } from 'react';
import {
  ArrowLeftIcon,
  PencilSquareIcon,
  Bars3Icon,
  ChevronDownIcon
} from '@heroicons/react/24/outline';

const ChatHeader = ({
  title = 'iHub Apps',
  showCheckmark = true,
  onWriteClick,
  onBackClick,
  menuItems = [],
  titleIcon,
  selectedApp,
  onItemClick
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = e => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  return (
    <header className="flex items-center justify-between w-full px-2 py-1.5 bg-white border-b border-[#e0e0e0] shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        {onBackClick && (
          <button
            type="button"
            onClick={onBackClick}
            aria-label="Back to app selection"
            className="rounded-full p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100 shrink-0"
          >
            <ArrowLeftIcon className="h-5 w-5" aria-hidden />
          </button>
        )}
        {titleIcon && <span className="flex-shrink-0 text-slate-600">{titleIcon}</span>}
        {showCheckmark && (
          <span className="flex-shrink-0 text-green-600 font-bold text-lg leading-none" aria-hidden>
            ✓
          </span>
        )}
        {selectedApp ? (
          <button
            type="button"
            className="flex items-center gap-1 cursor-pointer font-semibold text-slate-900 hover:text-slate-700 min-w-0"
            onClick={onItemClick}
            aria-label="Select app"
          >
            <span className="truncate">{selectedApp.name}</span>
            <ChevronDownIcon className="h-4 w-4 shrink-0" aria-hidden />
          </button>
        ) : title ? (
          <h1 className="text-base font-semibold text-slate-900 truncate">{title}</h1>
        ) : null}
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {onWriteClick && (
          <button
            type="button"
            onClick={onWriteClick}
            aria-label="New chat"
            className="rounded-full p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100"
          >
            <PencilSquareIcon className="h-5 w-5" aria-hidden />
          </button>
        )}

        {menuItems.length > 0 && (
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen(o => !o)}
              aria-label="Open menu"
              aria-expanded={menuOpen}
              className="rounded-full p-1.5 text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            >
              <Bars3Icon className="h-5 w-5" aria-hidden />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 min-w-[140px] rounded-lg border border-slate-200 bg-white shadow-lg z-50 py-1">
                {menuItems.map(item =>
                  item.disabled ? (
                    <div key={item.key} className="px-4 py-2 text-sm text-slate-400 cursor-default">
                      {item.label}
                    </div>
                  ) : (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        item.onClick();
                      }}
                      className="block w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
                    >
                      {item.label}
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
};

export default ChatHeader;
