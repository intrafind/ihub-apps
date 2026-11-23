---
description: "Decide which groups see which apps, models and prompts: grant access, limit an app or a model to some groups, and find out why someone does not see an app."
audience: admin
type: how-to
adminPage: /admin/groups
---

# Who can use apps, models and prompts

Groups decide who can use an app, a model or a prompt. A user sees an item when at least one of
the user's groups grants it. The item itself holds no list of users.

On a new installation, every signed-in user may use every app, model and prompt. To limit an item
to some groups, you first have to take it away from everyone, because a grant can only add
access, never remove it. This page shows how.

## How access works

Each group has the following lists under **Access & Identity → Groups → (group) → Permissions**:
**Apps**, **Models**, **Prompts**, **Workflows**, **Skills** and **Integrations**. An item is
available to the members of a group when the group's list contains it.

A user gets groups in these ways:

- **Assigned** under **Access & Identity → Users**, for local accounts.
- **Mapped** from the sign-in system. A group's **External Group Mappings** name the groups from
  OIDC, LDAP or a proxy whose members get this group.
- **Authenticated**: every signed-in user also belongs to the group **Authenticated**
  (`authenticated`).
- **Anonymous**: visitors who are not signed in get the groups listed under **Anonymous Groups**
  in **Access & Identity → Authentication**, while **Anonymous Access** is switched on.

Three rules decide what a user may use:

- **Grants add up.** A user may use everything that any of the user's groups grants. There is no
  way to deny an item to a group that another group grants it to.
- **Groups inherit.** A group also grants everything its parent groups grant. The parents are
  set under **Group Inheritance → Inherits From**. For example, **Users** inherits from
  **Authenticated**, which inherits from **Anonymous**.
- **"All (\*)" means every item.** When **All (\*)** is ticked for a list, the group grants every
  app (or model, or prompt), including items created later. In the JSON this is `"*"`. Only the
  single `*` works as a wildcard. A pattern such as `hr-*` is not supported.

### The groups of a new installation

| Group | Inherits from | Apps | Models | Prompts |
| --- | --- | --- | --- | --- |
| **Anonymous** (`anonymous`) | — | Chat | A few named models | All (\*) |
| **Authenticated** (`authenticated`) | Anonymous | All (\*) | All (\*) | All (\*) |
| **Users** (`users`) | Authenticated | All (\*) | All (\*) | All (\*) |
| **Admins** (`admins`) | Users | All (\*) | All (\*) | All (\*) |
| **Content Admins** (`content-admins`) | Authenticated | All (\*) | none of its own | All (\*) |
| **Agent Operators** (`agent-operators`) | Authenticated | All (\*) | All (\*) | All (\*) |

The installation also has groups for the browser extension, the Nextcloud embedding and agents.
They inherit from **Users** or **Authenticated** and add no apps of their own.

Because **Authenticated** holds **All (\*)**, a published app is visible to every signed-in user.
This is what the publish dialog means with "Everyone who signs in can use this app."

## Give a group access to an app or a prompt

Use this when the group does not have the item yet, for example a new group **Sales**.

1. Open the app (**AI Workspace → Apps**) or the prompt (**AI Workspace → Prompts**).
2. Go to the card **Group access**. In the app editor it is in the last group,
   **Who can use this app**.
3. Type the group's name into the search box and pick the group.

The change is saved at once. To take access away, remove the group's chip.

A chip with a lock marks a group that holds **All (\*)** for this kind of item. You cannot remove
that group here, because the group grants every item. To limit the item, follow the next section.

Skills and workflows have the same card. Models do not have it yet: see
[Limit a model to some groups](#limit-a-model-to-some-groups).

<!-- TODO(restrict-access-helper): describe the "Restrict access" helper here once it ships. It
     replaces the manual wildcard steps in the next section; keep those as the fallback. -->

## Limit an app to some groups

Example: only the group **Sales** may use the app "Offer Writer". The other signed-in users must
not see it.

The app is visible to everyone because several groups hold **All (\*)** for apps. Replace the
wildcard in each of them with a list of the apps they should keep:

1. Open the app and go to **Who can use this app**. Note the groups with a locked chip. On a new
   installation these are **Authenticated**, **Users**, **Admins**, **Content Admins** and
   **Agent Operators**.
2. Open **Access & Identity → Groups** and the first of these groups, for example
   **Authenticated**.
3. Under **Permissions → Apps**, untick **All (\*)**. The list is now empty.
4. Add every app the group should keep, with the search box **Search apps to add…**. Leave out
   "Offer Writer".
5. Click **Save Group**.
6. Repeat steps 2 to 5 for each group from step 1. You can keep **All (\*)** for **Admins** if
   administrators should still see every app.
7. Open the app again and give **Sales** access in **Who can use this app**.
8. Check the result. In **Who can use this app**, only **Sales** (and **Admins**, if they kept
   the wildcard) should be left. For an app that is not published yet, **Publish** shows the
   audience in one sentence under **Who will see it**, for example "Members of these groups can
   use it: Sales".

> [!WARNING]
> Add the apps in step 4 before you save. A group without **All (\*)** and with an empty list
> grants no apps. If you save **Authenticated** that way, signed-in users keep only the apps that
> their other groups grant.

What changes for later apps: a group without the wildcard does not get new apps automatically.
Each time you create an app for everyone, give **Authenticated** access to it in the app's
**Group access** card.

## Limit a model to some groups

Example: only the group **Data Science** may use an expensive model. The steps are the same as for
an app, but you make every change in the group editor, because models have no **Group access**
card yet.

1. Open **Access & Identity → Groups** and the group **Authenticated**.
2. Under **Permissions → Models**, untick **All (\*)**.
3. Add every model all signed-in users should keep, with **Search models to add…**. Leave out the
   expensive model.
4. Click **Save Group**.
5. Repeat steps 1 to 4 for the other groups with **All (\*)** for models: on a new installation
   **Users**, **Agent Operators**, the **Agents** group and, if you like, **Admins**.
6. Open the group **Data Science**, add the expensive model under **Models** and click **Save Group**.

<!-- TODO(model-access-card): once models have a "Group access" card, replace steps 1 to 6 with
     the card and keep the group editor steps as the fallback. -->

What users notice:

- The model no longer appears in the model selector of users who may not use it.
- An app whose **AI model** is that model still works for them. It answers with the default model,
  or with another model they may use.
- A user who may use no model at all cannot chat.

An app can also narrow the choice for everyone who uses it: **Allowed Models** in the app editor's
group **Model** limits the models users may pick in that app. It does not depend on groups. See
[Restricting Available Models](models.md#restricting-available-models).

## Who can change access

- **Administrators** can change everything: the lists and wildcards of every group, inheritance,
  mappings and the **Group access** cards.
- **Content admins** (groups with **Content Admin (Apps, Prompts, Projects)**) can use the
  **Group access** card of apps, prompts, skills and workflows. They see and change only the
  groups they belong to and the groups that inherit from those. **Authenticated** and
  **Anonymous** do not count, unless an administrator made the content admin a member of them.
  Content admins cannot change wildcards, model lists or anything else in the group editor.

## When someone does not see an app

Check the following, in this order:

1. **Published.** In **AI Workspace → Apps**, the app's status is **Published**. An app created
   with **New app** starts as **Not published**.
2. **A group grants it.** Open **Access & Identity → Users** and note the user's groups. Signed-in
   users also belong to **Authenticated**. Then open the app's **Group access** card: one of these
   groups, or a group they inherit from, must be listed.
3. **Required features are on.** Some apps need a feature to be switched on in
   **Platform → Features**.
4. **Connected systems are available.** Every integration the app uses is installed and enabled
   under **Integrations**, and the user's groups may use it.
5. **A model is available.** The user may use at least one enabled model, and its provider has an
   API key. Otherwise the app cannot answer.
6. **The file is valid.** An app file that fails validation is not loaded. The server log names
   it.

For a **prompt**, check that the prompt is enabled, that the feature **Prompts Library** is on, and
that one of the user's groups grants it. **Opens in app** does not hide a prompt anywhere.

For a **model**, check that the model is enabled, that one of the user's groups grants it, and that
its provider has an API key (see [Set up models in the admin UI](models.md#set-up-models-in-the-admin-ui)).

<!-- TODO(access-check): describe the access check ("Why can't this user see …?") here once it
     ships, as the first step of this checklist. -->

## Related pages

- [Managing Groups](admin-ui.md#managing-groups): every field of the group editor.
- [Build your first app](app-quickstart.md#check-who-can-use-the-app-and-publish): the publish
  dialog and what its sentences mean.
- [Authentication Quick Start](AUTHENTICATION_QUICK_START.md): sign-in methods and how they assign
  groups.
- [Integrations](integrations.md#who-may-use-an-integration): who may use a connected system.
