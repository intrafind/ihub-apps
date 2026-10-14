import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import WorkflowChatIntegrationSection from '../../../client/src/features/admin/components/WorkflowChatIntegrationSection';

/**
 * The explanation under "Result shown in chat" says what Automatic shows for
 * the workflow being edited, in the output format chosen for it.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, options) => {
      const text = typeof fallback === 'string' ? fallback : fallback?.defaultValue || key;
      const values = typeof fallback === 'object' ? fallback : options || {};
      return Object.entries(values).reduce(
        (out, [name, value]) => out.replaceAll(`{{${name}}}`, value),
        text
      );
    },
    i18n: { language: 'en' }
  })
}));

jest.mock('../../../client/src/shared/components/Icon', () => ({
  __esModule: true,
  default: () => null
}));

jest.mock('../../../client/src/shared/components/DynamicLanguageEditor', () => ({
  __esModule: true,
  default: () => null
}));

const node = (id, type, config = {}) => ({
  id,
  type,
  name: { en: id },
  position: { x: 0, y: 0 },
  config
});

function workflow({ outputVariables, outputFormat }) {
  return {
    id: 'rule-check',
    chatIntegration: { enabled: true, ...(outputFormat ? { outputFormat } : {}) },
    nodes: [
      node('start', 'start', { inputVariables: [{ name: 'input', type: 'textarea' }] }),
      node('check', 'prompt', { outputVariable: 'bericht' }),
      node('fix', 'prompt', { outputVariable: 'corrected_text' }),
      node('end', 'end', { outputVariables })
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'check' },
      { id: 'e2', source: 'check', target: 'fix' },
      { id: 'e3', source: 'fix', target: 'end' }
    ]
  };
}

const explanation = wf => {
  render(<WorkflowChatIntegrationSection workflow={wf} onChange={jest.fn()} />);
  return screen.getByText(/^Automatic /).textContent;
};

test('Markdown: one section per variable', () => {
  expect(explanation(workflow({ outputVariables: ['bericht', 'corrected_text'] }))).toContain(
    'the web chat shows each variable as a section'
  );
});

test('Text: one "name:" line per variable', () => {
  expect(
    explanation(workflow({ outputVariables: ['bericht', 'corrected_text'], outputFormat: 'text' }))
  ).toContain('as a "name:" line');
});

test('JSON: the whole output as JSON', () => {
  expect(
    explanation(workflow({ outputVariables: ['bericht', 'corrected_text'], outputFormat: 'json' }))
  ).toContain('the chat shows the whole output as JSON');
});

test('a single variable is shown on its own', () => {
  expect(explanation(workflow({ outputVariables: ['corrected_text'] }))).toContain(
    'the web chat shows "corrected_text" on its own'
  );
});

test('an end step that formats its output as text is shown as it is', () => {
  const wf = workflow({ outputVariables: ['bericht', 'corrected_text'] });
  wf.nodes[3].config.outputFormat = 'text';
  render(<WorkflowChatIntegrationSection workflow={wf} onChange={jest.fn()} />);
  expect(
    screen.getByText(
      'The end step "end" formats its output as "text", so the chat shows that value as it is.'
    )
  ).toBeInTheDocument();
});

test('a conventionally named output is shown only when it is not empty', () => {
  const wf = workflow({ outputVariables: ['bericht'] });
  wf.nodes[3].config = { outputMapping: { report: '$.data.bericht' } };
  expect(explanation(wf)).toContain('"report" when it is not empty');
});

test('the settings are locked while the JSON editor holds invalid JSON', () => {
  const onChange = jest.fn();
  render(
    <WorkflowChatIntegrationSection
      workflow={workflow({ outputVariables: ['corrected_text'] })}
      onChange={onChange}
      disabled
    />
  );
  expect(screen.getByText('Fix the JSON below to change these settings.')).toBeInTheDocument();
  expect(screen.getByRole('switch')).toBeDisabled();
  expect(screen.getByLabelText('Result shown in chat')).toBeDisabled();
});
