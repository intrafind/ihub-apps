// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Texts in one language (plan section 3.5). The create flow stores a new app
 * in one language, so the app form shows such a text as one input, without
 * language codes and without an "add a language" step.
 *
 * The language component gets this through one opt-in prop,
 * `primaryLanguage`. The first part checks the component with and without the
 * prop; without it a caller sees what it saw before. The second part renders
 * the real form for a German app.
 */
import '@testing-library/jest-dom';
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';

jest.mock('react-i18next', () => require('./helpers/appFormHarness').i18nMock());
jest.mock('../../../client/src/api/adminApi', () =>
  require('./helpers/appFormHarness').adminApiMock()
);
jest.mock('../../../client/src/api/integrationsAdminApi', () =>
  require('./helpers/appFormHarness').adminApiMock()
);
jest.mock('../../../client/src/api/documentTemplatesAdminApi', () =>
  require('./helpers/appFormHarness').adminApiMock()
);
jest.mock('../../../client/src/api/endpoints/skills', () =>
  require('./helpers/appFormHarness').adminApiMock()
);
jest.mock('../../../client/src/api/endpoints/config', () =>
  require('./helpers/appFormHarness').configApiMock()
);
jest.mock('../../../client/src/api/client', () =>
  require('./helpers/appFormHarness').apiClientMock()
);
jest.mock('../../../client/src/shared/contexts/PlatformConfigContext', () =>
  require('./helpers/appFormHarness').platformConfigMock()
);
jest.mock('../../../client/src/shared/hooks/useFeatureFlags', () =>
  require('./helpers/appFormHarness').featureFlagsMock()
);
jest.mock('../../../client/src/utils/runtimeBasePath', () =>
  require('./helpers/appFormHarness').basePathMock()
);

const { groupParts, renderForm, setUiLanguage } = require('./helpers/appFormHarness');
const { cleanAppForSave, newAppDefaults, padLoadedApp } = require('../../../shared/appDefaults.js');
const { appConfigSchema } = require('../../../server/validators/appConfigSchema.js');
const { getAppJsonSchema } = require('../../../server/utils/schemaExport.js');
const {
  default: DynamicLanguageEditor,
  languageNamer
} = require('../../../client/src/shared/components/DynamicLanguageEditor');

let latest;
/** The language component with the state its caller keeps. */
function Field({ initial, ...props }) {
  const [value, setValue] = useState(initial);
  latest = value;
  return <DynamicLanguageEditor value={value} onChange={setValue} {...props} />;
}

const pills = container =>
  [...container.querySelectorAll('span.rounded-full')].map(pill => pill.textContent);

beforeEach(() => {
  setUiLanguage('en');
  latest = undefined;
});

describe('the language component without primaryLanguage (every other caller)', () => {
  // The props of the prompt editor's name field (`PromptFormEditor.jsx`).
  const promptName = {
    label: 'Name *',
    required: true,
    placeholder: { en: 'Prompt name', de: 'Prompt Name' },
    name: 'name'
  };

  it('shows a code pill and an input per language, English first among equals', () => {
    const { container } = render(
      <Field initial={{ en: 'Summary', de: 'Zusammenfassung' }} {...promptName} />
    );
    expect(pills(container)).toEqual(['EN', 'DE']);
    const group = screen.getByRole('group', { name: 'Name * *' });
    expect(group).toHaveAttribute('data-field', 'name');
    const english = screen.getByRole('textbox', { name: 'Name * (EN)' });
    const german = screen.getByRole('textbox', { name: 'Name * (DE)' });
    expect(english).toHaveAttribute('id', 'name.en');
    expect(english).toHaveAttribute('placeholder', 'Prompt name');
    expect(english).toBeRequired();
    expect(german).not.toBeRequired();
    expect(screen.getByRole('button', { name: 'Remove language EN' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove language DE' })).toBeEnabled();
    expect(screen.getAllByTitle('Translate')).toHaveLength(2);
    // No label element: the inputs are named by their language.
    expect(container.querySelector('label')).toBeNull();
  });

  it('shows the pill for a text with one language too', () => {
    const { container } = render(<Field initial={{ de: 'Zusammenfassung' }} {...promptName} />);
    expect(pills(container)).toEqual(['DE']);
    expect(screen.getByRole('textbox', { name: 'Name * (DE)' })).not.toBeRequired();
    expect(screen.getByRole('button', { name: 'Remove language DE' })).toBeEnabled();
  });

  it('keeps an emptied text as an empty text', () => {
    render(<Field initial={{ en: 'Summary' }} label="Description" />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Description (EN)' }), {
      target: { value: '' }
    });
    expect(latest).toEqual({ en: '' });
  });

  it('says that no language is configured for an empty value, and adds only the chosen one', () => {
    const { container } = render(<Field initial={{}} label="Description" />);
    expect(
      screen.getByText('No languages configured. Add a language to get started.')
    ).toBeInTheDocument();
    expect(container.querySelector('input, textarea')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Add a translation' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'fr' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(latest).toEqual({ fr: '' });
  });

  it('removes a nested text without changing the object it was handed', () => {
    const initial = {
      en: { title: 'Hello', subtitle: 'Hi' },
      de: { title: 'Hallo' }
    };
    const snapshot = JSON.parse(JSON.stringify(initial));
    render(<Field initial={initial} label="Title" fieldType="title" />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove language DE' }));
    expect(latest).toEqual({ en: { title: 'Hello', subtitle: 'Hi' } });
    expect(initial).toEqual(snapshot);
  });
});

describe('the wording every caller gets', () => {
  it('names the button "Add a translation" and lists languages by name', () => {
    render(<Field initial={{ en: 'Summary' }} label="Name" />);
    expect(screen.queryByRole('button', { name: /Add Language/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add a translation' }));
    const options = within(screen.getByRole('combobox')).getAllByRole('option');
    const texts = options.map(option => option.textContent);
    expect(texts).toContain('German (de)');
    expect(texts).toContain('French (fr)');
    expect(texts).not.toContain('English (en)');
    expect(texts).not.toContain('DE');
    // The value that is stored stays the code.
    expect(options.find(option => option.textContent === 'German (de)')).toHaveValue('de');
  });

  it('names the languages in the UI language', () => {
    setUiLanguage('de');
    render(<Field initial={{ de: 'Zusammenfassung' }} label="Name" />);
    fireEvent.click(screen.getByRole('button', { name: 'Übersetzung hinzufügen' }));
    const texts = within(screen.getByRole('combobox'))
      .getAllByRole('option')
      .map(option => option.textContent);
    expect(texts).toContain('Englisch (en)');
    expect(texts).toContain('Französisch (fr)');
  });

  it('shows the code for a UI language or a code it has no name for', () => {
    expect(languageNamer('en')('de')).toBe('German (de)');
    expect(languageNamer('de-DE')('pt-BR')).toMatch(/\(pt-BR\)$/);
    expect(languageNamer('not a language')('de')).toBe('de');
    expect(languageNamer(undefined)('de')).toBe('German (de)');
    expect(languageNamer('en')('??')).toBe('??');
  });
});

describe('the language component with primaryLanguage', () => {
  it('shows one input in that language for an empty text, with a real label', () => {
    const { container } = render(
      <Field initial={{}} label="Hint" primaryLanguage="de" name="messagePlaceholder" />
    );
    expect(screen.queryByText(/No languages configured/)).toBeNull();
    expect(pills(container)).toEqual([]);
    const input = screen.getByLabelText('Hint');
    expect(input).toHaveAttribute('id', 'messagePlaceholder.de');
    expect(container.querySelector('label')).toHaveAttribute('for', 'messagePlaceholder.de');
    expect(screen.queryByRole('group')).toBeNull();
    // Nothing is stored until the author types.
    expect(latest).toEqual({});
    fireEvent.change(input, { target: { value: 'Text einfügen' } });
    expect(latest).toEqual({ de: 'Text einfügen' });
  });

  it('shows a text with one language without code, translate and remove buttons', () => {
    const { container } = render(
      <Field initial={{ de: 'Hallo' }} label="Hint" primaryLanguage="de" />
    );
    expect(pills(container)).toEqual([]);
    expect(container.textContent).not.toMatch(/\bDE\b/);
    expect(screen.queryByTitle('Translate')).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove language/ })).toBeNull();
    expect(screen.getByLabelText('Hint')).toHaveValue('Hallo');
  });

  it('edits the one language a text has, also when it is another one', () => {
    render(<Field initial={{ en: 'Hello' }} label="Hint" primaryLanguage="de" name="hint" />);
    const input = screen.getByLabelText('Hint');
    expect(input).toHaveAttribute('id', 'hint.en');
    fireEvent.change(input, { target: { value: 'Hello there' } });
    expect(latest).toEqual({ en: 'Hello there' });
  });

  it('removes the language of an optional text that is emptied, and keeps the input', () => {
    render(<Field initial={{ de: 'Hallo' }} label="Hint" primaryLanguage="de" />);
    const input = screen.getByLabelText('Hint');
    input.focus();
    fireEvent.change(input, { target: { value: '' } });
    expect(latest).toEqual({});
    // The same input stays in the document, so the author keeps typing.
    expect(screen.getByLabelText('Hint')).toBe(input);
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'Neu' } });
    expect(latest).toEqual({ de: 'Neu' });
  });

  it('keeps the language of a required text that is emptied, and marks the input required', () => {
    render(<Field initial={{ de: 'Hallo' }} label="Name" primaryLanguage="de" required />);
    const input = screen.getByLabelText(/^Name/);
    expect(input).toBeRequired();
    expect(screen.getByText('*')).toHaveAttribute('aria-hidden', 'true');
    fireEvent.change(input, { target: { value: '' } });
    expect(latest).toEqual({ de: '' });
  });

  it('adds a translation beside the text, and then shows codes and locks the first language', () => {
    const { container } = render(
      <Field initial={{ de: 'Hallo' }} label="Name" primaryLanguage="de" required name="name" />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add a translation' }));
    const select = screen.getByRole('combobox');
    expect(
      within(select)
        .getAllByRole('option')
        .map(option => option.value)
    ).not.toContain('de');
    fireEvent.change(select, { target: { value: 'en' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(latest).toEqual({ de: 'Hallo', en: '' });

    expect(pills(container)).toEqual(['DE', 'EN']);
    expect(screen.getByRole('textbox', { name: 'Name (DE)' })).toBeRequired();
    expect(screen.getByRole('textbox', { name: 'Name (EN)' })).not.toBeRequired();
    expect(screen.getByRole('button', { name: 'Remove language DE' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove language EN' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove language EN' }));
    expect(latest).toEqual({ de: 'Hallo' });
    expect(pills(container)).toEqual([]);
  });

  it('keeps the first language when a translation is added to an empty text', () => {
    render(<Field initial={{}} label="Hint" primaryLanguage="de" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a translation' }));
    // The language of the input that is shown cannot be added a second time.
    fireEvent.change(screen.getByRole('textbox', { name: /Language code/ }), {
      target: { value: 'de' }
    });
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: /Language code/ }), {
      target: { value: 'en' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(latest).toEqual({ de: '', en: '' });
  });

  it('shows a help line and ties it to the input', () => {
    render(<Field initial={{}} label="Hint" help="Grey text in the box." primaryLanguage="de" />);
    expect(screen.getByLabelText('Hint')).toHaveAccessibleDescription('Grey text in the box.');
  });
});

describe('a German app in the form', () => {
  const jsonSchema = getAppJsonSchema();
  /** As "Start empty" stores an app in a German UI, and as the editor loads it. */
  const germanApp = () =>
    padLoadedApp(
      cleanAppForSave({
        ...newAppDefaults('de'),
        id: 'vertragshelfer',
        name: { de: 'Vertragshelfer' },
        description: { de: 'Beantwortet Fragen zu Verträgen.' },
        system: { de: 'Sie beantworten Fragen zu Verträgen.' }
      })
    );
  const openGroups = () => [groupParts('basics').panel, groupParts('instructions').panel];
  const pillsOfOpenGroups = () => openGroups().flatMap(panel => pills(panel));

  beforeEach(() => setUiLanguage('de'));

  it('shows no language code and no "no languages" text', async () => {
    await renderForm(germanApp(), { jsonSchema });
    expect(pillsOfOpenGroups()).toEqual([]);
    for (const panel of openGroups()) {
      expect(panel.textContent).not.toMatch(/\b(DE|EN)\b/);
      expect(panel.querySelector('[role="group"]')).toBeNull();
    }
    expect(document.body.textContent).not.toMatch(/Keine Sprachen konfiguriert/);
    expect(document.body.textContent).not.toMatch(/No languages configured/);
    const instructions = within(groupParts('instructions').panel);
    expect(instructions.getByLabelText(/^Anweisungen/)).toHaveValue(
      'Sie beantworten Fragen zu Verträgen.'
    );
    expect(within(groupParts('basics').panel).getByLabelText(/^Name/)).toHaveValue(
      'Vertragshelfer'
    );
  });

  it('takes a hint and a message template without an "add language" step, under de', async () => {
    const { probe } = await renderForm(germanApp(), { jsonSchema });
    const instructions = within(groupParts('instructions').panel);
    fireEvent.change(instructions.getByLabelText('Hinweis im Eingabefeld'), {
      target: { value: 'Vertragstext einfügen …' }
    });
    fireEvent.change(instructions.getByLabelText('Nachrichtenvorlage'), {
      target: { value: 'Vertrag:\n{{content}}' }
    });
    expect(probe.changes).toHaveLength(2);
    expect(probe.validation).toEqual({ isValid: true, errors: [] });

    const saved = cleanAppForSave(probe.app);
    expect(saved.messagePlaceholder).toEqual({ de: 'Vertragstext einfügen …' });
    expect(saved.prompt).toEqual({ de: 'Vertrag:\n{{content}}' });
    expect(saved.name).toEqual({ de: 'Vertragshelfer' });
    expect(saved.system).toEqual({ de: 'Sie beantworten Fragen zu Verträgen.' });
    expect(appConfigSchema.safeParse(saved).success).toBe(true);
    expect(pillsOfOpenGroups()).toEqual([]);
  });

  it('writes a new input field and a new conversation starter in German', async () => {
    const { probe } = await renderForm(germanApp(), { jsonSchema });
    const instructions = within(groupParts('instructions').panel);
    fireEvent.click(instructions.getByRole('button', { name: 'Eingabefeld hinzufügen' }));
    fireEvent.change(instructions.getByLabelText(/^Feldname/), {
      target: { value: 'Vertragsart' }
    });
    fireEvent.click(instructions.getByRole('button', { name: 'Einstiegsfrage hinzufügen' }));
    fireEvent.change(instructions.getByLabelText(/^Text der Schaltfläche/), {
      target: { value: 'Kündigungsfrist' }
    });
    fireEvent.change(instructions.getByLabelText(/^Nachricht\b/), {
      target: { value: 'Welche Kündigungsfrist gilt?' }
    });
    expect(probe.app.variables[0].label).toEqual({ de: 'Vertragsart' });
    expect(probe.app.starterPrompts[0].title).toEqual({ de: 'Kündigungsfrist' });
    expect(probe.app.starterPrompts[0].message).toEqual({ de: 'Welche Kündigungsfrist gilt?' });
    expect(pillsOfOpenGroups()).toEqual([]);
  });

  it('edits a German app in German in an English UI', async () => {
    setUiLanguage('en');
    const { probe } = await renderForm(germanApp(), { jsonSchema });
    const instructions = within(groupParts('instructions').panel);
    fireEvent.change(instructions.getByLabelText('Message template'), {
      target: { value: 'Vertrag: {{content}}' }
    });
    expect(probe.app.prompt).toEqual({ de: 'Vertrag: {{content}}' });
    expect(pillsOfOpenGroups()).toEqual([]);
  });

  it('keeps the language while the author empties and retypes the name', async () => {
    setUiLanguage('en');
    const { probe } = await renderForm(germanApp(), { jsonSchema });
    const basics = within(groupParts('basics').panel);
    fireEvent.change(basics.getByLabelText(/^Name/), { target: { value: '' } });
    expect(probe.app.name).toEqual({ de: '' });
    expect(probe.validation.errors.map(error => error.field)).toEqual(['name']);
    const instructions = within(groupParts('instructions').panel);
    fireEvent.change(instructions.getByLabelText('Hint in the message box'), {
      target: { value: 'Text' }
    });
    expect(probe.app.messagePlaceholder).toEqual({ de: 'Text' });
  });

  it('adds a second language with "Add a translation" and lists languages by name', async () => {
    const { probe } = await renderForm(germanApp(), { jsonSchema });
    const nameField = groupParts('basics').panel.querySelector('[data-field="name"]');
    fireEvent.click(within(nameField).getByRole('button', { name: 'Übersetzung hinzufügen' }));
    const select = within(nameField).getByRole('combobox');
    expect(
      within(select)
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toContain('Englisch (en)');
    fireEvent.change(select, { target: { value: 'en' } });
    fireEvent.click(within(nameField).getByRole('button', { name: 'Hinzufügen' }));
    expect(probe.app.name).toEqual({ de: 'Vertragshelfer', en: '' });
    expect(pills(nameField)).toEqual(['DE', 'EN']);
    fireEvent.change(within(nameField).getByRole('textbox', { name: 'Name (EN)' }), {
      target: { value: 'Contract helper' }
    });
    expect(cleanAppForSave(probe.app).name).toEqual({
      de: 'Vertragshelfer',
      en: 'Contract helper'
    });
    // The other texts stay as they were: one language, no codes.
    expect(pills(groupParts('instructions').panel)).toEqual([]);
  });

  it('shows the codes of an app that has two languages', async () => {
    setUiLanguage('en');
    await renderForm(
      padLoadedApp({
        ...germanApp(),
        name: { en: 'Contract helper', de: 'Vertragshelfer' },
        system: { en: 'You answer questions.', de: 'Sie beantworten Fragen.' }
      }),
      { jsonSchema }
    );
    expect(pills(groupParts('basics').panel)).toEqual(['EN', 'DE']);
    expect(pills(groupParts('instructions').panel)).toEqual(['EN', 'DE']);
  });
});
