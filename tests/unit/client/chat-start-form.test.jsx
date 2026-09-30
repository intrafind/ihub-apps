import '@testing-library/jest-dom';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

/**
 * The start form itself (issue #2629): besides the app's variables it always
 * has the message field the chat input would take, and — when the app lets
 * users pick the model — the model selector next to its send button, with the
 * selected model's hint as in the chat input.
 */

jest.mock('react-i18next', () => ({
  __esModule: true,
  useTranslation: () => ({
    t: (key, def) => (typeof def === 'string' ? def : key),
    i18n: { language: 'en' }
  })
}));
jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));
// Uploads are off here; the drop zone has suites of its own.
jest.mock('../../../client/src/features/upload/components/UnifiedUploader', () => ({
  __esModule: true,
  default: ({ children }) => children
}));
jest.mock('../../../client/src/features/upload/components/AttachedFilesList', () => ({
  __esModule: true,
  default: () => null
}));

const ChatStartForm = require('../../../client/src/features/chat/components/ChatStartForm').default;
const { localizeVariables } = require('../../../client/src/features/chat/utils/startForm');

const APP = {
  id: 'translator',
  prompt: { en: 'Translate into {{language}}.\n\n{{content}}' },
  variables: [{ name: 'language', label: { en: 'Language' }, type: 'string', required: true }],
  startForm: { enabled: true }
};

const MODELS = [
  { id: 'fast', name: { en: 'Fast' } },
  { id: 'careful', name: { en: 'Careful' } }
];

/** The form with its state held the way AppChat and the Office panel hold it. */
function Harness({ app = APP, models = MODELS, showModelSelector = true, onSubmit, onModel }) {
  const [variables, setVariables] = useState({ language: 'German' });
  const [message, setMessage] = useState('');
  const [selectedModel, setSelectedModel] = useState(models?.[0]?.id ?? null);
  return (
    <>
      <ChatStartForm
        app={app}
        localizedVariables={localizeVariables(app.variables, 'en')}
        variables={variables}
        onVariablesChange={setVariables}
        message={message}
        onMessageChange={setMessage}
        uploadConfig={{ localUploadEnabled: false }}
        selectedFile={null}
        onFileSelect={() => {}}
        onSubmit={onSubmit}
        models={models}
        selectedModel={selectedModel}
        onModelChange={id => {
          setSelectedModel(id);
          onModel?.(id);
        }}
        showModelSelector={showModelSelector}
        currentLanguage="en"
      />
      <output data-testid="message">{message}</output>
    </>
  );
}

const sendButton = () => screen.getByRole('button', { name: 'Start' });

describe('the message field', () => {
  test('is there without any prefilled text, with the default placeholder', () => {
    render(<Harness onSubmit={jest.fn()} />);

    const field = screen.getByLabelText('Message');
    expect(field).toHaveValue('');
    expect(field).toHaveAttribute('placeholder', 'Type your message here...');

    fireEvent.change(field, { target: { value: 'Guten Morgen' } });
    expect(screen.getByTestId('message')).toHaveTextContent('Guten Morgen');
  });

  test("uses the app's message placeholder", () => {
    const app = { ...APP, messagePlaceholder: { en: 'Text to translate' } };
    render(<Harness app={app} onSubmit={jest.fn()} />);

    expect(screen.getByLabelText('Message')).toHaveAttribute('placeholder', 'Text to translate');
  });

  test('stays when its text is cleared', () => {
    render(<Harness onSubmit={jest.fn()} />);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hi' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: '' } });

    expect(screen.getByLabelText('Message')).toBeInTheDocument();
  });
});

describe('model selection', () => {
  test('offers the models next to the send button and takes the pick', () => {
    const onModel = jest.fn();
    render(<Harness onSubmit={jest.fn()} onModel={onModel} />);

    fireEvent.click(screen.getByRole('button', { name: 'Fast' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Careful' }));

    expect(onModel).toHaveBeenCalledWith('careful');
    expect(screen.getByRole('button', { name: 'Careful' })).toBeInTheDocument();
  });

  test('opening the selector does not send the form', () => {
    const onSubmit = jest.fn();
    render(<Harness onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Fast' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Careful' }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('is not offered when the app does not let users pick the model', () => {
    render(<Harness showModelSelector={false} onSubmit={jest.fn()} />);

    expect(screen.queryByRole('button', { name: 'Fast' })).toBeNull();
  });

  test('is not offered without models, as in compare mode', () => {
    render(<Harness models={null} onSubmit={jest.fn()} />);

    expect(screen.queryByRole('button', { name: 'Fast' })).toBeNull();
    expect(sendButton()).toBeEnabled();
  });
});

describe("the selected model's hint", () => {
  const ALERT_MODELS = [
    { id: 'fast', name: { en: 'Fast' } },
    {
      id: 'beta',
      name: { en: 'Beta' },
      hint: { level: 'alert', message: { en: 'Experimental model' } }
    },
    {
      id: 'labs',
      name: { en: 'Labs' },
      hint: { level: 'alert', message: { en: 'Also experimental' } }
    }
  ];

  const pick = (from, to) => {
    fireEvent.click(screen.getByRole('button', { name: from }));
    fireEvent.click(screen.getByRole('menuitem', { name: to }));
  };

  test('an alert blocks sending until it is acknowledged', () => {
    const onSubmit = jest.fn();
    render(<Harness models={ALERT_MODELS} onSubmit={onSubmit} />);
    expect(sendButton()).toBeEnabled();

    pick('Fast', 'Beta');
    expect(screen.getByText('Experimental model')).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
    fireEvent.submit(screen.getByTestId('start-form'));
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'I Understand' }));
    expect(screen.queryByText('Experimental model')).toBeNull();
    expect(sendButton()).toBeEnabled();
    fireEvent.submit(screen.getByTestId('start-form'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('another model with an alert asks again', () => {
    render(<Harness models={ALERT_MODELS} onSubmit={jest.fn()} />);
    pick('Fast', 'Beta');
    fireEvent.click(screen.getByRole('button', { name: 'I Understand' }));

    pick('Beta', 'Labs');
    expect(screen.getByText('Also experimental')).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
  });

  test('shows even when the model cannot be changed', () => {
    const models = [ALERT_MODELS[1]];
    render(<Harness models={models} showModelSelector={false} onSubmit={jest.fn()} />);

    expect(screen.getByText('Experimental model')).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
  });
});
