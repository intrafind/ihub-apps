/**
 * EU AI Act in the admin editors (issue #2565):
 * - pure helpers in client/src/features/admin/utils/aiTransparencyAdmin.js
 *   (download stripping, record merge, save cleanup, unmarked-model gate,
 *   contentMarking form model)
 * - the shared JustificationDialog
 * - the models list: "Not marked" badge and the 409 → justification → retry flow
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom';
import {
  buildImageWatermark,
  buildTextWatermark,
  cleanAppAiTransparencyForSave,
  getModelMarkingFlag,
  getUnmarkedModelError,
  isForeignRecord,
  mergeAppAiTransparencyRecords,
  parseImageWatermark,
  parseTextWatermark,
  serializeConfigForDownload,
  updateContentMarking
} from '../../../client/src/features/admin/utils/aiTransparencyAdmin';

jest.mock('react-i18next', () => {
  const translate = (key, defaultValue, opts) => {
    let str = typeof defaultValue === 'string' ? defaultValue : key;
    if (opts && typeof str === 'string') {
      for (const [k, v] of Object.entries(opts)) {
        str = str.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
      }
    }
    return str;
  };
  return { useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) };
});

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

const mockMakeAdminApiCall = jest.fn();
const mockToggleModel = jest.fn();
const mockToggleModels = jest.fn();
jest.mock('../../../client/src/api/adminApi', () => ({
  makeAdminApiCall: (...args) => mockMakeAdminApiCall(...args),
  toggleModel: (...args) => mockToggleModel(...args),
  toggleModels: (...args) => mockToggleModels(...args),
  getAdminApiErrorMessage: err => err?.response?.data?.error || err?.message || 'failed'
}));

jest.mock('../../../client/src/shared/components/ModelDetailsPopup', () => ({
  __esModule: true,
  default: () => null
}));

const JustificationDialog =
  require('../../../client/src/shared/components/JustificationDialog').default;
const AdminModelsPage = require('../../../client/src/features/admin/pages/AdminModelsPage').default;

const OPT_OUT = {
  disabledBy: 'admin',
  disabledAt: '2026-09-28T09:12:00Z',
  reason: 'Internal assistant for trained staff only',
  installationId: 'inst-a'
};
const EXEMPTION = {
  type: 'standardEditing',
  justification: 'Translation app only',
  declaredBy: 'admin',
  declaredAt: '2026-09-28T09:12:00Z',
  installationId: 'inst-a'
};
const ACK = {
  acknowledgedBy: 'admin',
  acknowledgedAt: '2026-09-28T09:12:00Z',
  justification: 'Needed until the watermarked model is ready',
  installationId: 'inst-a'
};

describe('config downloads never carry installation records', () => {
  test('an app download drops the opt-out and the exemption, keeps plain settings', () => {
    const app = {
      id: 'chat',
      aiTransparency: { disclosureOptOut: OPT_OUT, exemption: EXEMPTION, sensitive: 'legal' }
    };
    const downloaded = JSON.parse(serializeConfigForDownload('app', app));
    expect(downloaded).toEqual({ id: 'chat', aiTransparency: { sensitive: 'legal' } });
    // the editor's copy is untouched
    expect(app.aiTransparency.disclosureOptOut).toBe(OPT_OUT);
  });

  test('an app whose block only held records loses the block', () => {
    const downloaded = JSON.parse(
      serializeConfigForDownload('app', { id: 'x', aiTransparency: { disclosureOptOut: OPT_OUT } })
    );
    expect(downloaded).toEqual({ id: 'x' });
  });

  test('a model download drops the acknowledgement, keeps the marking', () => {
    const model = {
      id: 'gpt',
      contentMarking: { textWatermark: 'none', notes: 'n', acknowledgement: ACK }
    };
    expect(JSON.parse(serializeConfigForDownload('model', model))).toEqual({
      id: 'gpt',
      contentMarking: { textWatermark: 'none', notes: 'n' }
    });
  });
});

describe('app records and save', () => {
  test('records from the endpoints are merged in or removed', () => {
    const app = { id: 'chat', name: { en: 'Edited' }, aiTransparency: { sensitive: 'health' } };
    const withOptOut = mergeAppAiTransparencyRecords(app, {
      disclosureOptOut: OPT_OUT,
      exemption: null
    });
    expect(withOptOut).toEqual({
      id: 'chat',
      name: { en: 'Edited' },
      aiTransparency: { sensitive: 'health', disclosureOptOut: OPT_OUT }
    });
    const cleared = mergeAppAiTransparencyRecords(
      { id: 'chat', aiTransparency: { disclosureOptOut: OPT_OUT } },
      { disclosureOptOut: null }
    );
    expect(cleared).toEqual({ id: 'chat' });
    // undefined leaves a record alone
    expect(
      mergeAppAiTransparencyRecords(withOptOut, { exemption: undefined }).aiTransparency
    ).toEqual(withOptOut.aiTransparency);
  });

  test('the generic save sends no records and no empty notice languages', () => {
    const cleaned = cleanAppAiTransparencyForSave({
      id: 'chat',
      aiTransparency: {
        disclosureOptOut: OPT_OUT,
        exemption: EXEMPTION,
        firstTurnNotice: { en: 'AI here', de: '  ' },
        signpost: {},
        reminderInterval: 3
      }
    });
    expect(cleaned).toEqual({
      id: 'chat',
      aiTransparency: { firstTurnNotice: { en: 'AI here' }, reminderInterval: 3 }
    });
    expect(
      cleanAppAiTransparencyForSave({ id: 'x', aiTransparency: { firstTurnNotice: { en: '' } } })
    ).toEqual({ id: 'x' });
  });

  test('records of another installation are recognised', () => {
    expect(isForeignRecord(OPT_OUT, 'inst-b')).toBe(true);
    expect(isForeignRecord(OPT_OUT, 'inst-a')).toBe(false);
    expect(isForeignRecord(OPT_OUT, null)).toBe(false);
  });
});

describe('unmarked models', () => {
  test('the 409 gate is recognised, other errors are not', () => {
    const gate = {
      response: {
        status: 409,
        data: { code: 'UNMARKED_MODEL_ACKNOWLEDGEMENT_REQUIRED', models: ['a'], error: 'Needs' }
      }
    };
    expect(getUnmarkedModelError(gate)).toEqual({ models: ['a'], message: 'Needs' });
    expect(getUnmarkedModelError({ response: { status: 409, data: {} } })).toBeNull();
    expect(getUnmarkedModelError(new Error('x'))).toBeNull();
  });

  test('flag: unmarked chat models, acknowledged ones stay flagged, others not', () => {
    expect(getModelMarkingFlag({ id: 'a' })).toEqual({ acknowledged: false });
    expect(
      getModelMarkingFlag({
        id: 'a',
        contentMarking: { textWatermark: 'none', acknowledgement: ACK }
      })
    ).toEqual({ acknowledged: true });
    expect(
      getModelMarkingFlag({ id: 'a', contentMarking: { textWatermark: 'upstream:google' } })
    ).toBeNull();
    expect(
      getModelMarkingFlag({ id: 'a', contentMarking: { textWatermark: { scheme: 'vllm-gumbel' } } })
    ).toBeNull();
    expect(getModelMarkingFlag({ id: 't', modelType: 'transcription' })).toBeNull();
  });
});

describe('contentMarking form model', () => {
  test('text watermark round-trips through the form state', () => {
    expect(parseTextWatermark(undefined)).toEqual({
      mode: 'none',
      vendor: '',
      keyGroup: '',
      perRequest: false
    });
    expect(parseTextWatermark('upstream:mistral')).toMatchObject({
      mode: 'upstream',
      vendor: 'mistral'
    });
    const vllm = { scheme: 'vllm-gumbel', keyGroup: 'prod', perRequest: true };
    expect(buildTextWatermark(parseTextWatermark(vllm))).toEqual(vllm);
    expect(buildTextWatermark({ mode: 'vllm', keyGroup: ' ', perRequest: false })).toEqual({
      scheme: 'vllm-gumbel'
    });
    expect(buildTextWatermark({ mode: 'upstream', vendor: 'google' })).toBe('upstream:google');
    expect(buildTextWatermark({ mode: 'none' })).toBe('none');
  });

  test('image watermark and the block update', () => {
    expect(parseImageWatermark('upstream:synthid')).toEqual({
      mode: 'upstream',
      technique: 'synthid'
    });
    expect(buildImageWatermark({ mode: 'none', technique: 'x' })).toBe('none');
    const next = updateContentMarking({ acknowledgement: ACK }, 'notes', 'Vendor docs');
    expect(next).toEqual({ acknowledgement: ACK, textWatermark: 'none', notes: 'Vendor docs' });
    expect(updateContentMarking(next, 'notes', '')).not.toHaveProperty('notes');
  });
});

describe('JustificationDialog', () => {
  test('insists on the minimum length, then confirms with the trimmed text', async () => {
    const onConfirm = jest.fn(() => Promise.resolve());
    render(
      <JustificationDialog
        isOpen
        title="Switch off?"
        description="Explain why."
        confirmLabel="Switch off"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />
    );
    const dialog = screen.getByRole('dialog', { name: 'Switch off?' });
    const field = within(dialog).getByLabelText(/Justification/);
    expect(field).toHaveFocus();

    fireEvent.change(field, { target: { value: 'too short' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Switch off' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(
      within(dialog).getByText('Please give a justification of at least 10 characters.')
    ).toBeInTheDocument();

    fireEvent.change(field, { target: { value: '  Internal staff only, trained  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Switch off' }));
    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith('Internal staff only, trained', null)
    );
  });

  test('requires a choice when choices are offered and shows a failed save', async () => {
    const onConfirm = jest.fn(() =>
      Promise.reject({ response: { data: { error: 'Server said no' } } })
    );
    render(
      <JustificationDialog
        isOpen
        title="Exemption"
        description="Pick one."
        choices={[
          { value: 'standardEditing', label: 'Standard editing' },
          { value: 'b2bTechnical', label: 'Technical B2B output' }
        ]}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />
    );
    fireEvent.change(screen.getByLabelText(/Justification/), {
      target: { value: 'Translation only, no rewriting' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText('Please choose one option.')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Standard editing/));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith('Translation only, no rewriting', 'standardEditing')
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Server said no');
  });

  test('Escape cancels', () => {
    const onCancel = jest.fn();
    render(
      <JustificationDialog
        isOpen
        title="T"
        description="D"
        onConfirm={jest.fn()}
        onCancel={onCancel}
      />
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('AdminModelsPage — unmarked models', () => {
  const MODELS = [
    { id: 'cloud', name: { en: 'Cloud' }, provider: 'openai', enabled: false },
    {
      id: 'acked',
      name: { en: 'Acked' },
      provider: 'openai',
      enabled: true,
      contentMarking: { textWatermark: 'none', acknowledgement: ACK }
    },
    {
      id: 'vllm',
      name: { en: 'vLLM' },
      provider: 'openai',
      enabled: true,
      contentMarking: { textWatermark: { scheme: 'vllm-gumbel', keyGroup: 'default' } }
    },
    { id: 'whisper', name: { en: 'Whisper' }, modelType: 'transcription', enabled: true }
  ];

  beforeEach(() => {
    mockMakeAdminApiCall.mockReset();
    mockToggleModel.mockReset();
    mockToggleModels.mockReset();
    mockMakeAdminApiCall.mockImplementation(url =>
      url === '/admin/models' ? Promise.resolve({ data: MODELS }) : Promise.resolve({ data: {} })
    );
  });

  const renderPage = () =>
    render(
      <MemoryRouter>
        <AdminModelsPage />
      </MemoryRouter>
    );

  test('flags chat models that do not mark text, acknowledged or not', async () => {
    renderPage();
    expect(await screen.findByText('Not marked')).toBeInTheDocument();
    expect(screen.getByText('Not marked · acknowledged')).toBeInTheDocument();
    // one plain + one acknowledged: the vLLM and the transcription model get none
    expect(screen.getAllByText(/^Not marked/)).toHaveLength(2);
  });

  test('enabling an unmarked model asks for a justification and retries with it', async () => {
    const gate = Object.assign(new Error('409'), {
      response: {
        status: 409,
        data: { code: 'UNMARKED_MODEL_ACKNOWLEDGEMENT_REQUIRED', models: ['cloud'] }
      }
    });
    mockToggleModel
      .mockImplementationOnce(() => Promise.reject(gate))
      .mockImplementationOnce(() => Promise.resolve({ enabled: true }));
    renderPage();
    await screen.findByText('Not marked');

    fireEvent.click(screen.getAllByRole('button', { name: 'Toggle enabled' })[0]);
    const dialog = await screen.findByRole('dialog', {
      name: 'Enable a model that does not mark its output?'
    });
    expect(within(dialog).getByText('cloud')).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText(/Justification/), {
      target: { value: 'Legal team needs it until Q1' }
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enable anyway' }));

    await waitFor(() =>
      expect(mockToggleModel).toHaveBeenLastCalledWith('cloud', 'Legal team needs it until Q1')
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockToggleModel.mock.calls[0]).toEqual(['cloud', undefined]);
  });

  test('bulk enable goes through the same gate', async () => {
    const gate = {
      response: {
        status: 409,
        data: { code: 'UNMARKED_MODEL_ACKNOWLEDGEMENT_REQUIRED', models: ['cloud'] }
      }
    };
    mockToggleModels
      .mockImplementationOnce(() => Promise.reject(gate))
      .mockImplementationOnce(() => Promise.resolve({}));
    renderPage();
    await screen.findByText('Not marked');

    fireEvent.click(screen.getByRole('button', { name: 'Enable All' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Justification/), {
      target: { value: 'Evaluation week, documented in ticket 42' }
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enable anyway' }));
    await waitFor(() =>
      expect(mockToggleModels).toHaveBeenLastCalledWith(
        '*',
        true,
        'Evaluation week, documented in ticket 42'
      )
    );
  });
});

let mockUser = { id: 'admin', isAdmin: true };
jest.mock('../../../client/src/shared/contexts/AuthContext', () => ({
  useAuth: () => ({ user: mockUser })
}));
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () => ({
  usePlatformConfig: () => ({
    platformConfig: {
      aiTransparency: {
        interactionDisclosure: { enabled: true, reminderInterval: 5 },
        text: { signpost: { exports: true, clipboard: false } }
      }
    }
  })
}));

describe('App editor — EU AI Act section', () => {
  const AiTransparencySection =
    require('../../../client/src/features/admin/components/app-form/AiTransparencySection').default;

  beforeEach(() => {
    mockUser = { id: 'admin', isAdmin: true };
    mockMakeAdminApiCall.mockReset();
    mockMakeAdminApiCall.mockImplementation(() => Promise.resolve({ data: {} }));
  });

  test('an admin switches the disclosure off with a reason; the stored records are merged', async () => {
    const stored = { ...OPT_OUT, installationId: 'inst-a' };
    mockMakeAdminApiCall.mockImplementation((url, options = {}) => {
      if (url === '/admin/ai-transparency/settings') {
        return Promise.resolve({ data: { installation: { installationId: 'inst-a' } } });
      }
      if (options.method === 'PUT') {
        return Promise.resolve({ data: { disclosureOptOut: stored } });
      }
      return Promise.resolve({
        data: { id: 'chat', aiTransparency: { disclosureOptOut: stored } }
      });
    });
    const onRecordsChange = jest.fn();
    render(
      <AiTransparencySection
        app={{ id: 'chat' }}
        onChange={jest.fn()}
        appId="chat"
        onRecordsChange={onRecordsChange}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Switch off disclosure…' }));
    const dialog = screen.getByRole('dialog', {
      name: 'Switch off the AI disclosure for this app?'
    });
    expect(dialog).toHaveTextContent('¶45');
    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: 'Internal assistant for trained staff only' }
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Switch off disclosure' }));

    await waitFor(() =>
      expect(onRecordsChange).toHaveBeenCalledWith({ disclosureOptOut: stored, exemption: null })
    );
    expect(mockMakeAdminApiCall).toHaveBeenCalledWith(
      '/admin/ai-transparency/apps/chat/disclosure-opt-out',
      { method: 'PUT', body: { reason: 'Internal assistant for trained staff only' } }
    );
  });

  test('a content admin sees the record read-only', () => {
    mockUser = { id: 'editor', permissions: { contentAdmin: true } };
    render(
      <AiTransparencySection
        app={{ id: 'chat', aiTransparency: { disclosureOptOut: OPT_OUT } }}
        onChange={jest.fn()}
        appId="chat"
      />
    );
    expect(screen.getByText('Off for this app')).toBeInTheDocument();
    expect(screen.getByText('Internal assistant for trained staff only')).toBeInTheDocument();
    expect(
      screen.getByText('Only administrators can switch off the disclosure or declare an exemption.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Switch back on/ })).not.toBeInTheDocument();
    expect(mockMakeAdminApiCall).not.toHaveBeenCalled();
  });

  test('plain settings change the app block that is saved with the app', () => {
    const onChange = jest.fn();
    render(<AiTransparencySection app={{ id: 'chat' }} onChange={onChange} appId="chat" />);
    fireEvent.change(screen.getByLabelText('Sensitive context'), { target: { value: 'finance' } });
    expect(onChange).toHaveBeenLastCalledWith({
      id: 'chat',
      aiTransparency: { sensitive: 'finance' }
    });
    fireEvent.change(screen.getByLabelText('Text signpost when copying'), {
      target: { value: 'on' }
    });
    expect(onChange).toHaveBeenLastCalledWith({
      id: 'chat',
      aiTransparency: { signpost: { clipboard: true } }
    });
  });
});
