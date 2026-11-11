// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import TemplateSlots from '../../../client/src/features/admin/components/document-templates/TemplateSlots';
import { validateTemplate } from '../../../client/src/features/admin/utils/documentTemplates';

/**
 * The text slots of a PowerPoint template in the document template editor:
 * the slots layouts have by name, the ones the admin declares (which
 * placeholder, what to put in it, what to do without it), and adding and
 * removing them.
 */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, values) =>
      typeof fallback === 'string'
        ? fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values?.[name] ?? ''))
        : key,
    i18n: { language: 'en' }
  })
}));

const INFO = {
  layouts: [
    {
      name: 'Content with lead',
      elements: [
        { role: 'slot', slot: 'lead', type: 'body', name: 'Lead (introduction)' },
        { role: 'slot', slot: 'chapter', type: 'body', name: 'Kapitel' },
        { role: 'title', type: 'title', name: 'Title' }
      ]
    }
  ],
  slots: [
    { id: 'lead', source: 'convention', layouts: [{ name: 'Content with lead', kind: 'content' }] },
    { id: 'chapter', source: 'config', layouts: [{ name: 'Content with lead', kind: 'content' }] },
    { id: 'presenter', source: 'config', layouts: [] }
  ]
};

describe('TemplateSlots', () => {
  it('lists the slots found by name and the placeholders to choose from', () => {
    const { container } = render(<TemplateSlots slots={{}} info={INFO} onChange={() => {}} />);
    expect(screen.getByText('Text slots')).toBeInTheDocument();
    expect(screen.getByText(/found in: Content with lead/)).toBeInTheDocument();
    expect(screen.getByText('lead')).toBeInTheDocument();
    expect(container.querySelectorAll('fieldset')).toHaveLength(0);
  });

  it('edits a declared slot: placeholder, description per language and the fallback', () => {
    const onChange = jest.fn();
    const slots = { chapter: { placeholder: 'Kapitel', ifMissing: 'drop' } };
    render(<TemplateSlots slots={slots} info={INFO} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('What to put in it (en)'), {
      target: { value: 'The chapter.' }
    });
    expect(onChange).toHaveBeenLastCalledWith({
      chapter: { placeholder: 'Kapitel', ifMissing: 'drop', description: { en: 'The chapter.' } }
    });
    fireEvent.change(screen.getByLabelText('In a layout without it'), {
      target: { value: 'text' }
    });
    expect(onChange).toHaveBeenLastCalledWith({
      chapter: { placeholder: 'Kapitel', ifMissing: 'text' }
    });
    fireEvent.change(screen.getByLabelText('Placeholder in the layouts'), {
      target: { value: 'Lead (introduction)' }
    });
    expect(onChange.mock.calls.at(-1)[0].chapter.placeholder).toBe('Lead (introduction)');
  });

  it('warns about a declared slot no layout has, and not about one that exists', () => {
    const slots = { chapter: { placeholder: 'Kapitel' }, presenter: { placeholder: 'Referent' } };
    render(<TemplateSlots slots={slots} info={INFO} onChange={() => {}} />);
    expect(screen.getAllByText(/No layout has a placeholder with this name yet/)).toHaveLength(1);
  });

  it('adds a slot by id when the id is valid and new, and removes one', () => {
    const onChange = jest.fn();
    const slots = { chapter: { placeholder: 'Kapitel' } };
    render(<TemplateSlots slots={slots} info={INFO} onChange={onChange} />);
    const add = screen.getByRole('button', { name: 'Add slot' });
    const input = screen.getByLabelText('New slot id');
    expect(add).toBeDisabled();
    fireEvent.change(input, { target: { value: 'Bad id' } });
    expect(add).toBeDisabled();
    fireEvent.change(input, { target: { value: 'chapter' } });
    expect(add).toBeDisabled();
    fireEvent.change(input, { target: { value: 'presenter' } });
    expect(add).toBeEnabled();
    fireEvent.click(add);
    expect(onChange).toHaveBeenLastCalledWith({
      chapter: { placeholder: 'Kapitel' },
      presenter: { placeholder: '' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove slot' }));
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it('shows the problem of a slot without a placeholder', () => {
    render(
      <TemplateSlots
        slots={{ chapter: { placeholder: '' } }}
        errors={{ 'slot:chapter': 'Name the placeholder for the slot "chapter".' }}
        onChange={() => {}}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Name the placeholder');
  });
});

describe('validateTemplate for slots', () => {
  const t = (key, fallback, values) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_, name) => String(values?.[name] ?? ''));
  const draft = slots => ({ id: 'acme', name: { en: 'ACME' }, brand: {}, pptx: { slots } });

  it('wants a placeholder for every slot', () => {
    expect(validateTemplate(draft({ a: { placeholder: 'x' } }), t)).toEqual({});
    expect(validateTemplate(draft({ a: { placeholder: '  ' } }), t)['slot:a']).toMatch(
      /Name the placeholder for the slot "a"/
    );
  });
});
