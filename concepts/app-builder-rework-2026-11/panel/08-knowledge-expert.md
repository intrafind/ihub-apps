# Panel report 08: the non-technical knowledge expert

Who is speaking: an HR business partner. I use Word, Outlook and ChatGPT every day. I have never
seen JSON. I want two things for my team: an "Onboarding FAQ assistant" that answers new joiners'
questions from our onboarding handbook, and a "Job ad writer" that turns a few facts about a role
into a job ad in our tone.

How I worked: I looked at the screenshots of the walkthrough from 2026-11-20 and read the words on
them. I did not read code. Where I name a file and line, it comes from the reconnaissance
briefings; I use it only so the people who build this can find the place. Screenshot names refer to
`/tmp/claude-0/-workspace/8214bfe1-067e-51a6-975f-0905aee8cada/scratchpad/walk/shots/`.

## Summary

I would not get an app out of this today. I would give up on the second screen of the wizard, at
the field "App ID". If a colleague pushed me past it, I would give up for good on "System
Instructions", "Variables" and "String". If I still finished, I would get no confirmation, and my
new app would answer "No models available" to me and to everyone else in the company, because it
went live the second I clicked "Create App".

The deeper problem comes before the screens. There is no place for me at all. The only "Create App"
button sits in the "Admin Panel", between "OAuth", "Credentials" and "MCP gateway"
(`en-01-admin-apps-list`). I am not an admin, and I should not be one. Somebody would have to give
me rights over every app in the company just so that I can build my FAQ helper.

What I want is short. I describe my assistant in my own words. I see what it will be, in plain
sentences. I try it with real questions before anyone else sees it. I say "shorter" or "more
friendly" and it changes. Then I share it with my team and with nobody else. Five things, in that
order. Nothing I am asked may contain the words ID, system, prompt, variable, string, model or
configuration.

My proposal has three parts. They are ordered by what can be built now.

1. **One screen, "What should your assistant do?"**, replaces the template list and the seven
   steps. I type a description or pick one of a handful of examples. Nothing technical is asked.
2. **A "Try it" screen** follows directly: on the left what the assistant is (in sentences I can
   edit), on the right a real chat with it. The app is private while I do this.
3. **A "Share" step** with a plain choice: only me, my team, everyone. Until I choose, nobody sees
   it.

The full editor stays for the admin. I never need to see it. It needs a "simple view" that shows
six things and hides the other hundred.

## Findings

I number them KE-1 to KE-20. "Stop" means: at this point I close the window.

### Before I even start

**KE-1. There is no door for me.** Creating an app exists only in the admin area
(`client/src/App.jsx:555-559`), and the server lets only admins and content admins do it
(`server/middleware/contentAdminAuth.js:13-30`). The normal app list has no "create" button. I can
write my own prompts in iHub, so I expected the same for assistants. I did not find it. **Stop,
before the first screen.**

**KE-2. If I am made a "content admin", I am handed the whole company.** The page I land on shows
every app of the company with a red bin next to each, plus "Enable All" and "Disable All" right
next to "Create App" (`en-01-admin-apps-list`). I am afraid of breaking something. I wanted to
write a job ad helper. I did not want the keys to the building.

**KE-3. The words on the list are not mine.** "Apps Administration", "Upload Config", "Order",
"Model N/A", "Hidden from users until iFinder integration is on". I do not know what a config is,
what order means here, or whether "N/A" is a problem. (It is. See KE-16.)

### The template list ("Choose App Template", `en-02-template-picker`)

**KE-4. These are not templates.** I expected "FAQ assistant", "Writing helper", "Translator",
with a picture and one sentence. I get the company's live apps: "Chat", "iAssistant", "iFinder
Search", "Web Chat", each with "ID: chat". Which of these is a good starting point for an
onboarding FAQ? Nothing tells me. The briefing confirms it: the list is simply every enabled app
(`server/routes/admin/apps.js:355-363`).

**KE-5. "Create from Scratch — Start with a blank app configuration."** "Scratch" and "blank
configuration" tell me I am about to do everything myself. That is the opposite of what I want. And
the little arrow on each card looks like "show me more", but clicking it selects the app.

### Step 1, "Creation Method" (`en-03-step1-method`)

**KE-6. I have just chosen, and I am asked to choose again.** After "Create from Scratch" comes
"AI-Generated" or "Manual Configuration". "AI will generate the configuration for you" sounds
right, but "configuration" worries me. "Full control over all settings" sounds like the
professional option, so I feel I am choosing the amateur one. Six numbered circles with no names
tell me only that this will be long.

### The AI path (`en-13-ai-step-empty`, `en-14-ai-result`)

**KE-7. This is the path I would take, and it is the one that fails.** I type "An app that
summarises a text in plain language", press "Generate App", and get "Network error occurred while
generating app". I check my Wi-Fi. It is fine. I press again. Same message. The real reason is that
no AI model is set up (`server/routes/admin/prompts.js:1577`), and the screen hides that from me
(`AppCreationWizard.jsx:753-757`). **Stop.** I tell my colleagues "the AI thing in iHub doesn't
work".

**KE-8. When it does work, it tells me nothing.** According to the briefing a green "generated
successfully" box appears, with no preview (`AppCreationWizard.jsx:830-844`). Then I must walk five
more steps of the very form I wanted to avoid. The AI may also have switched on web search or
connected company systems, and no screen ever shows me that
(`AppCreationWizard.jsx:699-737`). I would be sharing something I have not seen.

**KE-9. One empty box is not enough help.** "Describe your app" with four lines. I do not know how
much to write. ChatGPT would ask me back: who is it for, what should it know, what tone? Here
nobody asks.

### Step 2, "Basic Information" (`en-04c-step2-basic-bad-id`, `de-04-step2-basic-empty`)

**KE-10. "App ID" is the first required field, and I do not know what it is.** The hint says "Use
only lowercase letters, numbers, dots (.), underscores (_), and hyphens (-)" and the example is
"my-awesome-app". I type "Summarise Text", which is what I would call it. The screen answers "App
ID is required", although I filled it in (`AppCreationWizard.jsx:1004-1008`). The banner above says
"Please fill in all required fields before proceeding." I did. **Stop.** This is where I really
give up.

**KE-11. Later I learn the ID can never be changed.** The last step warns me: "cannot change its
ID. Make sure the ID is unique and descriptive." (`en-08-step6-review`). How would I know whether
it is unique? If it is not, I find out only on the very last screen
(`en-11-duplicate-id-error-at-create`). Why am I typing this at all? The name should be enough.

**KE-12. "Icon" is a text box that says "chat-bubbles".** I would type "📋" or "people". Neither
works, I suppose. A picker exists elsewhere in the product; here I get a word to guess.

**KE-13. In German the whole dialog is English.** The side menu says "Übersicht", "Modelle",
"Gruppen"; the dialog says "Create New App", "Basic Information", "App Name"
(`de-04-step2-basic-empty`). Half my colleagues in HR would not continue. And a "Language" dropdown
with ten languages sits on top without a word about what it changes. It decides in which language
my app's name is stored. I would never guess that.

**KE-14. The buttons fall out of the window.** With the error showing, "Back" and "Next" hang below
the white box over the page behind (`en-04c-step2-basic-bad-id`). On a phone this happens without
any error (`en-43-mobile-step2-basic`). It looks broken, so I trust the rest less.

### Step 3, "System Instructions" (`en-05-step3-system-empty`)

**KE-15. This is the heart of my assistant, and the label hides it.** "System Instructions —
Enter system instructions that define how the AI should behave…". I have instructions for my
assistant in my head: "Answer new joiners' questions. Be warm. Use our handbook. If you do not
know, say so and name the HR mailbox." Nobody told me this box is where that goes. One good example
under the box would do more than the label. "Message Placeholder" I do not understand at all.

**KE-16. "Preferred Model: No preferred model. Optional."** It is the only entry in the list. I
skip it, as told. This is the trap: without a model my app cannot answer, and nothing says so. The
word "Optional" is simply wrong here.

### Step 4, "Variables" (`en-06b-step4-variables-one-added`)

**KE-17. I do not understand one sentence on this screen.** "Variables allow users to customize the
app behavior. They can be used in the prompt template with {{variableName}} syntax." Then "Name
(e.g., targetLanguage)", "Type: String", "Label". And yet this is exactly what my job ad writer
needs: a small form with "Job title", "Location", "Full-time or part-time", "Tone". I would call
them "questions the assistant asks first" or "fields to fill in". "String", "Text", "Number",
"Boolean" should be "Short answer", "Long answer", "Number", "Yes / No". The most useful type for
me, a list to choose from, is missing in the wizard (`AppCreationWizard.jsx:1427-1430`). **Stop**,
or more likely: I press "Next" and my job ad writer ends up without its form.

### Step 5, "Advanced Settings" (`en-07-step5-advanced`)

**KE-18. Three checkboxes with no explanation.** "Allow Empty Content", "Send Chat History",
"Enable Image Upload". Send my chat history to whom? That sounds like a privacy question, and it is
ticked. I learn from the briefing that "Enable Image Upload" does nothing at all
(`appWizardPayload.js:29`). "Display Order: 0". What I did want to switch on is nowhere: "let
people attach a document" and "use our handbook as the source".

### Step 6, "Review & Create", and afterwards (`en-08-step6-review`, `en-09-after-create`, `en-21-user-opens-new-app`)

**KE-19. The review shows me the wrong things.** Name, description, "ID: plain-summary-en",
"Model:" with nothing after it, "Variables: 0". It does not show the instructions I wrote, which
are the app. It does not tell me who will see the app. It warns me about the ID once more.

**KE-20. After "Create App" nothing happens, and then everything is wrong.** The dialog closes. No
"Your app is ready". No "Try it now". I am back on the long list
(`AppCreationWizard.jsx:287-288`). I search for my app, open it, type a question. The send button
is grey. A small yellow tag says "No models available". Meanwhile my half-finished app is already
in every colleague's side menu, "Enabled" from the first second (`en-20-user-home-with-new-app`).
I never agreed to publish it. I delete it, embarrassed, with the red bin. I do not come back.

### The editor (`en-30-editor-plain-summary-en-viewport`, `en-31-editor-summarizer-seg03`, `en-34-editor-test-panel`)

I open it once by accident, through the pencil. "Edit App — Modify app settings and
configuration". "App Type: Chat / Iframe / Redirect", "Order", a "Form | JSON" switch, then ten
screens of scrolling: "Prompt Template" with `<task>` and `{{action}}`, "Web Search",
"Integrations — Bind installed integrations… set the scope users start with", "Tools", "Magic
Prompt", "Compare Mode". The app I made with four fields has become a page with 29 input fields
and 18 checkboxes. I change nothing, because I cannot tell what is safe.

One good thing is in there: the "Test" button opens my app next to the form. That is what I wanted
during creation. It is hidden on a page I would never open, it only runs what is already saved and
live, and it was not offered to me after I created the app.

### What works for me

- The app list itself is readable: name, coloured circle, "Enabled".
- The app as my colleagues see it is clean: name, description, a message box
  (`en-21-user-opens-new-app`).
- "Describe what your app should do, and AI will generate…" is the right idea in the wrong place.
- The "Test" panel is the right idea in the wrong place.
- The red hint "Hidden from users until … is on" on the list proves the product *can* tell me why
  something is not working. It just does not do it for the model.

## Proposal

### How I would describe my apps, in my own words

This is the input the product has to cope with. It is not tidy.

> "I want an assistant for new colleagues. They ask things like when do I get my laptop, who is my
> buddy, how do I book holidays. It should answer from our onboarding handbook (I have it as a
> PDF). Friendly, short, in German or English depending on how they ask. If it does not know, it
> should say so and give them hr@…"

> "Ich brauche einen Stellenanzeigen-Schreiber. Ich gebe Jobtitel, Standort, Vollzeit/Teilzeit und
> drei bis fünf Aufgaben ein, und er schreibt eine Anzeige in unserem Ton, mit Du-Ansprache, immer
> mit dem Absatz zu Benefits und dem Gleichstellungshinweis am Ende."

Notice what I say and what I do not. I say who it is for, what goes in, what comes out, the tone,
and what must always or never happen. I mention a document. I never mention a name for it, an ID, a
category, a colour, an icon or a model. The product must make those up and let me change the
visible ones later.

### The flow I expect

**Screen 1: "What should your assistant do?"** One entry point, one page, no steps bar.

- A large text box with my cursor in it. Under it three example descriptions I can click to see
  what a good one looks like ("Answer questions from a document", "Write a text from a few facts",
  "Rewrite or translate what I paste").
- Next to it, six to eight **ready-made starting points** as cards with an icon and one sentence:
  FAQ over a document, Writer with a short form, Translator, Summariser, Email reply helper,
  Meeting notes. These are a fixed, hand-picked set that ships with the product. The company's own
  apps move behind a quieter link, "Copy one of our existing assistants".
- One button: **"Build my assistant"**.
- If the assistant-builder cannot run because no AI model is set up, the box is replaced by one
  sentence before I type anything: "Your administrator has not connected an AI model yet. Without
  it, assistants cannot answer. Ask [admin contact]." For an admin, a link to the model page. I
  must never again read "Network error".
- If my description is thin ("an HR bot"), it asks me at most three plain questions before
  building: Who will use it? What will they give it? What should come back? I can skip them.

**Screen 2: "Here is your assistant — try it."** Two halves.

*Left: what it is, in sentences I can read and edit.*

| What I see | What it is underneath |
|---|---|
| **Name** and one-line **description** (suggested, editable) | name, description; the ID is made from the name and never shown to me |
| **Icon and colour**, picked for me, changeable with a picker | icon, color |
| **"How it should behave"**: the instructions as normal text, with a one-line hint "Write it like you would brief a new colleague" | system instructions |
| **"Questions it asks first"**: a small list, e.g. "Job title (short answer, must be filled in)", "Employment (choose one: Full-time, Part-time)". Add, remove, rename, reorder. | variables |
| **"What it may use"**: plain switches with a sentence each. "Search the internet: off". "Let people attach files: on". "Company knowledge (iFinder): off". Anything the AI switched on is marked "suggested by the builder" so that I look at it. | web search, upload, integrations |
| **"Example questions"** shown to users as buttons | starter prompts |
| A quiet link: "All settings (for administrators)" | the full editor |

Six blocks. That is the whole thing for me.

*Right: the real chat.* I type "When do I get my laptop?" and see what a new joiner would see. For
the job ad writer I see the little form first, fill it in, and get an ad.

*Under the chat: "Change something".* A line where I type "shorter answers", "always use Du",
"add a field for salary range". The left side updates and shows me what changed, highlighted, with
"Undo". I can also edit the left side by hand. Both ways must work, because sometimes I know
exactly which sentence is wrong.

While I am on this screen the assistant is **private**. A visible tag says "Only you can see this".
I can close the browser and find it again tomorrow under "My drafts".

**Screen 3: "Share".** One question with three answers.

- **Only me** (stays as it is)
- **Specific teams**: I pick from team names I recognise ("HR", "Recruiting"), not group IDs like
  `agent-operators`
- **Everyone in the company**

If my company requires an administrator's approval for "Everyone", the button reads "Ask for
approval" and tells me who gets the request. After sharing I get one clear confirmation: "Onboarding
FAQ is now available to HR. [Open it] [Copy link]". The link is what I paste into Teams.

**Afterwards.** In the normal app list my own assistants carry an "Edit" action that brings me back
to Screen 2. "Stop sharing" is one click and reversible. Deleting asks me by name.

### What I need to see before I trust it

1. An answer to my own question, before anyone else can use it.
2. The instructions in normal language. If I cannot read what it was told, I cannot vouch for it.
3. A plain list of what it can reach: internet, files, company systems. Anything beyond plain chat
   must be visible and off unless I agreed.
4. Who can see it, stated at all times: "Only you" or "HR, Recruiting".
5. Where the answer came from, when it uses my handbook. HR answers must be checkable.
6. That I can undo. A "Previous version" link after each change.

### The words

Replace on every screen I can reach. The German column follows the house style (*Sie*).

| Today | I would say | Deutsch |
|---|---|---|
| App (in creation) | Assistant | Assistent |
| Create App / Create from Scratch | New assistant / Start empty | Neuer Assistent / Leer beginnen |
| App Template | Starting point / Example | Vorlage |
| AI-Generated | Describe it and let iHub build it | Beschreiben und von iHub erstellen lassen |
| Manual Configuration | Set it up myself | Selbst einrichten |
| App ID | (not shown; "Web address name" in all settings) | (nicht gezeigt) |
| System Instructions | How it should behave | So soll sich der Assistent verhalten |
| Message Placeholder | Hint text in the message box | Hinweistext im Eingabefeld |
| Preferred Model | AI model (with "Recommended" preselected) | KI-Modell |
| Variables | Questions it asks first / Form fields | Fragen vorab / Formularfelder |
| String / Text / Number / Boolean / Select | Short answer / Long answer / Number / Yes–No / Choose one | Kurze Antwort / Lange Antwort / Zahl / Ja–Nein / Auswahl |
| Label | What the user sees | Beschriftung |
| Required | Must be filled in | Pflichtangabe |
| Prompt Template | (all settings only) "Message sent to the AI" | Nachricht an die KI |
| Starter Prompts | Example questions | Beispielfragen |
| Send Chat History | Remember earlier messages in the conversation | Frühere Nachrichten berücksichtigen |
| Allow Empty Content | Can be started without typing anything | Ohne Eingabe startbar |
| Upload Configuration | Let people attach files | Dateien anhängen erlauben |
| Integrations / Bind | Connected systems / Use | Verbundene Systeme / Verwenden |
| Enabled / Disabled | Shared / Not shared (plus "Draft") | Freigegeben / Nicht freigegeben / Entwurf |
| Group access | Who can use it | Wer darf es nutzen |
| Display Order, Category | (all settings only) | |
| Network error occurred while generating app | The real reason, in a sentence, with what to do | |

"App" may stay as the product's word in menus if it must. In the sentence that invites me to make
one, "assistant" is what I recognise from ChatGPT.

### What to build, in order

I split this by what I was told about the code, so the engineers can start immediately. Items
marked **(owner)** change who may do what and need the product owner's yes first.

**Part A: fix the first five minutes (no new permissions, no new server concepts).**

A1. One creation entry for the button, `/admin/apps/new` and Cmd+K. Replace `AppTemplateSelector`
and the seven steps with Screen 1. This is the review's W2, made shorter: start from + essentials
on one page.

A2. Never ask for the ID. Derive it from the name, check it against existing apps while I type the
name, add "-2" on a clash. Show it only under "All settings".

A3. Choose a working model for me. If there is a default model, use it silently. If there is none,
block creation up front with the sentence from Screen 1. Delete the word "Optional" next to the
model.

A4. Rewrite the "describe it" step: show the server's real reason on failure; show the result as
readable sentences (name, behaviour, questions it asks, what it may use) before anything is saved;
"Try again" and "Change my description" keep my text.

A5. New apps start **not shared** (created disabled), and the Test panel works for an unshared app
for the person editing it. The review already named this as the cheap first step
(`02-apps-models-prompts.md:333`).

A6. After creation, land on the new app with the test chat open and a confirmation. Never on the
list.

A7. Closing with unsaved text asks first. A draft of my description survives a reload.

A8. Translate every string on these screens into German. Use the word table above.

A9. Ship six to eight curated starting points. The picker shows these first; company apps sit
behind "Copy an existing assistant", where the copy is named "… (copy)".

**Part B: a simple view of the editor.**

B1. The editor opens in "Simple" with the six blocks of Screen 2 and the test chat beside it. "All
settings" shows today's sections, collapsed, with an index. The choice is remembered per person.

B2. "Questions it asks first" replaces the variable rows in simple view: label first, the internal
name derived from the label, types in plain words, "Choose one" with an options list.

B3. Save bar always visible. "Saved" confirmation. Errors next to the field, in a sentence.

B4. "Change something" line under the test chat that rewrites instructions and questions and shows
the difference before I accept. If this is too much for now, ship B1–B3 first; the line is the
part I would miss least on day one and most on day thirty.

**Part C: a door for people like me (owner).**

C1. "My assistants": a normal user may create an assistant that only they can see. No admin panel,
no company-wide list, no bins on other people's apps. The product already allows personal prompts
and personal skills (`server/validators/platformConfigSchema.js:728`, `:760`); this is the same
idea. Off by default, switched on by the administrator.

C2. "Share with my team" for a personal assistant, limited to teams I belong to. "Everyone" goes to
an administrator as a request.

C3. Personal assistants may not connect company systems or switch on internet search on their own.
They get plain chat, the small form, attached files and example questions. More needs an admin.

If C is not approved now, A and B still help: an HR colleague who is made content admin can then
finish an app. But I say plainly: without C the complaint "for a normal user … far too
complicated" is only half answered, because the normal user is still not allowed in.

### How I would know it worked

Give this to five colleagues from HR, legal and sales who have never opened the admin panel. No
training, German interface.

- Four of five have a working, answering assistant within ten minutes.
- None of them is asked for an ID, a model or a type.
- None of them shares something they have not tried.
- Each can say, when asked, who can see their assistant.
- A week later, three of five have changed their assistant at least once.

## Pre-mortem

It is May 2027. The new app builder shipped in January. It failed. These are the stories I would
tell.

**1. "It was beautiful, and I still could not get in."**
What happened: the wizard was replaced by a lovely one-page builder. It lives in the admin panel.
I am not an admin. IT refused to make HR staff content admins, because that role can edit and
delete every app in the company. Nothing changed for me.
Root cause: the team redesigned the screens and left the permission question for "later".
Prevent now: put the "who may create" decision in front of the product owner before coding starts
(Part C). If the answer is "admins only for now", say so in the release note and do not call it
"for everyone".

**2. "The AI built something, I shared it, and it was wrong in front of 400 people."**
What happened: I described the onboarding assistant. It looked fine. I pressed "Create". It was
live for the whole company at once. It had no handbook, so it invented a holiday policy. A new
joiner quoted it to their manager. The works council asked who approved this.
Root cause: new apps were born shared with everyone, and "try it" was optional.
Prevent now: A5. An app starts private. Sharing is a separate, deliberate step that names the
audience. The share step is disabled until the assistant has answered at least one test message.

**3. "The builder switched on things I never saw."**
What happened: the generated job ad writer had internet search on and was connected to the people
directory, because my description mentioned "our team". I never noticed. Security found it in an
audit and switched the whole "describe it" feature off company-wide.
Root cause: the generator can add web search and integrations, and no screen shows them
(`AppCreationWizard.jsx:699-737`).
Prevent now: the "What it may use" block. Everything beyond plain chat is listed in a sentence, is
off until I switch it on, and anything the builder proposes is marked as a proposal.

**4. "They renamed the labels and kept the form."**
What happened: "System Instructions" became "How it should behave", "Variables" became "Questions".
Still seven steps, still "App ID", still a model dropdown. My colleagues got one step further than
before and stopped at the same kind of place.
Root cause: copy was treated as the problem. The problem is the number of decisions asked of me
before I have seen anything work.
Prevent now: hold the rule "nothing is asked that the product can decide itself". Count the
required inputs on the path: it must be one (my description) or two (name plus behaviour). Test it
with five real non-technical people before release, as described above.

**5. "It said 'something went wrong' and I blamed myself."**
What happened: at three customers no default model was configured, or the model was slow. The
builder spun for forty seconds, then showed a friendly but empty error. People tried twice and
left. Usage numbers for the new builder were near zero, and nobody knew why.
Root cause: failures were made prettier, not truthful. The server knows the reason; the screen does
not pass it on.
Prevent now: A3 and A4. Check for a usable model before I type. Show the real reason and the next
step. Show progress while it builds, with a cancel button. Always keep my text.

**6. "Simple mode could not do the one thing I needed, and 'All settings' was a cliff."**
What happened: my FAQ assistant needed the handbook as its source. Simple view had no place for
it. I clicked "All settings" and was back on the ten-screen page with "Bind installed
integrations". I asked IT. IT said "we'll get to it". The assistant never got its handbook and
nobody used it.
Root cause: simple view was cut by what is easy to build, and the top two jobs (answer from a
document; write from a short form) were never walked end to end.
Prevent now: make those two jobs the acceptance test. Both must be completable in simple view, in
German, without opening "All settings". If "answer from our handbook" cannot be done simply yet,
say so on Screen 1 and offer "attach the document in the chat" as the honest interim.

**7. "The German was half English again."**
What happened: the new screens were written in English first. German keys were added "in a
follow-up". Three sentences stayed English, two were machine-translated ("Variablen-Etikett").
The German customers, which is most of them, read it as unfinished.
Root cause: the same thing that happened to the old wizard: no keys in `de.json` at all, and a
baseline file that tolerates missing ones.
Prevent now: A8 is part of "done", not a follow-up. Zero new entries in the missing-keys baseline
for these screens. A German speaker reads every screen once before release.

**8. "I changed one sentence and broke it, and could not go back."**
What happened: I typed "make it shorter" in the change line. The builder rewrote all my
instructions and dropped the sentence about the HR mailbox. I did not notice for two weeks.
Root cause: changes by the builder replaced my text wholesale and were not shown as differences.
Prevent now: every builder change is shown as before/after, needs my "Accept", and has "Undo".
My own hand edits are never overwritten without asking.

**9. "Fifty job ad writers."**
What happened: personal assistants were allowed and sharing was easy. After three months the app
list had eleven "Job ad writer" variants and four onboarding bots, two of them outdated. New
joiners got different answers depending on which one they found.
Root cause: sharing had no owner shown, no "who made this, when was it last changed", and no way
for an admin to tidy up.
Prevent now: show the owner and last-changed date on shared assistants; "Everyone" needs an admin;
give admins a view of shared personal assistants with "stop sharing".

## Questions I did not ask

Only the product owner or a customer can answer these. I assumed an answer for each so that I could
finish; the assumption is in brackets.

1. May a normal, non-admin user create an assistant at all? [Assumed: yes, eventually, as a private
   "My assistants" feature the administrator can switch on. This is the biggest assumption in this
   report.]
2. If yes: may that person share it with their own team without an administrator, or does every
   share need approval? [Assumed: own teams without approval, "everyone" with approval.]
3. Is "content admin" meant to be people like me, or a small trained group? [Assumed: a small
   trained group. If it is meant to be people like me, the admin list page needs to hide other
   people's apps and the bulk buttons from me.]
4. Is the user-facing word "App" fixed by branding, or may the creation flow say "assistant"?
   [Assumed: "assistant" is allowed in sentences; menus keep "Apps".]
5. Is there always a working AI model at customers, or is "no model yet" a common state?
   [Assumed: common on fresh installs, so it must be handled on the first screen.]
6. Can an assistant answer from a document I upload once (my onboarding handbook) without IT
   connecting a system? [Assumed: not in a simple way today. This is the most important capability
   for my first use case, and I do not know whether it exists.]
7. Who is responsible when a shared HR assistant gives a wrong answer: me, the admin, nobody? Does
   the works council or data protection officer have to approve assistants for employees?
   [Assumed: the creator is shown as owner; approval rules are the customer's and the product only
   needs to support "ask for approval".]
8. Does building and testing an assistant cost money per use, and is there a budget per person?
   [Assumed: no per-person limit that I would hit while testing.]
9. Are my test chats stored and visible to administrators? [Assumed: stored like normal chats. I
   would want that said on the test screen.]
10. Do customers want the company's existing apps offered as starting points to everyone who
    creates, including their full instructions? [Assumed: no for normal users; yes for admins.]
11. Which languages matter? [Assumed: German and English are both first-class; an assistant is
    written in the language I describe it in, and a second language is optional and can be
    translated by one click.]
12. How many people like me are there at a typical customer: five or five hundred? It decides
    whether Part C is worth it now. [Assumed: many, because the owner's complaint is about "a
    normal user".]
13. Should I be able to see how often my assistant is used and what people thought of the answers?
    [Assumed: nice to have, not part of this effort.]

## Decisions I took on my own

| # | Decision | Alternative I rejected | Reversible? |
|---|---|---|---|
| 1 | "Describe it" is the main way in. Starting points come second, "start empty" third. | Starting points first with "describe it" as one card among them (as in W2's "Start from" list). | Yes. It is the order on one screen. |
| 2 | I am never asked for the ID. It is made from the name. | Show it pre-filled and editable, as W2 says ("ID auto-slugged, checked inline"). I narrow W2 here: derive and check it, but hide it from the simple path. | Mostly. The ID of an app already created cannot change, so a bad automatic one stays. Admins can still set it under "All settings" before the first save. |
| 3 | New assistants start private, not shared. Sharing is its own step. | Keep today's behaviour (live for everyone immediately) and add a warning. | Yes, but it changes what admins are used to: a freshly created app no longer shows up for users. It needs a line in the release notes. |
| 4 | Sharing is blocked until I have tried the assistant once. | Trying is recommended, not enforced. | Yes. |
| 5 | A simple view of the editor with six blocks, and "All settings" for the rest. | One editor for everyone with collapsed sections and an index, as the earlier review resolved. I do not contradict that for admins: "All settings" *is* that page. I add a simpler view in front of it. | Yes. It is a view, the data is the same. |
| 6 | I say "assistant" in the creation flow and keep "Apps" in menus. | Keep "app" everywhere for consistency. | Yes. Wording only. |
| 7 | I say "How it should behave" instead of choosing between "System prompt" and "System instructions". That choice is an open owner decision (decision 11 in the review). My wording is for the simple view only; "All settings" follows whatever the owner decides. | Wait for the owner's term and use it in both views. | Yes. |
| 8 | The form fields are called "Questions it asks first", and the types are "Short answer / Long answer / Number / Yes–No / Choose one / Date". | Keep "Variables" with a tooltip. | Yes. |
| 9 | A personal assistant may not connect company systems or internet search on its own (C3). | Let creators switch on whatever their own account may use. | Yes, by loosening later. Tightening later would break existing assistants, so I start strict. |
| 10 | The model is chosen for me (the default). I do not see a model dropdown in the simple path. | Show the dropdown with a "Recommended" tag. | Yes. |
| 11 | Curated starting points ship with the product; the company's live apps are offered only as "Copy an existing assistant". The owner decided on 2026-11-17 that the templates list returns every enabled app. I do not change that list; I change where it is shown and what comes before it. | Keep the live apps as the main picker. | Yes. |
| 12 | I put the permission question (Part C) inside this effort, flagged as needing the owner. | Treat it as out of scope because the brief names only the creation entry, wizard, AI path and editor. | Yes. It is a recommendation; nothing is built without a yes. |
| 13 | I set the success test at "four of five non-technical people in ten minutes". | No number; judge by review. | Yes. |
| 14 | I judged from screenshots and the briefings only, and did not click through the running server myself. | Walk it live again. The screenshots were taken today and cover both languages and the phone. | Yes. |
| 15 | I did not see a successful AI generation; none exists in the walkthrough because no model was configured. My findings KE-8 and KE-9 about what happens after success rest on the briefing's description. | Leave the AI success path out of the report. | Yes. Someone should walk it with a real model before the design is fixed. |
