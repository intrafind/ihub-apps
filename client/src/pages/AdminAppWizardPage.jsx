import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import DynamicLanguageEditor from '../components/DynamicLanguageEditor';

const defaultApp = {
  id: '',
  name: { en: '' },
  description: { en: '' },
  color: '#4F46E5',
  icon: 'chat-bubbles',
  system: { en: '' },
  tokenLimit: 4096,
  preferredModel: 'gpt-4',
  preferredOutputFormat: 'markdown',
  preferredStyle: 'normal',
  preferredTemperature: 0.7,
  sendChatHistory: true,
  variables: []
};

const AdminAppWizardPage = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [mode, setMode] = useState('blank');
  const [apps, setApps] = useState([]);
  const [description, setDescription] = useState('');
  const [parentId, setParentId] = useState('');
  const [app, setApp] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/admin/apps')
      .then(res => res.ok ? res.json() : [])
      .then(setApps)
      .catch(() => {});
  }, []);

  const start = async () => {
    if (mode === 'ai') {
      setLoading(true);
      try {
        const res = await fetch('/api/admin/app-generator', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description })
        });
        const data = await res.json();
        setApp({ ...data, id: '' });
        setStep(2);
      } catch (e) {
        setError('Failed to generate app');
      } finally {
        setLoading(false);
      }
    } else if (mode === 'clone') {
      const src = apps.find(a => a.id === parentId);
      if (src) {
        const clone = { ...src, id: '', parentId: src.id };
        setApp(clone);
        setStep(2);
      }
    } else {
      setApp({ ...defaultApp });
      setStep(2);
    }
  };

  const handleSave = async () => {
    if (!app.id) {
      setError('App ID is required');
      return;
    }
    try {
      setLoading(true);
      const res = await fetch('/api/admin/apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(app)
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save app');
      }
      navigate('/admin/apps');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const updateField = (field, value) => {
    setApp(prev => ({ ...prev, [field]: value }));
  };

  if (step === 1) {
    return (
      <div className="max-w-2xl mx-auto p-6 space-y-4">
        <h1 className="text-2xl font-semibold">{t('admin.apps.wizard.title', 'Create App Wizard')}</h1>
        {error && <div className="text-red-600">{error}</div>}
        <div>
          <label className="block font-medium mb-1">{t('admin.apps.wizard.mode', 'How would you like to start?')}</label>
          <select value={mode} onChange={e => setMode(e.target.value)} className="border p-2 rounded w-full">
            <option value="blank">{t('admin.apps.wizard.blank', 'Start from scratch')}</option>
            <option value="clone">{t('admin.apps.wizard.clone', 'Clone existing app')}</option>
            <option value="ai">{t('admin.apps.wizard.ai', 'Use AI generator')}</option>
          </select>
        </div>
        {mode === 'clone' && (
          <div>
            <label className="block font-medium mb-1">{t('admin.apps.wizard.selectParent', 'Select parent app')}</label>
            <select value={parentId} onChange={e => setParentId(e.target.value)} className="border p-2 rounded w-full">
              <option value="">{t('admin.apps.wizard.choose', 'Choose...')}</option>
              {apps.filter(a => a.allowInheritance !== false).map(a => (
                <option key={a.id} value={a.id}>{a.id}</option>
              ))}
            </select>
          </div>
        )}
        {mode === 'ai' && (
          <div>
            <label className="block font-medium mb-1">{t('admin.apps.wizard.description', 'Describe the app')}</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} className="border p-2 rounded w-full" rows="3" />
          </div>
        )}
        <button onClick={start} className="mt-4 px-4 py-2 bg-indigo-600 text-white rounded" disabled={loading}>
          {t('admin.apps.wizard.next', 'Next')}
        </button>
      </div>
    );
  }

  if (!app) return null;

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-4">
      <h1 className="text-2xl font-semibold">{t('admin.apps.wizard.configure', 'Configure App')}</h1>
      {error && <div className="text-red-600">{error}</div>}
      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium mb-1">ID</label>
          <input type="text" value={app.id} onChange={e => updateField('id', e.target.value)} className="border p-2 rounded w-full" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">{t('admin.apps.name', 'Name')}</label>
          <DynamicLanguageEditor value={app.name} onChange={val => updateField('name', val)} currentLanguage={i18n.language} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">{t('admin.apps.description', 'Description')}</label>
          <DynamicLanguageEditor value={app.description} onChange={val => updateField('description', val)} currentLanguage={i18n.language} />
        </div>
      </div>
      <div className="flex space-x-2 pt-4">
        <button onClick={() => setStep(1)} className="px-4 py-2 rounded border">{t('back', 'Back')}</button>
        <button onClick={handleSave} className="px-4 py-2 bg-indigo-600 text-white rounded" disabled={loading}>{t('save', 'Save')}</button>
      </div>
    </div>
  );
};

export default AdminAppWizardPage;
