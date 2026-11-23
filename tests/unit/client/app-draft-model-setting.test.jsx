// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The model for app drafts (`platform.appGenerator.modelId`): the select under
 * "App Drafts with AI" on Admin → Features, what it offers, and what the page
 * saves.
 */

import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockT = (key, options) => {
  if (typeof options === 'string') return options;
  if (options && typeof options === 'object') {
    return String(options.defaultValue ?? key).replace('{{model}}', String(options.model ?? ''));
  }
  return key;
};
jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } })
}));

const mockAdminApi = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  __esModule: true,
  makeAdminApiCall: (...args) => mockAdminApi(...args)
}));
const mockRefreshConfig = jest.fn();
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  __esModule: true,
  usePlatformConfig: () => ({ refreshConfig: mockRefreshConfig })
}));
jest.mock('../../../client/src/features/admin/hooks/useUnsavedChanges', () => ({
  __esModule: true,
  useUnsavedChanges: () => ({ blocker: null })
}));
jest.mock('../../../client/src/features/admin/components/UnsavedChangesDialog', () => ({
  __esModule: true,
  default: () => null
}));

import AppDraftModelSetting from '../../../client/src/features/admin/components/AppDraftModelSetting';
import AdminFeaturesPage from '../../../client/src/features/admin/pages/AdminFeaturesPage';
import {
  draftModelChoices,
  pickDraftModel
} from '../../../client/src/features/admin/components/app-create/createFlow';

const MODELS = [
  { id: 'image', name: { en: 'Image' }, supportsImageGeneration: true, default: true },
  { id: 'big', name: { en: 'Big model' }, default: true, enabled: true },
  { id: 'small', name: { en: 'Small model' }, enabled: true },
  { id: 'off', name: { en: 'Switched off' }, enabled: false },
  { id: 'voice', name: { en: 'Voice' }, modelType: 'transcription', enabled: true }
];

const optionTexts = () =>
  Array.from(screen.getByLabelText('Model for drafts').querySelectorAll('option')).map(
    option => option.textContent
  );

describe('draftModelChoices', () => {
  it('offers the enabled models that can draft, and names the automatic choice', () => {
    const { options, automatic } = draftModelChoices(MODELS);
    expect(options.map(model => model.id)).toEqual(['big', 'small']);
    expect(automatic.id).toBe('big');
    expect(draftModelChoices(null)).toEqual({ options: [], automatic: null });
  });
});

describe('pickDraftModel with a configured model', () => {
  it('takes the configured model when the list holds it, else the automatic choice', () => {
    const list = MODELS.filter(model => model.enabled !== false);
    expect(pickDraftModel(list, 'small').id).toBe('small');
    // Not in the caller's list (not allowed for them), or not able to draft.
    expect(pickDraftModel(list, 'missing').id).toBe('big');
    expect(pickDraftModel(list, 'voice').id).toBe('big');
    expect(pickDraftModel(list, '').id).toBe('big');
  });
});

describe('AppDraftModelSetting', () => {
  it('offers the automatic choice first, with the model it picks, then the chat models', () => {
    render(<AppDraftModelSetting value="" onChange={() => {}} models={MODELS} />);
    expect(optionTexts()).toEqual([
      'Automatic (recommended): currently Big model',
      'Big model',
      'Small model'
    ]);
    expect(screen.getByLabelText('Model for drafts')).toHaveValue('');
  });

  it('reports the chosen model ID', () => {
    const onChange = jest.fn();
    render(<AppDraftModelSetting value="" onChange={onChange} models={MODELS} />);
    fireEvent.change(screen.getByLabelText('Model for drafts'), { target: { value: 'small' } });
    expect(onChange).toHaveBeenCalledWith('small');
  });

  it('keeps a stored model that is no longer available, and says drafts use the automatic choice', () => {
    render(<AppDraftModelSetting value="off" onChange={() => {}} models={MODELS} />);
    expect(screen.getByLabelText('Model for drafts')).toHaveValue('off');
    expect(optionTexts()).toContain('off (not available)');
    expect(screen.getByRole('status')).toHaveTextContent(/automatic choice/);
  });

  it('says only "Automatic" when no model can draft, and can be disabled', () => {
    render(<AppDraftModelSetting value="" onChange={() => {}} models={[]} disabled />);
    expect(optionTexts()).toEqual(['Automatic (recommended)']);
    expect(screen.getByLabelText('Model for drafts')).toBeDisabled();
  });
});

describe('Admin → Features saves the draft model', () => {
  const FEATURES = {
    items: [
      {
        id: 'appGenerator',
        name: { en: 'App Drafts with AI' },
        description: { en: 'Drafts' },
        category: 'content',
        enabled: true
      }
    ],
    categories: { content: { name: { en: 'Content' }, order: 1 } }
  };

  beforeEach(() => {
    mockRefreshConfig.mockReset();
    mockAdminApi.mockReset();
    mockAdminApi.mockImplementation(async (url, options = {}) => {
      if (url === '/admin/features') return { data: FEATURES };
      if (url === '/admin/configs/platform' && options.method === 'GET') {
        return { data: { appGenerator: { modelId: 'small' } } };
      }
      if (url === '/admin/models') return { data: { items: MODELS } };
      return { data: {} };
    });
  });

  it('shows the stored model and saves a change as a scoped merge patch', async () => {
    render(<AdminFeaturesPage />);
    const select = await screen.findByLabelText('Model for drafts');
    expect(select).toHaveValue('small');

    fireEvent.change(select, { target: { value: 'big' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(mockAdminApi).toHaveBeenCalledWith('/admin/configs/platform', {
        method: 'PATCH',
        body: { appGenerator: { modelId: 'big' } }
      })
    );
    // No feature switch changed: the feature flags are not written.
    expect(mockAdminApi).not.toHaveBeenCalledWith(
      '/admin/features',
      expect.objectContaining({ method: 'PUT' })
    );
  });

  it('removes the setting for the automatic choice', async () => {
    render(<AdminFeaturesPage />);
    fireEvent.change(await screen.findByLabelText('Model for drafts'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() =>
      expect(mockAdminApi).toHaveBeenCalledWith('/admin/configs/platform', {
        method: 'PATCH',
        body: { appGenerator: { modelId: null } }
      })
    );
  });

  it('re-reads the shared configuration when the switches saved and the model did not', async () => {
    const load = mockAdminApi.getMockImplementation();
    mockAdminApi.mockImplementation(async (url, options = {}) => {
      if (url === '/admin/configs/platform' && options.method === 'PATCH') {
        throw new Error('refused');
      }
      return load(url, options);
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    render(<AdminFeaturesPage />);
    const select = await screen.findByLabelText('Model for drafts');
    fireEvent.click(screen.getByRole('switch', { name: 'App Drafts with AI' }));
    fireEvent.change(select, { target: { value: 'big' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await screen.findByText('Failed to save features');
    expect(mockAdminApi).toHaveBeenCalledWith('/admin/features', {
      method: 'PUT',
      body: { appGenerator: false }
    });
    // The switches were written: the feature map everyone reads is refreshed.
    expect(mockRefreshConfig).toHaveBeenCalled();
    // The refused model change stays unsaved and can be saved again.
    expect(select).toHaveValue('big');
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled();
    console.error.mockRestore();
  });

  it('shows no select when the setting could not be loaded', async () => {
    mockAdminApi.mockImplementation(async url => {
      if (url === '/admin/features') return { data: FEATURES };
      throw new Error('forbidden');
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    render(<AdminFeaturesPage />);
    await screen.findByText('App Drafts with AI');
    expect(screen.queryByLabelText('Model for drafts')).not.toBeInTheDocument();
    console.error.mockRestore();
  });
});
