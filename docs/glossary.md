---
description: "The words iHub uses for its building blocks, in English and German, and the words it does not use."
audience: admin
type: reference
---

# Glossary

iHub uses one word for one thing: the same word in the UI, in this documentation and in the release notes. This page lists those words in English and German, and the words iHub does not use.

Use it when you name apps, write descriptions and announcements for your users, or change UI texts under **Admin → Localization**. Text that follows it reads like the product around it.

The page lists only what you can find in the product today. A feature that is added later brings its words with it.

## Terms

| English        | German           | What it is                                                                                                                                               | Where you find it                                                                                                                                                  |
| -------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| chat           | Chat             | One conversation between a person and an app: the messages, the answers and the files that belong to them.                                               | Every app opens a chat: `/apps`. All stored chats: **Admin → Chat History**, `/admin/chat-history`                                                                 |
| run            | Lauf             | One piece of work iHub carries out from start to end: one answer in a chat, a scheduled task carried out once, a workflow carried out once.              | The **Runs** button of a task under **Admin → Scheduled Tasks**, `/admin/scheduled-tasks`. **Recorded runs** under **Admin → Chat History**, `/admin/chat-history` |
| app            | App              | A fixed use case: instructions for the model, input fields, and the models, tools and knowledge it may use. People work with an app by chatting with it. | The **Apps** page, `/apps`. **Admin → Apps**, `/admin/apps`                                                                                                        |
| workflow       | Workflow         | A sequence of steps that an admin defines once and that iHub then follows step by step. A preview feature, off until an admin switches it on.            | The **Workflows** page, `/workflows`. **Admin → Workflows**, `/admin/workflows`                                                                                    |
| scheduled task | Geplante Aufgabe | A saved prompt that runs by itself at the times its owner set, as its owner, with one app. Every run leaves a chat with the result.                      | The **Scheduled tasks** page, `/tasks`. **Admin → Scheduled Tasks**, `/admin/scheduled-tasks`                                                                      |

Which of the last three fits a use case is the subject of [App, workflow or scheduled task: when to use which](concepts.md#app-workflow-or-scheduled-task-when-to-use-which). The pages behind the terms: [Apps](apps.md), [Workflows](workflows.md), [Scheduled Tasks](scheduled-tasks.md), [Chat Persistence](chat-persistence.md).

Two things to know about the words as they stand today:

- The Workflows pages call one run of a workflow an **execution** (German: **Ausführung**). It is the same thing: one run.
- German keeps **Chat**, **App** and **Workflow** as they are. **Lauf** has the plural **Läufe**.

## Words iHub does not use

These words are in use for the things above, or for something close to them: in other products, in iHub's own code and interfaces, or in earlier texts. Each one also means something else to some readers, which is why the UI does not use them. Where the last column says so, the admin and user documentation does not use them either.

| Word              | Language           | Use instead                                                                           | Checked in       |
| ----------------- | ------------------ | ------------------------------------------------------------------------------------- | ---------------- |
| thread            | English and German | chat (German: Chat)                                                                   | UI text          |
| steer             | English and German | what the person does: send a message, stop the answer                                 | UI text          |
| helper            | English and German | the name of what does the work: the app, the workflow, the scheduled task             | UI text          |
| Helfer            | German             | der Name dessen, was die Arbeit erledigt: die App, der Workflow, die geplante Aufgabe | UI text          |
| sub-task          | English            | step (of a workflow), or run                                                          | UI text and docs |
| Teilaufgabe       | German             | Schritt (eines Workflows) oder Lauf                                                   | UI text          |
| job               | English and German | run (German: Lauf)                                                                    | UI text          |
| lease             | English and German | what happened, in plain words: another server process took over the run               | UI text          |
| worker            | English and German | server process (German: Serverprozess)                                                | UI text          |
| automation        | English            | workflow, or scheduled task                                                           | UI text          |
| Automatisierung   | German             | Workflow oder geplante Aufgabe                                                        | UI text          |
| workflow instance | English            | run (of a workflow)                                                                   | UI text and docs |
| Workflow-Instanz  | German             | Lauf (eines Workflows)                                                                | UI text          |
| Geplanter Agent   | German             | Geplante Aufgabe                                                                      | UI text and docs |

Why these words:

- **thread.** Mail and messaging tools use it for a chain of replies inside something larger. iHub has one level: the chat.
- **steer.** A word of the run interface for developers. A person does not steer; they send a message or stop the answer, and the UI says that.
- **helper, Helfer, sub-task, Teilaufgabe.** Names for work that is part of other work, which leave open what does it. Name the app, the workflow or the scheduled task; a part of a workflow is a step.
- **job, lease, worker.** Words from the inside of the server. What a person sees is a run. When one server process takes a run over from another, the text says exactly that. A few admin texts written before this list still say *worker*, for example on the System Resources page; they are on the record of older texts described below.
- **automation, Automatisierung.** As the name of a building block it can mean a workflow, a scheduled task or a connected system. Name the one you mean. The category **Automation** on the Integrations page keeps its name: it sorts connected systems and is not a building block of iHub.
- **workflow instance, Workflow-Instanz.** A workflow that is carried out once is a run.
- **Geplanter Agent.** In German, *geplant* is the word for *scheduled*, as in *Geplante Aufgabe*, so the phrase is read as "an agent on a schedule". Work that starts by itself at a set time is a *Geplante Aufgabe*.

A word matches as a whole word, in any case and in its plural: "Jobs" and "job-id" count, "release" does not count as "lease".

Several of these words keep their ordinary meaning on the pages for developers and operators: a *worker thread*, a browser's *service worker*, the *workers* of a cluster, an *OCR job*. That is why only words with a single meaning are checked in the documentation.

## How the list is kept

The table above is a copy of `shared/retired-words.json`. A test, `tests/unit/client/retired-words.test.jsx`, reads every text in `shared/i18n/en.json` and `shared/i18n/de.json`, the names and descriptions of the features under **Admin → Features**, and the documentation, and fails when one of the words appears. It also fails when the table and the file differ, and when a row under [Terms](#terms) names a word the UI does not show or a page that does not exist.

Texts that are older than the list are recorded in `tests/unit/client/retired-words-baseline.json`. That record can only get shorter: a new text is reworded, not added to it. A text in which a word has another meaning, such as "Job title", is exempted by its key in the list (`allowKeys`).

Your own texts under **Admin → Localization** are not checked.
