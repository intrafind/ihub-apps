# Panel report 04: Senior Technical Writer

Lens: words. What the screens say, in English and German, what the docs say, and what the release
note says. Flow and layout belong to the UX and UI reports. Where I had to assume a flow to write
copy for it, I used W2 from the earlier review
(`concepts/admin-ui-review-2026-11/02-apps-models-prompts.md:242-250`).

## Summary

The creation flow has no copy of its own in the translation files. Every string in the template
picker and the wizard is an English fallback inside the JSX, so a German admin gets English dialogs
inside a German admin area. The words themselves are written for someone who already knows how an
LLM app is built: "System Instructions", "Variables", "String", "Prompt Template", "Allow Empty
Content", "Revert to parent".

I propose the following:

1. **One vocabulary, fixed before coding.** A term table (section "Vocabulary") gives each concept
   one plain name in en and de. The new flow, the editor, the docs and the App Generator prompt use
   it. The technical term stays findable: it appears once in the help text and in the docs glossary.
2. **A new key namespace `admin.apps.create.*`,** defined in `shared/i18n/en.json` and `de.json`,
   with no fallback text in code. The key table below is ready to paste. The 91 old
   `admin.apps.wizard.*` / `admin.apps.template.*` baseline entries are removed with the old files.
3. **Errors that name the field and the fix.** No "Please fill in all required fields", no "Network
   error" for a missing model.
4. **Editor relabels in the same change** for the sections a new app lands in (instructions, input
   fields, starters). Otherwise the user learns "Input fields" in the flow and meets "Variables"
   one click later.
5. **Docs:** a new `docs/app-quickstart.md`, corrections in `docs/apps.md` and `docs/admin-ui.md`,
   one line in `docs/SUMMARY.md`, one `features.md` entry.

One point contradicts prior art, and I say so here: the review recommended the label "System
prompt" (open owner decision 11, `concepts/admin-ui-review-2026-11/README.md:446`). I recommend
"Instructions" / „Anweisungen" as the label, with "system prompt" in the help text. Reason and
alternative are under "Decisions".

## Findings

Each finding names where I checked it. "Briefing" means I rely on the reconnaissance briefing and
did not re-read the line.

**F1. The flow is untranslated.** `shared/i18n/en.json` and `de.json` have no `admin.apps.wizard`
or `admin.apps.template` object. The `admin.apps` object holds only `edit`, `reorder`, `openApp`,
`test`, `status`, `integrationNames`, `migrationWarnings`, `aiNotice` and a few siblings (checked
by script). The page title and the "Create App" button have no key either (briefing:
`AdminAppsPage.jsx:581`, `:618`).

**F2. One concept has several names.** Found in code and JSON:

| Concept | Names in use today |
|---|---|
| The standing instruction to the model | "System Instructions" (`app-form/SystemInstructionsSection.jsx:25`), "System prompt" / „System-Prompt" (`appConfig.systemPrompt` in en/de.json), "System prompt" (`docs/admin-ui.md:170`) |
| Fields the user fills in | "Variables" (editor, wizard), "input parameters" / „Eingabeparameter" (`admin.apps.edit.variablesPanelPinned`), "{n} variables" hard-coded in English (`AppTemplateSelector.jsx:164`) |
| Copying an app | "Clone" (list row), "template" (picker), "Based on template", "parent" (wizard), "cloned app" (`docs/admin-ui.md:206`), "Duplicate" / „Duplizieren" (prompts, skills, scheduled tasks) |
| The person using the app | „Benutzer" (330 occurrences in de.json) and „Nutzer" (105 occurrences), mixed even inside `admin.apps` (`status.hiddenUntilFeature` says „Nutzer", `test.subtitle` says „Benutzer") |

**F3. German addresses the reader in two ways.** The rule is *Sie*
(`concepts/admin-ui-rework-2026-11/README.md:172`). `admin.apps.edit.integrations.notInstalledOptionalHelp`
says „entferne die Einbindung", the sentence before it in `notInstalledHelp` says „Entfernen Sie".

**F4. Errors do not help.**
- A missing default model produces "Network error occurred while generating app"
  (`AppCreationWizard.jsx:753-757`). The server's reason is dropped.
- A badly formed ID produces "App ID is required" although the field is filled
  (`AppCreationWizard.jsx:1004-1008`).
- The only step-level message is "Please fill in all required fields before proceeding."
  (briefing: `:210-215`). Field highlighting depends on that English sentence (briefing: `:469`).
- Three fallbacks use single braces and print `{templateName}` and `{fields}` literally
  (briefing: `:590`, `:1633`, `:1640`).

**F5. Words describe the data model, not the effect.** Examples from the walkthrough screenshots:
"Allow Empty Content", "Send Chat History", "Display Order", "String / Text / Number / Boolean",
"Message Placeholder", "Manual Configuration: full control over all settings". A non-technical
author cannot predict what any of these does in the chat.

**F6. The picker's empty text is wrong in one of its two cases.** "No apps found matching your
search" also shows when the search box is empty (briefing: `AppTemplateSelector.jsx:174-178`).

**F7. The docs describe a different product.**
- `docs/admin-ui.md:165` says Create App offers "a blank form, a template, upload a JSON file, or
  install one from the Marketplace". The button opens the picker only; upload is a separate button;
  the Marketplace is not reachable from there.
- `docs/admin-ui.md:206` says "test risky changes on a cloned app", and no doc explains cloning.
- `docs/apps.md:32-50` "Quick Start: create your first AI app in under 5 minutes" is a JSON file in
  `contents/apps/`. That is the only quick start for apps.
- `docs/apps.md:453-459` lists `system` as required for chat apps. The schema makes it optional
  (briefing: `server/validators/appConfigSchema.js:605`).
- `docs/apps.md:447` describes the ID as "alphanumeric, dots, hyphens, underscores". The schema
  accepts lower case only (briefing: `shared/validationPatterns.js:15-17`).
- `docs/apps.md:577-580` documents `allowInheritance`, `parentId`, `inheritanceLevel`,
  `overriddenFields` as if a child app inherited from its parent. No server code merges a parent
  into a child (briefing: server section 1).
- No doc page has a screenshot of the wizard or of the whole editor.

**F8. There is no in-product help link.** No `DocsLink` component exists; a grep for it finds only
the docs page's own link helper (`AdminDocsPage.jsx:19`). The admin docs viewer exists at
`/admin/docs/*` (`client/src/App.jsx:869`), so a link target is available.

**F9. "Temperature" and "token" are not app settings.** Apps set neither
(`docs/apps.md`, paragraph after the property table: "Apps do not set a temperature"; CLAUDE.md:
token limits come from the model). The only token wording on an app page is the tool-definition
budget (`admin.apps.edit.toolSearchBudgetHelp`) and the "~466 tokens" figure in the Projects card.
So the task for these two words is to keep them out of the new flow and out of the generator
prompt, not to rename them.

## Proposal

### 1. Writing rules for this feature

- US English. German: *Sie*, „…" quotes, „Benutzer" (never „Nutzer", „Anwender").
- Sentence case for labels and buttons: "New app", not "New App".
- A label names what the user sees in the chat. The help text says what the setting does, in one
  sentence, at most two.
- A button says what happens: "Create app", not "Finish".
- An error says what is wrong and what to do. It never says "invalid" alone.
- The technical term appears once, in parentheses, in the help text of the field. Example:
  "Instructions (also called the system prompt)". Docs and JSON keep the technical names.
- No string lives in code. `t('key')` without a fallback argument, key defined in both files.
- Interpolation uses double braces: `{{name}}`.
- Never write "simply", "just", "easy".

### 2. Vocabulary

| Today (jargon) | English | German | Note |
|---|---|---|---|
| System Instructions / System prompt | Instructions | Anweisungen | Help text carries "system prompt" / „System-Prompt" once |
| Prompt Template | Message template | Nachrichtenvorlage | Editor only, not in the creation flow |
| Variables | Input fields | Eingabefelder | Also replaces "input parameters" / „Eingabeparameter" |
| Variable name | Placeholder | Platzhalter | Shown as `{{language}}`; derived from the label, editable |
| Variable label | Field name | Feldname | The text the user sees above the field |
| String | Short text | Kurzer Text | |
| Text | Long text | Langer Text | |
| Select | Dropdown (choose one) | Auswahlliste (eine Auswahl) | |
| Number / Date | Number / Date | Zahl / Datum | |
| Boolean | Yes / No | Ja / Nein | Only where the type is offered |
| Predefined Values | Options | Auswahlmöglichkeiten | |
| Message Placeholder | Hint in the message box | Hinweis im Eingabefeld | |
| Preferred Model | AI model | KI-Modell | "No preferred model" becomes "Standard model" / „Standardmodell" |
| Allowed Models | Models users can choose | Modelle, die Benutzer wählen können | |
| Output Format | Answer format | Antwortformat | Values: Formatted text (Markdown), Plain text, Data (JSON), Web page (HTML) |
| Preferred Style | Response style | Antwortstil | Matches the user side (`responseStyles.title`) |
| Token (limit, budget) | not used in the flow | nicht verwendet | Where unavoidable: "length" / „Länge" |
| Temperature | not used | nicht verwendet | A model setting, not an app setting |
| Inheritance, parent, overridden fields | not used | nicht verwendet | A copy is a copy |
| Template (= an existing app) | Existing app | Bestehende App | "Template" is reserved for a curated gallery, if one ships |
| Clone | Duplicate | Duplizieren | Matches prompts, skills, scheduled tasks |
| Create from Scratch | Start empty | Leer beginnen | |
| AI-Generated | Describe it | Beschreiben | |
| Manual Configuration | removed | entfällt | The choice disappears |
| App ID | App ID | App-ID | Kept, because the URL, the file name and the docs use it. Filled in automatically |
| Enabled / Disabled (new app) | Available to users / Not available yet | Für Benutzer verfügbar / Noch nicht verfügbar | List status chips keep "Disabled" |
| Send Chat History | Remember earlier messages | Frühere Nachrichten berücksichtigen | |
| Allow Empty Content | Allow sending without a message | Senden ohne Nachricht erlauben | |
| Starter Prompts | Conversation starters | Einstiegsfragen | User side today: "Starter prompts" / „Start-Prompts"; rename both or neither |
| Group access | Who can use this app | Wer die App nutzen darf | |
| Display Order | Position in the app list | Position in der App-Liste | Editor only |

### 3. Screens and copy

I assume this flow, which is W2 with one addition (a preview after generating):

1. Apps list: one button "New app". It opens the same page as `/admin/apps/new` and Cmd+K.
2. **Start**: Describe it / Copy an existing app / Start empty.
3. **Describe** (only for "Describe it"): description, Generate, preview of the draft.
4. **Basics**: name, description, icon, color, category, instructions. The ID is derived from the
   name and shown as a link preview with "Change".
5. **Model**: AI model, plus a sentence on who will see the app.
6. **Create**: creates the app, not yet available to users, and opens the editor with Test.
7. Editor: a "next steps" card for a newly created app.

If the final flow differs, the keys of a dropped screen are dropped with it; the wording rules and
the vocabulary stay.

The copy below is the key table. All keys are new unless marked. Group `admin.apps.create`.

#### 3.1 List and frame

| Key | en | de |
|---|---|---|
| `admin.apps.title` | Apps | Apps |
| `admin.apps.createApp` | New app | Neue App |
| `admin.apps.create.title` | New app | Neue App |
| `admin.apps.create.stepOf` | Step {{current}} of {{total}}: {{name}} | Schritt {{current}} von {{total}}: {{name}} |
| `admin.apps.create.steps.start` | Start | Start |
| `admin.apps.create.steps.describe` | Describe | Beschreiben |
| `admin.apps.create.steps.basics` | Basics | Grundlagen |
| `admin.apps.create.steps.model` | Model | Modell |
| `admin.apps.create.back` | Back | Zurück |
| `admin.apps.create.next` | Continue | Weiter |
| `admin.apps.create.cancel` | Cancel | Abbrechen |
| `admin.apps.create.submit` | Create app | App erstellen |
| `admin.apps.create.submitting` | Creating app… | App wird erstellt… |
| `admin.apps.create.requiredHint` | Fields marked with * are required. | Mit * markierte Felder sind Pflichtfelder. |
| `admin.apps.create.discard.title` | Discard this app? | Diese App verwerfen? |
| `admin.apps.create.discard.body` | You have not created the app yet. What you entered will be lost. | Sie haben die App noch nicht erstellt. Ihre Eingaben gehen verloren. |
| `admin.apps.create.discard.confirm` | Discard | Verwerfen |
| `admin.apps.create.discard.keep` | Keep editing | Weiter bearbeiten |
| `admin.apps.empty.title` | No apps yet | Noch keine Apps |
| `admin.apps.empty.body` | An app is an assistant for one task, for example "Summarize a text" or "Answer questions about our travel policy". | Eine App ist ein Assistent für eine Aufgabe, zum Beispiel „Text zusammenfassen" oder „Fragen zur Reiserichtlinie beantworten". |

#### 3.2 Start

| Key | en | de |
|---|---|---|
| `admin.apps.create.start.heading` | How do you want to start? | Wie möchten Sie beginnen? |
| `admin.apps.create.start.describe.title` | Describe it | Beschreiben |
| `admin.apps.create.start.describe.body` | Say in your own words what the app should do. The AI prepares a draft that you can check and change. | Beschreiben Sie in eigenen Worten, was die App tun soll. Die KI bereitet einen Entwurf vor, den Sie prüfen und ändern können. |
| `admin.apps.create.start.copy.title` | Copy an existing app | Bestehende App kopieren |
| `admin.apps.create.start.copy.body` | Start with a copy of an app that already does something similar. The original stays unchanged. | Beginnen Sie mit der Kopie einer App, die schon etwas Ähnliches tut. Das Original bleibt unverändert. |
| `admin.apps.create.start.blank.title` | Start empty | Leer beginnen |
| `admin.apps.create.start.blank.body` | Enter the name and the instructions yourself. | Geben Sie Namen und Anweisungen selbst ein. |
| `admin.apps.create.start.recommended` | Recommended | Empfohlen |
| `admin.apps.create.noModel.title` | No AI model is set up yet | Es ist noch kein KI-Modell eingerichtet |
| `admin.apps.create.noModel.body` | You can prepare the app, but it cannot answer until a model is connected. | Sie können die App vorbereiten. Antworten kann sie erst, wenn ein Modell angebunden ist. |
| `admin.apps.create.noModel.actionAdmin` | Set up a model | Modell einrichten |
| `admin.apps.create.noModel.actionOther` | Ask an administrator to set up a model. | Bitten Sie einen Administrator, ein Modell einzurichten. |
| `admin.apps.create.describeUnavailable` | "Describe it" needs a standard AI model. None is set. | „Beschreiben" benötigt ein Standardmodell. Es ist keines festgelegt. |

#### 3.3 Copy an existing app

| Key | en | de |
|---|---|---|
| `admin.apps.create.copy.heading` | Which app do you want to copy? | Welche App möchten Sie kopieren? |
| `admin.apps.create.copy.search` | Search apps | Apps suchen |
| `admin.apps.create.copy.inputFields` | Input fields: {{count}} | Eingabefelder: {{count}} |
| `admin.apps.create.copy.disabledBadge` | Disabled | Deaktiviert |
| `admin.apps.create.copy.noMatch` | No app matches "{{query}}". | Keine App passt zu „{{query}}". |
| `admin.apps.create.copy.none` | There is no app to copy yet. Go back and choose another way to start. | Es gibt noch keine App zum Kopieren. Gehen Sie zurück und wählen Sie einen anderen Einstieg. |
| `admin.apps.create.copy.loadError` | The apps could not be loaded. | Die Apps konnten nicht geladen werden. |
| `admin.apps.create.copy.retry` | Try again | Erneut versuchen |
| `admin.apps.create.copy.nameSuffix` | {{name}} (copy) | {{name}} (Kopie) |
| `admin.apps.create.copy.note` | Copied from "{{name}}". Everything is copied, including connected systems and file settings. Change what you need. | Kopiert von „{{name}}". Alles wird übernommen, auch angebundene Systeme und Datei-Einstellungen. Ändern Sie, was Sie brauchen. |

#### 3.4 Describe it

| Key | en | de |
|---|---|---|
| `admin.apps.create.describe.heading` | What should the app do? | Was soll die App tun? |
| `admin.apps.create.describe.label` | Your description | Ihre Beschreibung |
| `admin.apps.create.describe.placeholder` | Example: An assistant that rewrites a difficult text in plain language. The user pastes the text and chooses a reading level. | Beispiel: Ein Assistent, der einen schwierigen Text in einfacher Sprache neu schreibt. Der Benutzer fügt den Text ein und wählt ein Leseniveau. |
| `admin.apps.create.describe.help` | Say who uses the app, what they put in and what they should get back. Two or three sentences are enough. | Sagen Sie, wer die App nutzt, was eingegeben wird und was herauskommen soll. Zwei bis drei Sätze genügen. |
| `admin.apps.create.describe.privacy` | Your description is sent to the standard AI model ({{model}}). | Ihre Beschreibung wird an das Standardmodell ({{model}}) gesendet. |
| `admin.apps.create.describe.generate` | Prepare draft | Entwurf vorbereiten |
| `admin.apps.create.describe.generating` | Preparing your draft. This can take up to a minute. | Ihr Entwurf wird vorbereitet. Das kann bis zu einer Minute dauern. |
| `admin.apps.create.describe.stop` | Stop | Abbrechen |
| `admin.apps.create.describe.regenerate` | Prepare a new draft | Neuen Entwurf vorbereiten |
| `admin.apps.create.describe.regenerateWarning` | A new draft replaces the current one, including your changes. | Ein neuer Entwurf ersetzt den aktuellen, auch Ihre Änderungen. |
| `admin.apps.create.describe.result.heading` | Your draft | Ihr Entwurf |
| `admin.apps.create.describe.result.intro` | The AI prepared this. Check it in the next steps; you can change everything. | Das hat die KI vorbereitet. Prüfen Sie es in den nächsten Schritten; Sie können alles ändern. |
| `admin.apps.create.describe.result.name` | Name | Name |
| `admin.apps.create.describe.result.instructions` | Instructions | Anweisungen |
| `admin.apps.create.describe.result.inputFields` | Input fields | Eingabefelder |
| `admin.apps.create.describe.result.noInputFields` | None. Users write a message. | Keine. Benutzer schreiben eine Nachricht. |
| `admin.apps.create.describe.result.mayUse` | The app may use | Die App darf verwenden |
| `admin.apps.create.describe.result.webSearch` | Web search | Websuche |
| `admin.apps.create.describe.result.nothingExtra` | Nothing besides the AI model. | Nichts außer dem KI-Modell. |
| `admin.apps.create.describe.result.use` | Continue with this draft | Mit diesem Entwurf weiter |
| `admin.apps.create.describe.error.noModel` | No standard AI model is set, so a draft cannot be prepared. Choose "Start empty", or ask an administrator to set a standard model. | Es ist kein Standardmodell festgelegt, daher kann kein Entwurf vorbereitet werden. Wählen Sie „Leer beginnen" oder bitten Sie einen Administrator, ein Standardmodell festzulegen. |
| `admin.apps.create.describe.error.model` | The AI model did not answer. Try again in a moment. Details: {{detail}} | Das KI-Modell hat nicht geantwortet. Versuchen Sie es gleich noch einmal. Details: {{detail}} |
| `admin.apps.create.describe.error.unreadable` | The AI answered in a form that cannot be used. Try again, or describe the app in simpler words. | Die KI hat in einer Form geantwortet, die sich nicht verwenden lässt. Versuchen Sie es erneut oder beschreiben Sie die App mit einfacheren Worten. |
| `admin.apps.create.describe.error.incomplete` | The draft is incomplete: {{missing}} is missing. You can add it in the next step. | Der Entwurf ist unvollständig: {{missing}} fehlt. Sie können es im nächsten Schritt ergänzen. |
| `admin.apps.create.describe.error.setup` | The app assistant is not available on this installation. Choose "Start empty". | Der App-Assistent ist in dieser Installation nicht verfügbar. Wählen Sie „Leer beginnen". |
| `admin.apps.create.describe.error.empty` | Describe the app first. | Beschreiben Sie zuerst die App. |

`error.setup` covers the case that an admin deleted the `app-generator` prompt and the server
answers 404 (briefing: `server/routes/admin/prompts.js:571-574`).

#### 3.5 Basics

| Key | en | de |
|---|---|---|
| `admin.apps.create.basics.heading` | What is the app called and what does it do? | Wie heißt die App und was tut sie? |
| `admin.apps.create.basics.name` | Name | Name |
| `admin.apps.create.basics.namePlaceholder` | Plain-language summary | Zusammenfassung in einfacher Sprache |
| `admin.apps.create.basics.nameHelp` | Users see the name in the app list. | Benutzer sehen den Namen in der App-Liste. |
| `admin.apps.create.basics.description` | Short description | Kurzbeschreibung |
| `admin.apps.create.basics.descriptionPlaceholder` | Rewrites a text so that everyone understands it. | Schreibt einen Text so um, dass ihn alle verstehen. |
| `admin.apps.create.basics.descriptionHelp` | One sentence under the name. It tells users when to pick this app. | Ein Satz unter dem Namen. Er sagt Benutzern, wann sie diese App wählen. |
| `admin.apps.create.basics.instructions` | Instructions | Anweisungen |
| `admin.apps.create.basics.instructionsPlaceholder` | You rewrite texts in plain language. Use short sentences and common words. Keep all facts. Answer in the language of the text. | Sie schreiben Texte in einfacher Sprache um. Verwenden Sie kurze Sätze und gebräuchliche Wörter. Behalten Sie alle Fakten bei. Antworten Sie in der Sprache des Textes. |
| `admin.apps.create.basics.instructionsHelp` | Tell the AI what its task is and how it should answer. It reads this before every chat; users do not see it. (Also called the system prompt.) | Sagen Sie der KI, was ihre Aufgabe ist und wie sie antworten soll. Sie liest das vor jedem Chat; Benutzer sehen es nicht. (Auch System-Prompt genannt.) |
| `admin.apps.create.basics.instructionsTips` | Tips for good instructions | Tipps für gute Anweisungen |
| `admin.apps.create.basics.icon` | Icon | Symbol |
| `admin.apps.create.basics.color` | Color | Farbe |
| `admin.apps.create.basics.category` | Category | Kategorie |
| `admin.apps.create.basics.categoryHelp` | Users can filter the app list by category. | Benutzer können die App-Liste nach Kategorie filtern. |
| `admin.apps.create.basics.language` | You are writing in {{language}}. | Sie schreiben auf {{language}}. |
| `admin.apps.create.basics.languageHelp` | Users with another language see this text until you add a translation in the editor. | Benutzer mit einer anderen Sprache sehen diesen Text, bis Sie im Editor eine Übersetzung ergänzen. |
| `admin.apps.create.basics.languageChange` | Change language | Sprache ändern |
| `admin.apps.create.basics.idPreview` | App ID: {{id}} | App-ID: {{id}} |
| `admin.apps.create.basics.idChange` | Change | Ändern |
| `admin.apps.create.basics.id` | App ID | App-ID |
| `admin.apps.create.basics.idHelp` | Part of the app's link. Lowercase letters, digits and hyphens. It cannot be changed after the app is created. | Teil des Links zur App. Kleinbuchstaben, Ziffern und Bindestriche. Sie lässt sich nach dem Erstellen nicht mehr ändern. |
| `admin.apps.create.basics.idChecking` | Checking… | Wird geprüft… |
| `admin.apps.create.basics.idFree` | Available | Verfügbar |
| `admin.apps.create.error.nameRequired` | Enter a name. | Geben Sie einen Namen ein. |
| `admin.apps.create.error.descriptionRequired` | Enter a short description. | Geben Sie eine Kurzbeschreibung ein. |
| `admin.apps.create.error.instructionsRequired` | Enter instructions. One sentence is enough to start. | Geben Sie Anweisungen ein. Ein Satz genügt für den Anfang. |
| `admin.apps.create.error.idRequired` | Enter an app ID. | Geben Sie eine App-ID ein. |
| `admin.apps.create.error.idFormat` | Use only lowercase letters, digits, hyphens, dots and underscores, without spaces. Example: {{example}} | Verwenden Sie nur Kleinbuchstaben, Ziffern, Bindestriche, Punkte und Unterstriche, ohne Leerzeichen. Beispiel: {{example}} |
| `admin.apps.create.error.idTooLong` | The app ID can have at most 50 characters. | Die App-ID darf höchstens 50 Zeichen haben. |
| `admin.apps.create.error.idTaken` | An app with the ID "{{id}}" already exists. Choose another ID. | Es gibt bereits eine App mit der ID „{{id}}". Wählen Sie eine andere ID. |
| `admin.apps.create.error.summary` | {{count}} fields need your attention. | {{count}} Felder benötigen Ihre Aufmerksamkeit. |

The help text "Lowercase letters, digits and hyphens" names fewer characters than the rule allows.
That is deliberate: the help shows the recommended form, the error text names the full rule.

The `idHelp` claim "part of the app's link" holds: the chat route is `apps/:appId`
(`client/src/App.jsx:515`).

#### 3.6 Model

| Key | en | de |
|---|---|---|
| `admin.apps.create.model.heading` | Which AI model answers? | Welches KI-Modell antwortet? |
| `admin.apps.create.model.label` | AI model | KI-Modell |
| `admin.apps.create.model.default` | Standard model ({{name}}) | Standardmodell ({{name}}) |
| `admin.apps.create.model.defaultNoName` | Standard model | Standardmodell |
| `admin.apps.create.model.help` | If you are unsure, keep the standard model. You can change this later. | Wenn Sie unsicher sind, behalten Sie das Standardmodell. Sie können das später ändern. |
| `admin.apps.create.model.none` | No AI model is available to you. The app is created, but it cannot answer until a model is set up. | Ihnen steht kein KI-Modell zur Verfügung. Die App wird erstellt, kann aber erst antworten, wenn ein Modell eingerichtet ist. |
| `admin.apps.create.model.audienceHeading` | Who will see the app? | Wer sieht die App? |
| `admin.apps.create.model.audienceBody` | Nobody yet. The app is created as "Not available yet", so you can test it first. You make it available in the editor. | Noch niemand. Die App wird als „Noch nicht verfügbar" erstellt, damit Sie sie zuerst testen können. Im Editor geben Sie sie frei. |
| `admin.apps.create.model.audienceGroups` | Which groups can use it then is shown in the editor under "Who can use this app". | Welche Gruppen sie dann nutzen dürfen, sehen Sie im Editor unter „Wer die App nutzen darf". |

`audienceBody` is true only if the implementation creates the app with `enabled: false` and lets
an admin test a disabled app. Today new apps are enabled (briefing: `AppCreationWizard.jsx:41`)
and the test panel refuses a disabled app (`admin.apps.test.disabled`). If the app is created
enabled, use this instead:

| Key | en | de |
|---|---|---|
| `admin.apps.create.model.audienceBodyEnabled` | Everyone who may use apps in their group sees it as soon as you create it. | Alle, die über ihre Gruppe Apps nutzen dürfen, sehen sie, sobald Sie sie erstellen. |

#### 3.7 After creating (editor)

| Key | en | de |
|---|---|---|
| `admin.apps.create.done.toast` | App "{{name}}" created | App „{{name}}" erstellt |
| `admin.apps.create.done.heading` | Your app is ready to test | Ihre App ist bereit zum Testen |
| `admin.apps.create.done.body` | Write a message in the test chat on the right. Change the instructions, save, and try again. | Schreiben Sie eine Nachricht in den Test-Chat rechts. Ändern Sie die Anweisungen, speichern Sie und probieren Sie es erneut. |
| `admin.apps.create.done.steps.test` | Test it with a real example | Mit einem echten Beispiel testen |
| `admin.apps.create.done.steps.inputFields` | Add input fields, if users should choose something (optional) | Eingabefelder ergänzen, wenn Benutzer etwas auswählen sollen (optional) |
| `admin.apps.create.done.steps.starters` | Add conversation starters (optional) | Einstiegsfragen ergänzen (optional) |
| `admin.apps.create.done.steps.access` | Check who can use the app | Prüfen, wer die App nutzen darf |
| `admin.apps.create.done.steps.publish` | Make it available to users | Für Benutzer freigeben |
| `admin.apps.create.done.dismiss` | Hide these steps | Diese Schritte ausblenden |
| `admin.apps.create.done.guide` | Guide: Build your first app | Anleitung: Ihre erste App erstellen |
| `admin.apps.edit.availability.off` | Not available yet | Noch nicht verfügbar |
| `admin.apps.edit.availability.on` | Available to users | Für Benutzer verfügbar |
| `admin.apps.edit.availability.publish` | Make available | Freigeben |
| `admin.apps.edit.availability.unpublish` | Take offline | Zurückziehen |
| `admin.apps.edit.availability.offHelp` | Users cannot see this app. You can test it here. | Benutzer sehen diese App nicht. Sie können sie hier testen. |
| `admin.apps.list.duplicate` | Duplicate | Duplizieren |

#### 3.8 Editor relabels (same change)

These keys are already referenced in code with an English fallback. Most are not defined in the
JSON files (they are in `tests/unit/client/translation-keys-baseline.json`). Define them with the
new text and delete their baseline entries. I read the first block of key names in the files; the
second block I did not, so the implementer must take the key from the file.

Read in code:

| Key (file) | Today | en | de |
|---|---|---|---|
| `admin.apps.edit.systemInstructions` (`SystemInstructionsSection.jsx:25`) | System Instructions | Instructions | Anweisungen |
| `admin.apps.edit.prompt` (`:66`) | Prompt Template | Message template | Nachrichtenvorlage |
| `admin.apps.edit.messagePlaceholder` (`:55`) | Message Placeholder | Hint in the message box | Hinweis im Eingabefeld |
| `admin.apps.edit.typeString` (`VariablesSection.jsx:233`) | String | Short text | Kurzer Text |
| `admin.apps.edit.typeText` (`:234`) | Text | Long text | Langer Text |
| `admin.apps.edit.predefinedValues` (`:281`) | Predefined Values | Options | Auswahlmöglichkeiten |
| `admin.apps.edit.settings` (`SettingsConfigSection.jsx:26`) | User Settings | What users can change | Was Benutzer ändern können |
| `admin.apps.edit.settingsDesc` (`:29`) | Configure which settings users can modify | Each switch shows or hides one control in the chat. | Jeder Schalter blendet ein Bedienelement im Chat ein oder aus. |
| `admin.apps.edit.enableModelSelection` (`:42`) | Enable Model Selection | Users can choose the AI model | Benutzer können das KI-Modell wählen |
| `admin.apps.edit.enableOutputFormat` (`:54`) | Enable Output Format Selection | Users can choose the answer format | Benutzer können das Antwortformat wählen |
| `admin.apps.edit.enableChatHistory` (`:66`) | Enable Chat History Control | Users can switch off "Remember earlier messages" | Benutzer können „Frühere Nachrichten berücksichtigen" ausschalten |
| `admin.apps.edit.enableStyleControl` (`:78`) | Enable Style Control | Users can choose the response style | Benutzer können den Antwortstil wählen |

New help texts (new keys; none exists today):

| Key | en | de |
|---|---|---|
| `admin.apps.edit.systemInstructionsHelp` | Tell the AI what its task is and how it should answer. It reads this before every chat; users do not see it. (Also called the system prompt.) | Sagen Sie der KI, was ihre Aufgabe ist und wie sie antworten soll. Sie liest das vor jedem Chat; Benutzer sehen es nicht. (Auch System-Prompt genannt.) |
| `admin.apps.edit.promptHelp` | Optional. Wraps every message a user sends. Write {{content}} where the message goes and one placeholder for each input field. | Optional. Umschließt jede Nachricht, die ein Benutzer sendet. Schreiben Sie {{content}} an die Stelle der Nachricht und je einen Platzhalter pro Eingabefeld. |
| `admin.apps.edit.variablesTitle` | Input fields | Eingabefelder |
| `admin.apps.edit.variablesHelp` | Fields users fill in before they send, for example a language or a tone. Each field has a placeholder that you can use in the instructions and in the message template. | Felder, die Benutzer vor dem Senden ausfüllen, zum Beispiel eine Sprache oder einen Ton. Jedes Feld hat einen Platzhalter, den Sie in den Anweisungen und in der Nachrichtenvorlage verwenden können. |
| `admin.apps.edit.variablesEmpty` | No input fields. Users write a message, nothing else. | Keine Eingabefelder. Benutzer schreiben nur eine Nachricht. |
| `admin.apps.edit.variableAdd` | Add input field | Eingabefeld hinzufügen |
| `admin.apps.edit.variableLabel` | Field name | Feldname |
| `admin.apps.edit.variableLabelHelp` | The text users see above the field. | Der Text, den Benutzer über dem Feld sehen. |
| `admin.apps.edit.variableName` | Placeholder | Platzhalter |
| `admin.apps.edit.variableNameHelp` | Write {{placeholder}} in the instructions or the message template; it is replaced by what the user enters. | Schreiben Sie {{placeholder}} in die Anweisungen oder die Nachrichtenvorlage; es wird durch die Eingabe des Benutzers ersetzt. |
| `admin.apps.edit.typeSelect` | Dropdown (choose one) | Auswahlliste (eine Auswahl) |
| `admin.apps.edit.typeBoolean` | Yes / No | Ja / Nein |
| `admin.apps.edit.startersTitle` | Conversation starters | Einstiegsfragen |
| `admin.apps.edit.startersHelp` | Buttons in an empty chat. A click puts the text into the message box. | Schaltflächen in einem leeren Chat. Ein Klick setzt den Text in das Eingabefeld. |
| `admin.apps.edit.sendChatHistory` | Remember earlier messages | Frühere Nachrichten berücksichtigen |
| `admin.apps.edit.sendChatHistoryHelp` | On: the AI reads the whole chat for each answer. Off: every message is answered on its own. | Ein: Die KI liest für jede Antwort den ganzen Chat. Aus: Jede Nachricht wird einzeln beantwortet. |
| `admin.apps.edit.accessTitle` | Who can use this app | Wer die App nutzen darf |

Two warnings for the implementer:

- `{{content}}` and `{{placeholder}}` in `promptHelp` and `variableNameHelp` are literal text for
  the reader, and i18next would treat them as interpolation. Pass them as values
  (`t(key, { content: '{{content}}' })`) or render them from a `<code>` element next to the string.
  The literal braces in the table show what the reader must see, not how to store it.
- Before `variablesHelp` and `variableNameHelp` ship, verify that a placeholder is in fact replaced
  inside the instructions (`system`) and not only inside the message template. I did not read the
  server code that fills placeholders. If it only applies to the template, drop "in the
  instructions" from both strings.

Also fix in the same change: `admin.apps.edit.integrations.notInstalledOptionalHelp` (de) from
„entferne die Einbindung zum Aufräumen" to „entfernen Sie die Einbindung, um aufzuräumen", and the
`admin.apps.*` German strings that say „Nutzer" to „Benutzer".

#### 3.9 Server errors

The flow shows the server's `detail` today, which is English. Map by `code` instead, and fall back
to `detail` only for unknown codes.

| Server code / case | Key | en | de |
|---|---|---|---|
| `CONFLICT` on POST | `admin.apps.create.error.idTaken` | (see 3.5) | (see 3.5) |
| `VALIDATION_FAILED` | `admin.apps.create.error.validation` | The app could not be created because {{count}} entries are not accepted: {{fields}}. | Die App konnte nicht erstellt werden, weil {{count}} Angaben nicht akzeptiert werden: {{fields}}. |
| 401 / 403 | `admin.apps.create.error.forbidden` | You are not allowed to create apps. Ask an administrator. | Sie dürfen keine Apps erstellen. Wenden Sie sich an einen Administrator. |
| Network failure | `admin.apps.create.error.offline` | The server cannot be reached. Your entries are still here. Try again. | Der Server ist nicht erreichbar. Ihre Eingaben sind noch da. Versuchen Sie es erneut. |
| Anything else | `admin.apps.create.error.unknown` | The app could not be created. {{detail}} | Die App konnte nicht erstellt werden. {{detail}} |

`{{fields}}` is built from `details.issues[].path`, translated through the field labels of 3.5, so
the user reads "Name, Instructions" and not `name.en, system`.

### 4. The App Generator prompt is copy too

The brief in `server/defaults/prompts/app-generator.json` decides how generated apps read. From
the writer's lens it needs these rules (the security and engineering reports own the rest):

- Write name, description and instructions in the language the user described the app in. Add the
  second language only when asked. Today the prompt says "include both English and German"
  (briefing), and the result is machine-translated text nobody reviewed.
- Field names are words a user understands ("Target language"), never the placeholder
  (`targetLanguage`).
- The description is one sentence that says when to use the app.
- No model name in the example. The example sets `preferredModel: "gpt-4"` (briefing).
- The example category must be one that exists in a default `ui.json`. The example uses `business`
  (briefing).

Changing a shipped default prompt for existing installations needs a migration (CLAUDE.md, config
migrations).

### 5. Docs

**New: `docs/app-quickstart.md`, "Build your first app".** Audience: someone who has never built
an app. No JSON on the page. Outline:

1. What an app is (three sentences, one screenshot of an app in use).
2. Before you start: you need the content-admin or admin role, and one working AI model. How to
   see whether a model works (link to `models.md`).
3. Create the app by describing it (the default path). Screenshot per screen.
4. Test it in the editor. What "the test runs the saved version" means.
5. Improve the instructions: three before/after examples.
6. Add one input field (a dropdown "Reading level") and use its placeholder.
7. Add two conversation starters.
8. Check who can use the app, then make it available.
9. Copy an app to make a variant.
10. If something goes wrong: the error texts of sections 3.4, 3.5 and 3.9, each with cause and fix.
11. Words used in this guide: the vocabulary table, with the JSON field name per term (`system`,
    `variables`, `prompt`, `starterPrompts`, `preferredModel`).

Step 11 is what keeps the old terms findable. A search for "system prompt" or "variables" must
land on this table.

**`docs/SUMMARY.md`:** add `- [Build your first app](app-quickstart.md)` under "Build apps and
agents", directly above `- [Apps](apps.md)` (line 21).

**`docs/apps.md`:**
- `:32-50` Quick Start: start with "To build an app in the admin UI, see Build your first app."
  Keep the JSON example under a heading "Creating an app as a file".
- `:447` ID: "lowercase letters, digits, dots, hyphens, underscores; at most 50 characters; cannot
  be changed".
- `:453-459`: `system` is not required by the server. Say "recommended; the admin UI asks for it".
- `:577-580` inheritance fields: state what is true. "Stored for apps created by older versions of
  the wizard. The server does not apply them: an app copied from another app is a full,
  independent copy." Whether the fields are removed is an owner decision (see Questions).
- Add anchors `#input-fields` (next to the existing variable types, `:715`) and
  `#conversation-starters`, each opening with the UI name and the JSON name.

**`docs/admin-ui.md:159-209` "Managing Apps":** rewrite "To create an app" for the new flow; say
that upload is its own button and that the Marketplace is an admin feature; replace "Key fields"
with the new labels plus the JSON name in parentheses; `:206` "cloned app" becomes "a copy
(Duplicate in the app list)"; add screenshots of the Start screen and the editor with the test
panel. Re-shoot `admin-apps.png` if the button label changes.

**Other pages:** `README.md:171` and `:431`, `docs/ihub-faq-en.md:94` and `:186`,
`docs/developer-onboarding.md:486`, `docs/GETTING_STARTED.md` (link the quickstart as the step
after connecting a model). I did not read these lines beyond the briefing; each needs a look.

**Release note, for `docs/releases/next/features.md`** (use the `/document-feature` skill when
writing it; this is the draft):

```markdown
## Apps: a shorter way to create an app

**New app** on the Apps page now opens one short flow instead of the template picker and the
seven-step wizard. `/admin/apps/new` and the command palette open the same flow.

- **Describe it:** write what the app should do; the standard AI model prepares a draft, and a
  preview shows the name, the instructions, the input fields and what the app may use before
  anything is created.
- **Copy an existing app** or **Start empty** are the other two ways to start.
- The app ID is derived from the name and checked while you type.
- After **Create app** the editor opens with the test chat. A new app is not available to users
  until you make it available.
- The flow and the editor use plainer names: "Instructions" (system prompt), "Input fields"
  (variables), "Message template" (prompt template), "Conversation starters" (starter prompts).
  The JSON field names are unchanged.
- The flow is fully translated to German.

See [Build your first app](../../app-quickstart.md).
```

Every bullet must be checked against what was built before the entry is written. If new apps are
still created enabled, the fourth bullet changes. If an existing behaviour changes for scripts
(for example the response of `GET /api/admin/prompts/app-generator`), that part goes into
`breaking-changes.md` with a "Before upgrading" line.

### 6. In-product help

- One link per screen at most, to the admin docs viewer (`/admin/docs/...`, `App.jsx:869`):
  Start screen and the "next steps" card link to the quickstart; Input fields links to
  `apps#input-fields`; "Who can use this app" links to the groups section of `admin-ui`. How the
  docs viewer builds its paths and anchors I did not verify.
- "Tips for good instructions" (key in 3.5) opens three short tips inline, no link:

| Key | en | de |
|---|---|---|
| `admin.apps.create.basics.tips.role` | Say what the app does: "You summarize meeting notes." | Sagen Sie, was die App tut: „Sie fassen Besprechungsnotizen zusammen." |
| `admin.apps.create.basics.tips.form` | Say what the answer looks like: "Five bullet points at most." | Sagen Sie, wie die Antwort aussieht: „Höchstens fünf Stichpunkte." |
| `admin.apps.create.basics.tips.limits` | Say what it must not do: "Do not add facts that are not in the text." | Sagen Sie, was sie nicht tun darf: „Fügen Sie keine Fakten hinzu, die nicht im Text stehen." |

### 7. What the implementation must do for the copy to hold

- Add all keys to both JSON files; call `t()` without fallback text in the new files.
- Delete `AppCreationWizard.jsx` and `AppTemplateSelector.jsx` baseline entries when the files go;
  the baseline test fails otherwise (briefing: prior art, AI-B14).
- Add a unit test: every `admin.apps.create.*` key used in code exists in en and de, and no German
  value under `admin.apps.create` contains „Nutzer" or a *du* form.
- Do not branch on message text. Field errors carry a field name and a key.
- Check every German string at 390 px width. German is about a third longer; "Mit diesem Entwurf
  weiter" and "Neuen Entwurf vorbereiten" are the longest buttons.

## Pre-mortem

It is May 2027. The rework shipped and failed. These are the stories I can tell from my lens.

**1. German users still saw English.** The developer wrote `t('admin.apps.create.x', 'English
text')` as before, planned to add the JSON "later", and the fallback hid the gap in every English
review. Root cause: fallback arguments make a missing key invisible. Prevention: no fallback
argument in the new files, the key-existence test from section 7, and one review pass with the
browser set to `de-DE`.

**2. Nobody could find anything.** The UI said "Input fields". The docs, the JSON, the support
team and every existing customer said "variables". A customer searched the docs for "input fields"
and found nothing; support told a user to "open Variables" and the user could not find it. Root
cause: we renamed the surface and left no bridge. Prevention: the glossary in the quickstart, the
technical term once in each help text, and UI name plus JSON name at the head of each docs
section.

**3. Two vocabularies in one product.** The creation flow got the new words. The editor kept
"System Instructions", "Variables", "Predefined Values", because "the editor is a later phase".
The user finished the friendly flow and landed in the old language. Root cause: copy was scoped by
component, not by concept. Prevention: section 3.8 ships in the same change; the vocabulary table
is the single source and is checked in review.

**4. The copy promised what the product did not do.** The Model screen said "Nobody sees the app
yet", but the implementation created apps enabled because testing a disabled app was not ready.
An unfinished app with a test prompt was visible to the whole company. Root cause: copy written
against the plan, not against the build. Prevention: each behavioural sentence (marked in 3.5,
3.6, 3.8) has a named code fact; the reviewer ticks them off; both variants of the audience text
exist.

**5. "Describe it" was trusted too much.** The card said the AI "creates your app". Authors
accepted drafts unread. One generated app had a web search switched on and instructions that
contradicted company policy. Root cause: the words presented a draft as a result. Prevention: the
word "draft" everywhere, the preview that lists what the app may use, and "Check it in the next
steps" in the result text.

**6. Errors stayed useless.** New keys existed, but the code still showed the server's English
`detail` for everything, so a German author read "Unrecognized key(s) in object". Root cause:
error copy was written, the mapping from code to key was not. Prevention: the table in 3.9 is
implemented as a function with a unit test per code, and `{{fields}}` uses the field labels.

**7. The quickstart went stale within two releases.** A label changed, a screen was merged, and
the guide's screenshots showed buttons that no longer existed. Root cause: nothing ties the guide
to the UI. Prevention: the e2e spec for the flow walks the same steps as the guide and is named
in the guide's source as a comment; screenshots are produced by a script (the walkthrough scripts
already do this), so re-shooting is one command.

**8. Plain words were wrong words.** "Hint in the message box" was read as a tooltip, and
"Remember earlier messages" was read as memory across chats, which it is not. Root cause: nobody
tested the terms with a non-technical person. Prevention: a 20-minute comprehension check with
three such people before the strings freeze: show each label, ask "what do you expect this to
do?". The two strings named here are the ones I trust least.

**9. Generated apps read like machine output.** Field names were `targetLanguage`, descriptions
were three sentences, German text was stiff. Authors blamed the feature. Root cause: the generator
prompt was treated as configuration, not as copy. Prevention: section 4, plus two generated
examples (one en, one de) reviewed by a writer for each change to the prompt.

**10. Admins were surprised by the release.** The release note said "reworked app creation". It
did not say that new apps now start unavailable, or that "Clone" is now "Duplicate". Tickets
followed. Root cause: the entry described the feature, not the change for the reader.
Prevention: the draft in section 5 lists the changed behaviours and the renamed terms.

## Questions I did not ask

Only the product owner or a customer can answer these. I assumed the answer in parentheses.

1. Is "Instructions" acceptable instead of "System prompt"? Decision 11 is open and the earlier
   recommendation was "System prompt". (Assumed: yes, with the technical term in the help text.)
2. Should the user-facing chat UI follow the renames, for example "Starter prompts" to
   "Conversation starters"? (Assumed: yes for the admin side now; the chat side only if the owner
   agrees, otherwise I keep "Starter prompts" everywhere.)
3. Is the product noun "App" or "Assistant"? The complaint talks about "apps"; some customers
   call them assistants. (Assumed: "App".)
4. Which languages must new copy ship in? The wizard offers ten content languages, the UI has en
   and de. (Assumed: en and de only.)
5. Will there be a curated template gallery at launch? I wrote no copy for it. (Assumed: no; "Copy
   an existing app" covers it.)
6. Are new apps created unavailable, and can an admin test them in that state? Two strings depend
   on it. (Assumed: yes; the alternative text is provided.)
7. May non-admin knowledge experts create apps in future? Then "Ask an administrator" and the
   group sentences need a second variant. (Assumed: creators are admins or content admins.)
8. Should the inheritance fields be removed from the docs, or kept as "stored, not applied"?
   Removing fields from the schema is a breaking change that needs the owner. (Assumed: keep and
   describe truthfully.)
9. Is it acceptable to say on screen that the description is sent to the standard model, with the
   model's name? Some customers may not want model names shown to content admins. (Assumed: yes.)
10. Who reviews German copy? I am not a native reviewer for the customer's house style.
    (Assumed: one native German reader on the team reads sections 3.1 to 3.9 before merge.)
11. Do customers have their own glossary that already translates these terms, for example in
    training material? (Assumed: no.)

## Decisions I took on my own

| # | Decision | Alternative I rejected | Reversible |
|---|---|---|---|
| 1 | Label "Instructions" / „Anweisungen", technical term in help text. This departs from the earlier recommendation "System prompt". | "System prompt" as the label: consistent with docs and industry, but the first word a non-technical author does not know | Yes, two strings |
| 2 | "Input fields" / „Eingabefelder" for variables, "Placeholder" for the variable name | Keep "Variables"; or "Questions" | Yes, strings only; docs glossary must follow |
| 3 | Keep "App ID", hide it behind "Change", derive it from the name | Rename to "Link name" or "Short name" | Yes |
| 4 | New namespace `admin.apps.create.*`; old wizard keys are not reused | Define the 91 existing `admin.apps.wizard.*` keys: keeps old screen structure in the key names | Yes before release; after release a rename costs a find-and-replace |
| 5 | No fallback text in `t()` for the new files | Keep fallbacks as a safety net: they hid the missing German for years | Yes |
| 6 | „Benutzer" and *Sie* throughout, and fixing the `admin.apps` strings that differ | Leave existing strings alone | Yes |
| 7 | "Duplicate" for the row action, "Copy an existing app" for the start card | "Clone", "Use as template" | Yes |
| 8 | "Draft" names what the AI prepares, not a saved state of the app. The app's state is "Not available yet / Available to users". | "Draft / Published": implies a draft feature the server does not have | Yes |
| 9 | Editor relabels for instructions, input fields, starters and user settings are in scope now; all other editor sections (web search, upload, voice, integrations) keep their copy | Relabel the whole editor in one pass: too much unverified copy for one change | Yes; the rest is a follow-up |
| 10 | The quickstart is a new page; `apps.md` stays the reference | Rewrite `apps.md` to be UI-first | Yes |
| 11 | I wrote copy for a flow I assumed (W2 plus a preview) | Wait for the UX report | Yes; keys of dropped screens are dropped |
| 12 | Help text for the ID names the recommended characters only, the error names the full rule | One complete rule in both places | Yes |
| 13 | "Token" and "temperature" get no plain replacement in the app flow, because apps set neither | Invent "length" and "creativity" controls in copy | Yes |
| 14 | "Standard model" / „Standardmodell" for the platform default | "Default model": English UI convention, but "default" is jargon to this audience | Yes |
