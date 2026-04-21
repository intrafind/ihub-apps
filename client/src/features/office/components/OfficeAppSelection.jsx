import { useEffect, useState } from 'react';
import ChatHeader from './chat/ChatHeader';
import AppCard from './AppCard';
import SettingsDialog from './settings-dialog';
import { useOfficeConfig } from '../contexts/OfficeConfigContext';
import { authenticatedFetch } from '../api/officeAuth';

const OfficeAppSelection = ({ user, onLogout, onSelect }) => {
  const config = useOfficeConfig();
  const [items, setItems] = useState([]);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    authenticatedFetch(config, `${config.baseUrl}/api/apps`)
      .then(res => (res.ok ? res.json() : Promise.reject(res)))
      .then(data => {
        if (Array.isArray(data) && data.length) {
          setItems(data);
        }
      })
      .catch(() => {
        // 401s handled centrally by authenticatedFetch (triggers session expiry).
        // Other errors are silently ignored — the app list stays empty.
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [config]);

  const menuItems = [
    { key: 'settings', label: 'Settings', onClick: () => setIsSettingsOpen(true) },
    { key: 'logout', label: 'Logout', onClick: onLogout }
  ];

  return (
    <div className="h-screen w-full flex flex-col p-0 bg-slate-50">
      <div className="flex-1 min-h-0 flex flex-col max-w-lg mx-auto w-full">
        <div className="relative flex flex-col h-full min-h-0 w-full overflow-hidden border border-[#e0e0e0] rounded-lg bg-white">
          <ChatHeader title="Select App" showCheckmark={false} menuItems={menuItems} />
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <div className="flex-1 overflow-y-auto p-4 grid gap-4 grid-cols-1">
              {items.map(item => (
                <AppCard key={item.id} item={item} onClick={onSelect} />
              ))}
              {!isLoading && items.length === 0 && (
                <p className="text-sm text-slate-400 text-center py-8">No apps available</p>
              )}
            </div>
            {isLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-white/70">
                <div className="flex flex-col items-center gap-2">
                  <div className="w-6 h-6 border-2 border-slate-300 border-t-slate-700 rounded-full animate-spin" />
                  <span className="text-sm text-slate-500">Loading your apps…</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <SettingsDialog
        user={user}
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />
    </div>
  );
};

export default OfficeAppSelection;
