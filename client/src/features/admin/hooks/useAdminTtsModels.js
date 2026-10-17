import { useEffect, useState } from 'react';
import { makeAdminApiCall } from '../../../api/adminApi';

/**
 * The enabled text-to-speech models (`modelType: 'tts'`), for the app editor's
 * voice mode picker. From the admin model list, not the public /api/models:
 * that one is filtered by the admin's own model permissions, and admin access
 * does not imply them.
 *
 * @returns {Array} Models; empty while loading or when the list fails.
 */
export default function useAdminTtsModels() {
  const [models, setModels] = useState([]);

  useEffect(() => {
    let active = true;
    makeAdminApiCall('/admin/models')
      .then(response => {
        if (!active) return;
        const all = Array.isArray(response?.data) ? response.data : [];
        setModels(all.filter(m => m.modelType === 'tts' && m.enabled !== false));
      })
      .catch(err => console.error('Failed to load text-to-speech models:', err));
    return () => {
      active = false;
    };
  }, []);

  return models;
}
