# Getting Started with iHub Apps

iHub Apps runs without a database, without a `.env` file and without manual configuration. Start
it, open it in the browser and connect a model in the setup wizard.

## 1. Start iHub

Pick one of the three ways in. [Installation](INSTALLATION.md) has the details for each.

| Method | Command | Open |
| ------ | ------- | ---- |
| **Binary** (Linux, macOS, Windows) | Download from [GitHub Releases](https://github.com/intrafind/ihub-apps/releases), extract, run `./ihub-apps-v*-linux` (or the `.bat` on Windows). Or use the installer: `curl -fsSL https://raw.githubusercontent.com/intrafind/ihub-apps/main/install.sh \| sh` | http://localhost:3001 |
| **Docker** | `docker compose -f docker-compose.quickstart.yml up` | http://localhost:3000 |
| **npm** (development) | `git clone https://github.com/intrafind/ihub-apps.git && cd ihub-apps && npm run setup:dev && npm run dev` | http://localhost:5173 |

The binary's port comes from the `config.env` next to the executable (`PORT=3001`); Docker and
the npm server listen on 3000 (in development the Vite dev server on 5173 serves the UI and
forwards API calls to port 3000).

### What happens on first start

When the `contents/` directory is empty, the server copies the default configuration from
`server/defaults` into it — apps, models, providers, groups, users, UI settings — and then starts
normally. On later starts it applies any pending [configuration migrations](configuration-migrations.md)
and leaves your configuration alone.

```
🔍 Checking if initial setup is required...
📦 Contents directory is empty, performing initial setup...
📋 Copying default configuration from server/defaults to contents
✅ Default configuration copied successfully
```

## 2. Run the setup wizard

On a fresh installation the browser opens the setup wizard:

1. **Welcome** — **Get Started**, or **Skip, I'll configure later**.
2. **Sign in** as an administrator. A fresh installation ships the local account `admin` with the
   password `password123`.
3. **Connect your first AI provider** — Google Gemini (with a free tier), Anthropic Claude,
   OpenAI, Mistral AI or a local provider (LM Studio, Jan.ai, Ollama, vLLM). Paste the API key,
   **Test Connection**, **Save & Continue**. The key is stored encrypted on the provider.
4. **Finish** — you land on the start page and can chat right away.

<p align="center">
  <img src="assets/screenshots/setup-wizard-welcome.png" alt="Setup wizard: welcome" width="45%">
  &nbsp;
  <img src="assets/screenshots/setup-wizard-provider.png" alt="Setup wizard: connect your first AI provider" width="45%">
</p>

You can add more providers and models at any time under **Admin → Providers** and
**Admin → Models** (including **Import from URL** for whole endpoints). API keys can also come from
environment variables such as `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or
`MISTRAL_API_KEY` — see [Models](models.md) and [Environment Variables](environment-variables.md).

## 3. Look around

![The start page after setup](assets/screenshots/start-page.png)

- The **start page** greets you with the chat input of the default app and shortcuts to the most
  important apps. See the [User Guide](user-guide.md) for a tour.
- **Admin** (`/admin`, or the user menu) configures everything: apps, models, providers, users,
  groups, authentication, branding. See the [Admin UI Guide](admin-ui.md).
- **Admin → Platform → Features** switches on the preview features: Durable Chats (chat history), Scheduled
  Tasks, Marketplace, Workflows, Agent Skills and more.
- **Admin → Marketplace** (once enabled) installs more apps, skills, models, workflows and prompts
  — see [Marketplace](marketplace.md).

## What you get out of the box

- **26 apps** — Chat, Web Chat, Email Composer, Meeting Briefing, Diagram Generator, Image
  Generator, File Analyzer, NDA Risk Analyzer and more; some ship disabled and are switched on in
  **Admin → Apps**.
- **Model configurations** for OpenAI, Anthropic, Google, Mistral, AWS Bedrock and a local vLLM
  server, plus transcription (Voxtral, Gemini) and text-to-speech (Voxtral TTS) models. Only the
  ones whose provider has a key can answer.
- **Two marketplace registries**: the iHub Official Marketplace (90 apps, 98 skills, 19 models,
  6 workflows, 5 prompts) and the iHub Examples.
- **Authentication**: local accounts and anonymous access are on.

## Default access

| Who | What they get |
| --- | ------------- |
| **Anonymous visitors** (`anonymous` group) | The **Chat** app with the default model, the prompt library. No admin, no scheduled tasks. |
| **Signed-in users** (`authenticated`, `users`) | All apps, models, prompts and skills; scheduled tasks |
| **Administrators** (`admins`) | Everything, including the admin area |

The shipped accounts are `admin` (group `admins`) and `user` (group `users`), both with the
password `password123`, and the login page offers them as demo accounts. **Before you open iHub to
other people**, change both passwords under **Admin → Users** and turn off **Show Demo Accounts in
Login Form** under **Admin → Authentication** — the admin area warns until you do. Local sign-in
locks an account for 15 minutes after 5 failed attempts.

## Choosing authentication

| Option | Best for | Guide |
| ------ | -------- | ----- |
| Local accounts (default) | Small teams, trials | [Authentication Quick Start](AUTHENTICATION_QUICK_START.md) |
| Anonymous only, restricted | Public or kiosk deployments — narrow the `anonymous` group's apps and models | [External Authentication](external-authentication.md) |
| LDAP / Active Directory, NTLM | Windows domains | [LDAP/NTLM Authentication](ldap-ntlm-authentication.md) |
| OIDC single sign-on | Microsoft Entra ID, Google, Keycloak, Okta, ADFS | [OIDC Authentication](oidc-authentication.md) |
| Reverse proxy / JWT | An existing SSO gateway in front of iHub | [External Authentication](external-authentication.md) |

Groups from LDAP or OIDC are mapped to iHub groups, which decide who sees which apps, models,
prompts and skills.

## Next steps

1. **Try the apps** on the start page and in **Browse all apps** — [User Guide](user-guide.md)
2. **Secure the installation** — change the shipped passwords, choose an authentication method,
   put a [reverse proxy](production-reverse-proxy-guide.md) with HTTPS in front of it
3. **Connect your knowledge** — [Sources](sources.md), [iFinder](iFinder-Integration.md),
   [Office 365](office365-integration.md), [Google Drive](google-drive-integration.md)
4. **Create your own apps** — [App Configuration](apps.md), or install them from the
   [Marketplace](marketplace.md)
