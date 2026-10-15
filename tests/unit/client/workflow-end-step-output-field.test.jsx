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

  it('names the output input by its visible label, for assistive technology', () => {
    render(<EndForm config={{}} onChange={() => {}} variables={VARIABLES} />);
    expect(screen.getByLabelText('Output')).toBe(screen.getByPlaceholderText('finalReport'));
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

describe('an output made of several fields', () => {
  const FIELDS = { topic: 'topic', report: 'finalReport' };
  const form = (output, onChange = () => {}) =>
    render(<EndForm config={{ output }} onChange={onChange} variables={VARIABLES} />);

  it('is chosen with the switch, seeded from the variable that was the output', () => {
    const onChange = jest.fn();
    form('finalReport', onChange);
    expect(screen.getByRole('button', { name: 'One value' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Several fields' }));
    expect(onChange).toHaveBeenCalledWith({ output: { finalReport: 'finalReport' } });
  });

  it('starts with an empty field when the output was not a plain variable name', () => {
    const onChange = jest.fn();
    form('{{summary}} and more', onChange);
    fireEvent.click(screen.getByRole('button', { name: 'Several fields' }));
    expect(onChange).toHaveBeenCalledWith({ output: { '': '' } });
  });

  it('goes back to one value, taking the first field', () => {
    const onChange = jest.fn();
    form(FIELDS, onChange);
    fireEvent.click(screen.getByRole('button', { name: 'One value' }));
    expect(onChange).toHaveBeenCalledWith({ output: 'topic' });
  });

  it('shows a name and a value for each field, with the variables as suggestions', () => {
    const { container } = form(FIELDS);
    expect(screen.getAllByLabelText('Field name').map(input => input.value)).toEqual([
      'topic',
      'report'
    ]);
    expect(screen.getAllByLabelText('Variable or text').map(input => input.value)).toEqual([
      'topic',
      'finalReport'
    ]);
    expect(screen.getByRole('button', { name: 'Several fields' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    const options = [...container.querySelectorAll('datalist option')].map(o => o.value);
    expect(options).toEqual(['finalReport', 'summary']);
    expect(screen.getByText(/The answer is a JSON object with these fields/)).toBeInTheDocument();
  });

  it('renames a field where it is once the name is left, and changes its value as it is typed', () => {
    const onChange = jest.fn();
    form(FIELDS, onChange);
    const name = screen.getAllByLabelText('Field name')[0];
    fireEvent.change(name, { target: { value: 'subject' } });
    // Not taken while it is being typed: the row would lose its focus with every key
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(name);
    expect(onChange).toHaveBeenLastCalledWith({
      output: { subject: 'topic', report: 'finalReport' }
    });
    expect(Object.keys(onChange.mock.calls[0][0].output)).toEqual(['subject', 'report']);
    fireEvent.change(screen.getAllByLabelText('Variable or text')[1], {
      target: { value: 'summary' }
    });
    expect(onChange).toHaveBeenLastCalledWith({ output: { topic: 'topic', report: 'summary' } });
  });

  it('takes a name when Enter is pressed as well', () => {
    const onChange = jest.fn();
    form(FIELDS, onChange);
    const name = screen.getAllByLabelText('Field name')[1];
    fireEvent.change(name, { target: { value: 'body' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith({ output: { topic: 'topic', body: 'finalReport' } });
  });

  it('does not take a name another field has, or one that reaches into the prototype', () => {
    const onChange = jest.fn();
    form(FIELDS, onChange);
    const name = screen.getAllByLabelText('Field name')[0];
    for (const value of ['report', '__proto__', 'constructor']) {
      fireEvent.change(name, { target: { value } });
      fireEvent.blur(name);
      // The name goes back to what it was
      expect(name).toHaveValue('topic');
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it('adds a field, but only one at a time while its name is blank', () => {
    const onChange = jest.fn();
    const { rerender } = form(FIELDS, onChange);
    fireEvent.click(screen.getByRole('button', { name: '+ Add field' }));
    expect(onChange).toHaveBeenCalledWith({ output: { ...FIELDS, '': '' } });
    rerender(
      <EndForm
        config={{ output: { ...FIELDS, '': '' } }}
        onChange={onChange}
        variables={VARIABLES}
      />
    );
    expect(screen.getByRole('button', { name: '+ Add field' })).toBeDisabled();
  });

  it('removes a field', () => {
    const onChange = jest.fn();
    form(FIELDS, onChange);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove field' })[0]);
    expect(onChange).toHaveBeenCalledWith({ output: { report: 'finalReport' } });
  });

  it('shows a nested object as it is, to be edited in the JSON tab', () => {
    form({ topic: 'topic', meta: { a: 'a' } });
    expect(screen.getAllByLabelText('Variable or text')).toHaveLength(1);
    expect(screen.getByText(/"a": "a"/)).toBeInTheDocument();
  });

  it('is an output, so there is nothing to warn about, until it has no field left', () => {
    const { rerender } = form(FIELDS);
    expect(screen.queryByText(/Every end step needs an output/)).not.toBeInTheDocument();
    rerender(<EndForm config={{ output: {} }} onChange={() => {}} variables={VARIABLES} />);
    expect(screen.getByText(/Every end step needs an output/)).toBeInTheDocument();
    rerender(
      <EndForm config={{ output: { topic: '' } }} onChange={() => {}} variables={VARIABLES} />
    );
    expect(screen.getByText(/Every end step needs an output/)).toBeInTheDocument();
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

  it('names the fields of an object output', () => {
    card({ output: { topic: 'topic', report: 'finalReport' } });
    expect(screen.getByText('→ { topic, report }')).toBeInTheDocument();
    expect(screen.queryByText('No output set')).not.toBeInTheDocument();
  });

  it('says so when there is none', () => {
    card({});
    expect(screen.getByText('No output set')).toBeInTheDocument();
  });
});
