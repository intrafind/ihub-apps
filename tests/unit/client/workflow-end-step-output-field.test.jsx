import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ReactFlowProvider } from '@xyflow/react';
import EndForm from '../../../client/src/features/workflows/editor/panels/forms/EndForm';
import { WorkflowNode } from '../../../client/src/features/workflows/editor/nodes/WorkflowNode';

/**
 * Every end step has an Output: the answer of the workflow. The visual editor
 * asks for it first in the end step's form, suggests the variables that reach
 * the step, and says so on the step's card when it is missing.
 */

jest.mock('react-i18next', () => {
  const en = require('../../../shared/i18n/en.json');
  const lookup = key => key.split('.').reduce((node, part) => node?.[part], en);
  const translate = (key, fallback) => (typeof lookup(key) === 'string' ? lookup(key) : fallback);
  const translation = { t: translate, i18n: { language: 'en' } };
  return { useTranslation: () => translation };
});

const VARIABLES = [
  { value: 'finalReport', label: 'compose' },
  { value: 'summary', label: 'summarize' }
];

describe('the end step form', () => {
  it('asks for the output first, with the variables that reach the step as suggestions', () => {
    const { container } = render(<EndForm config={{}} onChange={() => {}} variables={VARIABLES} />);
    const input = screen.getByPlaceholderText('finalReport');
    expect(screen.getByText('Output')).toBeInTheDocument();
    // First field of the form, ahead of the additional information
    const fields = [...container.querySelectorAll('input')];
    expect(fields[0]).toBe(input);
    const options = [...container.querySelectorAll('datalist option')].map(o => o.value);
    expect(options).toEqual(['finalReport', 'summary']);
  });

  it('writes what is typed into the output and leaves the rest of the config alone', () => {
    const onChange = jest.fn();
    render(
      <EndForm
        config={{ outputVariables: ['topic'], includeMetadata: true }}
        onChange={onChange}
        variables={VARIABLES}
      />
    );
    fireEvent.change(screen.getByPlaceholderText('finalReport'), {
      target: { value: 'summary' }
    });
    expect(onChange).toHaveBeenCalledWith({
      outputVariables: ['topic'],
      includeMetadata: true,
      output: 'summary'
    });
  });

  it('shows what the output can be, and that everything else is additional', () => {
    render(<EndForm config={{ output: 'finalReport' }} onChange={() => {}} />);
    expect(screen.getByText(/JSON stays JSON/)).toBeInTheDocument();
    expect(screen.getByText(/Everything below is additional information/)).toBeInTheDocument();
  });

  it('says that an end step without an output cannot be saved', () => {
    const { rerender } = render(<EndForm config={{}} onChange={() => {}} />);
    expect(screen.getByText(/Every end step needs an output/)).toBeInTheDocument();
    rerender(<EndForm config={{ output: '   ' }} onChange={() => {}} />);
    expect(screen.getByText(/Every end step needs an output/)).toBeInTheDocument();
    rerender(<EndForm config={{ output: 'finalReport' }} onChange={() => {}} />);
    expect(screen.queryByText(/Every end step needs an output/)).not.toBeInTheDocument();
  });
});

describe('the end step card on the canvas', () => {
  const card = nodeConfig =>
    render(
      <ReactFlowProvider>
        <WorkflowNode
          data={{ nodeType: 'end', nodeId: 'end', nodeName: 'End', nodeConfig }}
          selected={false}
        />
      </ReactFlowProvider>
    );

  it('shows the output it gives the workflow', () => {
    card({ output: ' finalReport ' });
    expect(screen.getByText('→ finalReport')).toBeInTheDocument();
    expect(screen.queryByText('No output set')).not.toBeInTheDocument();
  });

  it('says so when there is none', () => {
    card({});
    expect(screen.getByText('No output set')).toBeInTheDocument();
  });
});
