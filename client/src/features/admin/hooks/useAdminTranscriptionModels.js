import { useEffect, useState } from 'react';
import { makeAdminApiCall } from '../../../api/adminApi';

/**
 * The enabled transcription models (`modelType: 'transcription'`), for the
 * app editor's transcription and voice input pickers. From the admin model
 * list, not the public /api/models: that one is filtered by the admin's own
 * model permissions, and admin access does not imply them.
 *
 * @returns {Array} Models; empty while loading or when the list fails.
 */
export default function useAdminTranscriptionModels() {
  const [models, setModels] = useState([]);

  useEffect(() => {
    let active = true;
    makeAdminApiCall('/admin/models')
      .then(response => {
        if (!active) return;
        const all = Array.isArray(response?.data) ? response.data : [];
        setModels(all.filter(m => m.modelType === 'transcription' && m.enabled !== false));
      })
      .catch(err => console.error('Failed to load transcription models:', err));
    return () => {
      active = false;
    };
  }, []);

  return models;
}
