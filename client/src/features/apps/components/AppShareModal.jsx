import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { createShortLink, getShortLink } from '../../../api/api';

function generateCode(length = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

const getUsername = () => {
  try {
    return localStorage.getItem('ihub_username') || 'anonymous';
  } catch {
    return 'anonymous';
  }
};

const AppShareModal = ({ appId, path, params, onClose }) => {
  const { t } = useTranslation();
  const [code, setCode] = useState(generateCode());
  const [includeParams, setIncludeParams] = useState(true);
  const [expiresAt, setExpiresAt] = useState('');
  const [checking, setChecking] = useState(false);
  const [available, setAvailable] = useState(true);
  const [validLength, setValidLength] = useState(code.length >= 5);
  const [createdUrl, setCreatedUrl] = useState('');
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);

  const checkCode = async c => {
    if (c.length < 5) {
      setValidLength(false);
      setAvailable(false);
      return;
    }
    setValidLength(true);
    setChecking(true);
    try {
      await getShortLink(c);
      setAvailable(false);
    } catch (err) {
      if (err.status === 404) {
        setAvailable(true);
      } else {
        setAvailable(false);
      }
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    if (code.length >= 5) {
      checkCode(code);
    } else {
      setValidLength(false);
      setAvailable(false);
    }
  }, [code]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const data = await createShortLink({
        appId,
        path,
        params,
        userId: getUsername(),
        includeParams,
        code,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null
      });
      setCreatedUrl(`${window.location.origin}/s/${data.code}`);
    } catch (err) {
      console.error('Failed to create short link', err);
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(createdUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy link', err);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-lg max-w-md w-full p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold">{t('common.share')}</h2>
          <button onClick={onClose} aria-label={t('common.cancel')}>
            <Icon name="x" />
          </button>
        </div>
        {createdUrl ? (
          <div className="space-y-4">
            <p className="break-all">{createdUrl}</p>
            <div className="flex items-center gap-2">
              <button
                onClick={handleCopy}
                className="px-3 py-1 bg-indigo-600 text-white rounded hover:bg-indigo-700 flex items-center gap-1"
              >
                <Icon name="copy" /> {t('pages.promptsList.copyPrompt', 'Copy')}
              </button>
              {copied && (
                <span className="text-green-600 text-sm">
                  {t('pages.promptsList.linkCopied', 'Link copied!')}
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <label className="block">
              <span className="text-sm font-medium">{t('common.shortCode')}</span>
              <div className="flex mt-1">
                <input
                  type="text"
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  className="w-full border rounded-l px-2 py-1"
                />
                <button
                  type="button"
                  onClick={() => setCode(generateCode())}
                  className="border border-l-0 rounded-r px-2"
                  title={t('pages.appChat.regenerate', 'Regenerate')}
                >
                  <Icon name="redo" size="sm" />
                </button>
              </div>
            </label>
            <div className="text-sm">
              {!validLength ? (
                <span className="text-red-600">{t('common.codeTooShort', 'Code too short')}</span>
              ) : checking ? (
                t('common.loading')
              ) : available ? (
                <span className="text-green-600">{t('common.codeAvailable')}</span>
              ) : (
                <span className="text-red-600">{t('common.codeTaken')}</span>
              )}
            </div>
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={includeParams}
                onChange={e => setIncludeParams(e.target.checked)}
              />
              {t('common.includeSettings')}
            </label>
            <label className="block">
              <span className="text-sm">{t('common.expiresAt', 'Expires At')}</span>
              <input
                type="datetime-local"
                value={expiresAt}
                onChange={e => setExpiresAt(e.target.value)}
                className="mt-1 w-full border rounded px-2 py-1"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="px-3 py-1 border rounded">
                {t('common.cancel')}
              </button>
              <button
                onClick={handleCreate}
                disabled={!validLength || !available || creating}
                className="px-3 py-1 bg-indigo-600 text-white rounded disabled:opacity-50"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default AppShareModal;
