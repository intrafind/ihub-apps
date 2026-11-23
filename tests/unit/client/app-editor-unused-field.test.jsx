// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Input fields and their placeholders in the app editor (plan section 3.5,
 * decision D31). What a user enters in a field reaches the AI only where the
 * field's placeholder stands in the instructions or in the message template.
 *
 * - A field added in the editor gets its placeholder from its field name
 *   until the author edits the placeholder.
 * - A field that no text uses says so, and "Add to message template" appends
 *   its line.
 *
 * Renders the real `VariablesSection` with the real English and German texts.
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
const { unusedVariables } = require('../../../shared/appPlaceholders.js');
const { VARIABLE_NAME_PATTERN } = require('../../../shared/validationPatterns.js');
const { appConfigSchema } = require('../../../server/validators/appConfigSchema.js');
const { getAppJsonSchema } = require('../../../server/utils/schemaExport.js');
const VariablesSection =
  require('../../../client/src/features/admin/components/app-form/VariablesSection').default;
const {
  AppFormLanguageProvider
} = require('../../../client/src/features/admin/components/app-form/AppLanguageField');

const UNUSED = 'This field is not used yet. The AI does not receive what users enter.';
const ADD = 'Add to message template';

let app;
/** The section with the state the form keeps, in the form's language. */
function Section({ initial, language = 'en' }) {
  const [value, setValue] = useState(initial);
  app = value;
  return (
    <AppFormLanguageProvider value={language}>
      <VariablesSection app={value} onChange={setValue} />
    </AppFormLanguageProvider>
  );
}

const baseApp = (more = {}) => ({
  id: 'summary',
  name: { en: 'Summary' },
  system: { en: 'You summarize texts.' },
  variables: [],
  ...more
});

const addField = () => fireEvent.click(screen.getByRole('button', { name: 'Add input field' }));
const fieldNames = () => screen.getAllByLabelText(/^Field name/);
const placeholders = () => screen.getAllByLabelText(/^Placeholder/);
const type = (input, value) => fireEvent.change(input, { target: { value } });

beforeEach(() => {
  setUiLanguage('en');
  app = undefined;
});

describe('the placeholder of a new field', () => {
  it('follows the field name while the author types it', () => {
    render(<Section initial={baseApp()} />);
    addField();
    expect(app.variables).toEqual([
      { name: '', label: { en: '' }, type: 'string', required: false }
    ]);
    type(fieldNames()[0], 'Reading');
    expect(app.variables[0].name).toBe('reading');
    type(fieldNames()[0], 'Reading level');
    expect(app.variables[0]).toMatchObject({
      name: 'reading_level',
      label: { en: 'Reading level' }
    });
    // The placeholder stays visible and shows what was derived.
    expect(placeholders()[0]).toHaveValue('reading_level');
    expect(screen.getByText(/^Write {{reading_level}} in the instructions/)).toBeInTheDocument();
  });

  it('always gives a name the app schema accepts', () => {
    render(<Section initial={baseApp()} language="de" />);
    addField();
    for (const [label, name] of [
      ['Länge des Textes', 'laenge_des_textes'],
      ['Größe (cm)', 'groesse_cm'],
      ['1. Entwurf', 'field_1_entwurf'],
      ['content', 'content_2'],
      ['日本語', 'field']
    ]) {
      type(fieldNames()[0], label);
      expect(app.variables[0].name).toBe(name);
      expect(app.variables[0].name).toMatch(VARIABLE_NAME_PATTERN);
    }
    expect(app.variables[0].label).toEqual({ de: '日本語' });
  });

  it('is empty again when the field name is emptied', () => {
    render(<Section initial={baseApp()} />);
    addField();
    type(fieldNames()[0], 'Tone');
    type(fieldNames()[0], '');
    expect(app.variables[0].name).toBe('');
    type(fieldNames()[0], 'Style');
    expect(app.variables[0].name).toBe('style');
  });

  it('gets a suffix when another field has the name', () => {
    render(
      <Section
        initial={baseApp({
          system: { en: 'Tone: {{tone}}' },
          variables: [{ name: 'tone', label: { en: 'Tone' }, type: 'string' }]
        })}
      />
    );
    addField();
    type(fieldNames()[1], 'Tone');
    expect(app.variables.map(variable => variable.name)).toEqual(['tone', 'tone_2']);
  });

  it('stops following once the author edits the placeholder', () => {
    render(<Section initial={baseApp()} />);
    addField();
    type(fieldNames()[0], 'Reading level');
    type(placeholders()[0], 'level');
    type(fieldNames()[0], 'Reading level of the answer');
    expect(app.variables[0]).toMatchObject({
      name: 'level',
      label: { en: 'Reading level of the answer' }
    });
    // Also when the author types the derived name back by hand.
    type(placeholders()[0], 'reading_level_of_the_answer');
    type(fieldNames()[0], 'Level');
    expect(app.variables[0].name).toBe('reading_level_of_the_answer');
  });

  it('stops following once a text uses the placeholder', () => {
    render(<Section initial={baseApp()} />);
    addField();
    type(fieldNames()[0], 'Tone');
    fireEvent.click(screen.getByRole('button', { name: ADD }));
    expect(app.prompt).toEqual({ en: 'Tone: {{tone}}' });
    type(fieldNames()[0], 'Tone of voice');
    expect(app.variables[0]).toMatchObject({ name: 'tone', label: { en: 'Tone of voice' } });
    expect(unusedVariables(app)).toEqual([]);
  });

  it('never changes the placeholder of a field the app already had', () => {
    render(
      <Section
        initial={baseApp({
          variables: [{ name: 'lvl', label: { en: 'Level' }, type: 'string', required: false }]
        })}
      />
    );
    type(fieldNames()[0], 'Reading level');
    expect(app.variables[0]).toMatchObject({ name: 'lvl', label: { en: 'Reading level' } });
  });

  it('keeps following the right field when a field above it is removed', () => {
    render(
      <Section
        initial={baseApp({
          variables: [
            { name: 'old', label: { en: 'Old' }, type: 'string' },
            { name: 'kept', label: { en: 'Kept' }, type: 'string' }
          ]
        })}
      />
    );
    addField();
    type(fieldNames()[2], 'Tone');
    fireEvent.click(screen.getByRole('button', { name: 'Delete: Input field 1' }));
    expect(app.variables.map(variable => variable.name)).toEqual(['kept', 'tone']);
    // The new field moved up and still follows; the loaded one before it does not.
    type(fieldNames()[1], 'Tone of voice');
    type(fieldNames()[0], 'Kept longer');
    expect(app.variables.map(variable => variable.name)).toEqual(['kept', 'tone_of_voice']);
  });

  it('does not take a loaded field for a new one after the list was replaced', () => {
    const initial = baseApp({
      variables: [{ name: 'saved', label: { en: 'Saved' }, type: 'string' }]
    });
    function Replaceable() {
      const [value, setValue] = useState(initial);
      app = value;
      return (
        <AppFormLanguageProvider value="en">
          <button type="button" onClick={() => setValue(initial)}>
            discard
          </button>
          <VariablesSection app={value} onChange={setValue} />
        </AppFormLanguageProvider>
      );
    }
    render(<Replaceable />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete: Input field 1' }));
    addField();
    type(fieldNames()[0], 'Fresh');
    expect(app.variables[0].name).toBe('fresh');
    // The page discards the edits: field 1 is the saved one again.
    fireEvent.click(screen.getByRole('button', { name: 'discard' }));
    type(fieldNames()[0], 'Saved and renamed');
    expect(app.variables[0].name).toBe('saved');
  });
});

describe('a field that no text uses', () => {
  const tone = { name: 'tone', label: { en: 'Tone' }, type: 'string', required: false };
  const length = { name: 'length', label: { en: 'Length' }, type: 'string', required: false };

  it('says so, and a field that a text uses does not', () => {
    render(
      <Section
        initial={baseApp({
          system: { en: 'Write in a {{tone}} tone.' },
          prompt: { en: '{{content}}' },
          variables: [tone, length, { name: '', label: { en: 'No placeholder yet' } }]
        })}
      />
    );
    expect(screen.getAllByText(UNUSED)).toHaveLength(1);
    expect(screen.queryByTestId('variable-unused-0')).toBeNull();
    expect(screen.getByTestId('variable-unused-1')).toHaveTextContent(UNUSED);
    // A field without a placeholder has nothing to add yet.
    expect(screen.queryByTestId('variable-unused-2')).toBeNull();
  });

  it('counts a placeholder in the message template of any language as used', () => {
    render(
      <Section
        initial={baseApp({ prompt: { de: 'Ton: {{tone}}\n{{content}}' }, variables: [tone] })}
      />
    );
    expect(screen.queryByText(UNUSED)).toBeNull();
  });

  it('appends its line to the message template, and the notice disappears', () => {
    render(
      <Section
        initial={baseApp({ prompt: { en: 'Summarize:\n{{content}}\n' }, variables: [length] })}
      />
    );
    fireEvent.click(
      within(screen.getByTestId('variable-unused-0')).getByRole('button', { name: ADD })
    );
    expect(app.prompt).toEqual({ en: 'Summarize:\n{{content}}\nLength: {{length}}' });
    expect(screen.queryByText(UNUSED)).toBeNull();
    expect(screen.queryByRole('button', { name: ADD })).toBeNull();
    expect(app.variables).toEqual([length]);
  });

  it('writes a new template in the language of the field name', () => {
    render(
      <Section
        language="de"
        initial={baseApp({
          system: { de: 'Sie fassen Texte zusammen.' },
          variables: [{ name: 'laenge', label: { de: 'Länge' }, type: 'string' }]
        })}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: ADD }));
    expect(app.prompt).toEqual({ de: 'Länge: {{laenge}}' });
    expect(screen.queryByText(UNUSED)).toBeNull();
  });

  it('writes a new template in the language the field name has, when that is another one', () => {
    render(
      <Section
        language="de"
        initial={baseApp({ variables: [{ name: 'tone', label: { en: 'Tone' }, type: 'string' }] })}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: ADD }));
    expect(app.prompt).toEqual({ en: 'Tone: {{tone}}' });
  });

  it('extends every language of a template the app has, each with its field name', () => {
    render(
      <Section
        initial={baseApp({
          prompt: { en: '{{content}}', de: '{{content}}' },
          variables: [{ name: 'tone', label: { en: 'Tone', de: 'Ton' }, type: 'string' }]
        })}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: ADD }));
    expect(app.prompt).toEqual({
      en: '{{content}}\nTone: {{tone}}',
      de: '{{content}}\nTon: {{tone}}'
    });
  });

  it('shows the notice for a new field as soon as it has a placeholder', () => {
    render(<Section initial={baseApp()} />);
    addField();
    expect(screen.queryByText(UNUSED)).toBeNull();
    type(fieldNames()[0], 'Audience');
    expect(screen.getByText(UNUSED)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: ADD }));
    expect(app.prompt).toEqual({ en: 'Audience: {{audience}}' });
    expect(screen.queryByText(UNUSED)).toBeNull();
  });
});

describe('in the form of a German app', () => {
  it('adds a field, warns, adds it to the template and saves a valid app', async () => {
    setUiLanguage('de');
    const { probe } = await renderForm(
      padLoadedApp(
        cleanAppForSave({
          ...newAppDefaults('de'),
          id: 'einfache-sprache',
          name: { de: 'Einfache Sprache' },
          description: { de: 'Schreibt einen Text verständlich um.' },
          system: { de: 'Sie schreiben Texte in einfacher Sprache um.' }
        })
      ),
      { jsonSchema: getAppJsonSchema() }
    );
    const instructions = within(groupParts('instructions').panel);
    fireEvent.click(instructions.getByRole('button', { name: 'Eingabefeld hinzufügen' }));
    fireEvent.change(instructions.getByLabelText(/^Feldname/), { target: { value: 'Leseniveau' } });
    expect(instructions.getByLabelText(/^Platzhalter/)).toHaveValue('leseniveau');
    expect(
      instructions.getByText(
        'Dieses Feld wird noch nicht verwendet. Die KI erhält die Eingabe der Benutzer nicht.'
      )
    ).toBeInTheDocument();

    fireEvent.click(
      instructions.getByRole('button', { name: 'Zur Nachrichtenvorlage hinzufügen' })
    );
    expect(instructions.queryByText(/Dieses Feld wird noch nicht verwendet/)).toBeNull();
    expect(instructions.getByLabelText('Nachrichtenvorlage')).toHaveValue(
      'Leseniveau: {{leseniveau}}'
    );

    const saved = cleanAppForSave(probe.app);
    expect(saved.prompt).toEqual({ de: 'Leseniveau: {{leseniveau}}' });
    expect(saved.variables).toEqual([
      { name: 'leseniveau', label: { de: 'Leseniveau' }, type: 'string', required: false }
    ]);
    expect(probe.validation).toEqual({ isValid: true, errors: [] });
    expect(appConfigSchema.safeParse(saved).success).toBe(true);
  });
});
