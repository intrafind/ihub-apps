# App drafts with a real model: the ten descriptions

**New app** in the admin UI lets an AI model prepare the draft of an app from a description
(`POST /api/admin/apps/_generate`). The automated tests run against a stub model and against
hand-written answers, so they cannot say how good a draft from a real model is. This sheet is the
manual check that does.

**Status: not run yet.** Until the table under [Results](#results) is filled in, the release
notes say that the quality of AI drafts was not measured with real models.

## What you need

- A running iHub with at least one real chat model, signed in as an administrator or a content
  admin.
- The feature **App Drafts with AI** switched on (**Admin → Platform → Features**).
- About 30 minutes per model. A person can prepare 30 drafts per hour, and failed drafts count.

Run all ten descriptions against one model. If you can, run them again against a second, small
local model. The model that drafts is the standard model, so set the model you want to test as
the default under **Admin → Models**.

## The descriptions

Use the English descriptions with the user interface in English and the German ones with the
user interface in German. The language of the user interface is the language of the draft.

| #   | Language | Description                                                                                                                                                                                      | A good draft also has                                                |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 1   | en       | An assistant that rewrites a difficult text in plain language. The user pastes the text and chooses a reading level: easy or standard.                                                           | A dropdown input field with the two reading levels                   |
| 2   | en       | An assistant that drafts a reply to a customer email. The user pastes the email and chooses a tone: friendly, neutral or formal. The reply must not promise anything that is not in the email.   | A dropdown for the tone; the restriction in the instructions         |
| 3   | en       | An assistant that turns rough meeting notes into minutes. The minutes list the decisions first and then the tasks, each with the person responsible and a date if one was mentioned.             | No input field; the order of the minutes in the instructions         |
| 4   | en       | An assistant that answers questions about current trade fairs in our industry. It should look things up on the internet and name its sources.                                                    | **Web search** under "The app could also use", not ticked            |
| 5   | en       | A coach that prepares me for a job interview. It asks one question at a time, waits for my answer and then tells me what was good and what I could say better.                                   | No input field; one or more conversation starters                    |
| 6   | de       | Ein Assistent, der Stellenanzeigen schreibt. Die Personalabteilung gibt Stichpunkte zur Stelle ein und wählt, ob die Anzeige locker oder förmlich klingen soll.                                  | A dropdown for the tone, with German labels                          |
| 7   | de       | Ein Assistent, der einen Text ins Englische, Französische oder Spanische übersetzt. Die Zielsprache wird ausgewählt. Ton und Formatierung des Textes sollen erhalten bleiben.                    | A dropdown with the three languages                                  |
| 8   | de       | Ein Assistent, der lange E-Mails in drei Sätzen zusammenfasst. Am Ende steht in einem eigenen Satz, was der Absender von mir erwartet.                                                           | No input field; German instructions                                  |
| 9   | de       | Ein Assistent, der Fragen zu unseren Jira-Tickets beantwortet. Er soll Tickets suchen und den Stand eines Tickets in zwei Sätzen erklären.                                                       | Jira under "The app could also use" if Jira is installed, not ticked |
| 10  | de       | Ein Assistent, der aus Stichpunkten einen Beitrag für das Intranet schreibt. Die Länge wird gewählt: kurz, mittel oder ausführlich. Der Beitrag hat eine Überschrift und höchstens drei Absätze. | A dropdown for the length; the format in the instructions            |

The last column is a hint for the note, not part of the bar.

## Steps for each description

1. Open **Admin → Apps → New app**, paste the description and click **Prepare draft**.
2. Read the draft on **Check your draft**. Do not edit the instructions.
3. Leave the suggestions unticked and click **Create and test**.
4. In the test chat, send one realistic example for the task. Fill in the input fields first if
   the app has some.
5. Decide whether the draft is usable (next section) and enter the result in the table.
6. Delete the app afterwards (**Admin → Apps**, the row's delete action).

A draft that fails with a message ("The AI's draft could not be used. Try again.", "The AI model
did not answer. …") counts as not usable. Note the message.

## When a draft counts as usable

A draft is usable when both of these hold:

- You could click **Create and test** without editing the instructions.
- The test chat then does what the description asked for.

A draft is not usable when, for example, the instructions are in the wrong language, an input
field the description asked for is missing or has no effect on the answer, the app ignores a
restriction the description named, or the name or the short description is unfit to show to
users.

**The bar:** at least eight usable drafts of ten on the first model. If the bar is missed, the
feature stays switched on, the release notes keep the sentence that draft quality was not
measured or state the result, and the ticket for this run under #3741 stays open.

## Keeping the raw answers

The parser and the sanitiser of the server are tested against raw model answers stored in
`server/tests/fixtures/app-generator/` (see the `README.md` there). Today these files are
hand-written. Adding what real models write makes that test stronger.

The draft request returns the finished app, and the server logs no model text, so the raw answer
has to be fetched separately. The following command sends the same messages as a draft request
to `POST /api/completions` and prints the raw answer. It is a second model call, so its answer
can differ from the draft you saw in the browser.

```bash
# Run in the repository root. COOKIE holds the authToken cookie of your admin session.
BASE=http://localhost:3000
DESCRIPTION='An assistant that rewrites a difficult text in plain language. The user pastes the text and chooses a reading level: easy or standard.'
LANGUAGE=en

DESCRIPTION="$DESCRIPTION" LANGUAGE="$LANGUAGE" node --input-type=module -e "
import { buildGeneratorMessages } from './server/services/appGeneratorBrief.js';
const { messages } = buildGeneratorMessages({
  description: process.env.DESCRIPTION,
  language: process.env.LANGUAGE,
  categories: ['utility']
});
console.log(JSON.stringify({ messages, maxTokens: 4096, responseFormat: 'json' }));
" > /tmp/draft-request.json

curl -s "$BASE/api/completions" -H 'Content-Type: application/json' \
  -H "Cookie: authToken=$COOKIE" --data @/tmp/draft-request.json \
  | node -e "process.stdin.on('data', d => process.stdout.write(JSON.parse(d).choices[0].message.content))" \
  > server/tests/fixtures/app-generator/ok-<model>-01.txt
```

The command leaves out two things a real draft request adds: the categories of the installation
(it names only `utility`) and the list of installed integrations. For descriptions 4 and 9 the
stored answer therefore shows what the model writes without that list.

Name each file by what must happen to the answer, as the fixture README says:

- `ok-<model>-<number>.txt` for an answer that must become a valid app,
- `not-json-…`, `truncated-…` or `incomplete-…` for an answer the server must refuse.

Then run the test that reads every file:

```bash
node scripts/run-server-tests.js app-generator-sanitize
```

Remove anything confidential from an answer before you store it. The ten descriptions above
contain no such data.

## Results

| #   | Model | Date | Usable (yes / no) | Note | Fixture file |
| --- | ----- | ---- | ----------------- | ---- | ------------ |
| 1   |       |      |                   |      |              |
| 2   |       |      |                   |      |              |
| 3   |       |      |                   |      |              |
| 4   |       |      |                   |      |              |
| 5   |       |      |                   |      |              |
| 6   |       |      |                   |      |              |
| 7   |       |      |                   |      |              |
| 8   |       |      |                   |      |              |
| 9   |       |      |                   |      |              |
| 10  |       |      |                   |      |              |

Usable drafts: … of 10. Bar met: yes / no.
