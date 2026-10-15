import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import WorkflowChatIntegrationSection from '../../../client/src/features/admin/components/WorkflowChatIntegrationSection';

/**
 * The chat integration section of the workflow page. It sets whether the
 * workflow is offered in chat, how the answer is shown and what the model is
 * told. What the answer is needs no setting: it is the Output of the end step,
 * so there is no result to pick and nothing to explain about Automatic.
 */

jest.mock('react-i18next', () => {
  const en = require('../../../shared/i18n/en.json');
  const lookup = key => key.split('.').reduce((node, part) => node?.[part], en);
  const translate = (key, fallback, options) => {
    const text = typeof lookup(key) === 'string' ? lookup(key) : fallback;
    const values = typeof fallback === 'object' ? fallback : options || {};
    return Object.entries(values).reduce(
      (out, [name, value]) => out.replaceAll(`{{${name}}}`, value),
      typeof text === 'string' ? text : key
    );
  };
  return { useTranslation: () => ({ t: translate, i18n: { language: 'en' } }) };
});

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/shared/components/DynamicLanguageEditor', () => ({
  __esModule: true,
  default: ({ label }) => <div data-testid="tool-description">{label}</div>
}));

const node = (id, type, config = {}) => ({
  id,
  type,
  name: { en: id },
  position: { x: 0, y: 0 },
  config
});

const workflow = ({ endConfig = { output: 'finalReport' }, chatIntegration = {} } = {}) => ({
  id: 'rule-check',
  chatIntegration,
  nodes: [node('start', 'start'), node('end', 'end', endConfig)],
  edges: [{ id: 'e1', source: 'start', target: 'end' }]
});

describe('the chat integration section', () => {
  it('has the settings that are left: availability, output format and the model description', () => {
    render(<WorkflowChatIntegrationSection workflow={workflow()} onChange={() => {}} />);
    expect(screen.getByRole('switch', { name: 'Available in chat' })).toBeInTheDocument();
    expect(screen.getByLabelText('Output format')).toBeInTheDocument();
    expect(screen.getByTestId('tool-description')).toHaveTextContent('Description for the model');
  });

  it('has no result to pick and no Automatic: the answer is the output of the end step', () => {
    render(<WorkflowChatIntegrationSection workflow={workflow()} onChange={() => {}} />);
    expect(screen.queryByLabelText('Result shown in chat')).not.toBeInTheDocument();
    expect(screen.queryByText(/Automatic/)).not.toBeInTheDocument();
    expect(screen.getByText(/shows the Output of its end step as the answer/)).toBeInTheDocument();
  });

  it('switches availability through onChange', () => {
    const onChange = jest.fn();
    render(<WorkflowChatIntegrationSection workflow={workflow()} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Available in chat' }));
    expect(onChange).toHaveBeenCalledWith({ enabled: true });
  });

  it('sets the output format, and removes it for the default', () => {
    const onChange = jest.fn();
    render(
      <WorkflowChatIntegrationSection
        workflow={workflow({ chatIntegration: { enabled: true, outputFormat: 'text' } })}
        onChange={onChange}
      />
    );
    const select = screen.getByLabelText('Output format');
    expect(select).toHaveValue('text');
    fireEvent.change(select, { target: { value: 'json' } });
    expect(onChange).toHaveBeenLastCalledWith({ outputFormat: 'json' });
    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ outputFormat: undefined });
  });

  it('says that a JSON answer is always shown as JSON', () => {
    render(<WorkflowChatIntegrationSection workflow={workflow()} onChange={() => {}} />);
    expect(screen.getByText(/always shown as JSON/)).toBeInTheDocument();
  });

  it('warns about an end step without an output', () => {
    render(
      <WorkflowChatIntegrationSection workflow={workflow({ endConfig: {} })} onChange={() => {}} />
    );
    expect(
      screen.getByText(/The end step end has no output\. The workflow cannot be saved/)
    ).toBeInTheDocument();
  });

  it('warns about a workflow assigned to apps that is not available in chat', () => {
    render(
      <WorkflowChatIntegrationSection
        workflow={workflow()}
        onChange={() => {}}
        assignedApps={[{ id: 'chat' }]}
      />
    );
    expect(
      screen.getByText(/assigned to the apps chat, but it is not available/)
    ).toBeInTheDocument();
  });

  it('has no warning for a workflow that is set up', () => {
    render(
      <WorkflowChatIntegrationSection
        workflow={workflow({ chatIntegration: { enabled: true } })}
        onChange={() => {}}
        assignedApps={[{ id: 'chat' }]}
      />
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('is locked, with the reason, while the JSON editor holds invalid JSON', () => {
    render(<WorkflowChatIntegrationSection workflow={workflow()} onChange={() => {}} disabled />);
    expect(screen.getByText('Fix the JSON below to change these settings.')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Available in chat' })).toBeDisabled();
  });
});
