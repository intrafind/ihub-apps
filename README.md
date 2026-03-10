![INTRAFIND Logo iHub](https://github.com/user-attachments/assets/7aea35c8-1c3f-44f3-abad-528cfc5c65be)

# iHub Apps

**30+ ready-to-use AI apps for your team. Self-hosted. No prompting expertise needed.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)
[![Latest Release](https://img.shields.io/github/v/release/intrafind/ihub-apps)](https://github.com/intrafind/ihub-apps/releases)
[![Docker Image](https://img.shields.io/badge/Docker-ghcr.io%2Fintrafind%2Fihub--apps-blue?logo=docker)](https://github.com/intrafind/ihub-apps/pkgs/container/ihub-apps)

**iHub Apps** is a full-stack, open-source AI platform that gives your team instant access to 30+ pre-built AI applications — no prompting expertise, no complex setup, and no data leaving your control. Connect any LLM (OpenAI, Anthropic, Google, Mistral, or local models), integrate your organization's knowledge sources, and deploy securely on-premise or in the cloud.

Unleash creativity and productivity in your organization with **iHub** — the platform that brings the power of generative AI directly into your secure corporate environment. Whether you need to compose emails, generate and edit texts, translate content, analyze files, or brainstorm ideas, **iHub** offers a suite of intuitive micro-apps designed for everyday business needs. With no prompting expertise required and full control over your data, **iHub** lets you work creatively and securely — on-premise or with carefully selected cloud models. Seamlessly integrate **iHub** with your existing **IntraFind** solutions and experience a unified platform for search, knowledge-based answers, and creative AI applications — all free and open source.

![INTRAFIND iHub Startpage](https://github.com/user-attachments/assets/f0495f7e-a0c8-4c25-9e16-4b74d97a3f79)

**iHub** is developed by [**IntraFind Software AG**](https://intrafind.com/) — made with ❤️ from our teams in Berlin, Bonn, Munich + Remote

The Software is free-of-use and "AS-IS" without warranty of any kind. — [License Details](LICENSE.md)

**For enterprise-grade support, custom features, or professional services, contact us at [sales@intrafind.com](mailto:sales@intrafind.com).**

---

## 🚀 Quick Start — Run in Under 60 Seconds

**No Node.js, no Docker, no dependencies.** Download the standalone binary and you're running:

### Step 1 — Download for your platform

👉 **[Download the latest release](https://github.com/intrafind/ihub-apps/releases)**

| Platform   | File                        |
| ---------- | --------------------------- |
| 🐧 Linux   | `ihub-apps-v*-linux.tar.gz` |
| 🍎 macOS   | `ihub-apps-v*-macos.tar.gz` |
| 🪟 Windows | `ihub-apps-v*-win.zip`      |

> **Restricted environment?** Use the `.base64.txt` files: `base64 -d ihub-apps-v*-linux.tar.gz.base64.txt > ihub-apps.tar.gz`

### Step 2 — Extract and run

```bash
# Linux / macOS
tar -xzf ihub-apps-v*-linux.tar.gz
cd ihub-apps-v*
./ihub-apps-v*-linux
```

```bat
:: Windows — extract the .zip, then:
ihub-apps-v*-win.bat
```

### Step 3 — Open and configure

Open **http://localhost:3000** → Go to **Settings → Models** → Add your API key

🎉 **Done!** iHub auto-configures everything on first run. No `.env` file, no database, no manual setup.

**Other install methods:** [One-Line Installer](#-one-line-installer-linuxmacos) · [Docker](#-docker-production) · [npm (for developers)](#-npm-development) · [Electron desktop](#-electron-desktop-app)

---

## 📱 30+ Built-in AI Applications

iHub ships with a comprehensive library of ready-to-use AI apps covering the most common business workflows:

### 💬 Chat & Assistants

| App                    | Description                                       |
| ---------------------- | ------------------------------------------------- |
| 💬 Basic Chat          | Multi-model conversational AI interface           |
| 🌐 Chat with Web       | AI assistant with live web search                 |
| 🧠 Knowledge Assistant | AI with access to your internal knowledge sources |
| 🤖 FAQ Bot             | Self-service Q&A from your documentation          |
| 🎯 Idea Coach          | Guided brainstorming and ideation sessions        |
| 🏋️ Coach Dialog        | Personalized coaching conversations               |

### ✍️ Content Creation & Writing

| App                | Description                                |
| ------------------ | ------------------------------------------ |
| ✉️ Email Composer  | Professional emails in seconds             |
| 📝 Document Writer | Long-form document drafting and editing    |
| 📣 Social Media    | Platform-optimized social content          |
| 📋 Summarizer      | Summaries with configurable tone and focus |
| 🌍 Translator      | Multi-language translation                 |
| 🎤 Dictation       | Voice-to-text with AI correction           |

### 🔍 Research & Analysis

| App                   | Description                                 |
| --------------------- | ------------------------------------------- |
| 🔬 Deep Researcher    | Multi-step web research with synthesis      |
| 📊 Meeting Analyser   | Extract actions, decisions, and summaries   |
| 🗝️ Key Info Extractor | Pull structured data from unstructured text |
| 🛡️ NDA Risk Analyzer  | Contract risk identification                |
| 📁 File Analysis      | Analyze uploaded PDFs and documents         |
| 🖼️ Image Analysis     | Visual content understanding                |

### 🏢 Enterprise & Integration

| App                          | Description                                     |
| ---------------------------- | ----------------------------------------------- |
| 🔍 iFinder Document Explorer | Enterprise document search and analysis         |
| 👥 People Search             | Microsoft Entra / corporate directory search    |
| 🌐 Website Bot               | AI assistant for any public or internal website |
| 🔒 GDPR Anonymizer           | Automatically anonymize sensitive data          |
| 📈 OpenSearch Analyser       | Analyze and query OpenSearch/Elasticsearch      |
| 🗂️ Multi-Source Bot          | Query across multiple knowledge sources at once |

### 🛠️ Developer & Specialized Tools

| App                     | Description                                  |
| ----------------------- | -------------------------------------------- |
| 🖼️ Image Generator      | AI image creation (DALL-E, Stable Diffusion) |
| 🎵 Audio Transcription  | Transcribe audio files to text               |
| 📐 Mermaid Diagrams     | Generate diagrams from descriptions          |
| ⚡ Prompt Generator     | Create optimized prompts for AI tasks        |
| 🔎 Prompt Insight       | Analyze and improve existing prompts         |
| 🏛️ Zoll-Tarif Assistant | Customs tariff classification assistant      |
| 🤝 HR Assistant         | HR process support and document handling     |
| 😄 Joker                | Entertainment and creative writing           |

All apps are **fully configurable** via the admin interface — customize prompts, connect knowledge sources, set model preferences, and control access per user group. New apps can be created without coding.

---

## 🎆 Why Teams Choose iHub Apps

### 🔒 Full Data Control

Your data never leaves your infrastructure. Deploy on-premise, in your private cloud, or air-gapped. Connect to local LLMs (LM Studio, Jan.ai, vLLM) for complete privacy.

### 🤖 Any LLM, Unified Interface

One interface for OpenAI GPT-4o, Anthropic Claude, Google Gemini, Mistral, and any OpenAI-compatible model. Switch models per app or let users choose. No vendor lock-in.

### 📚 Enterprise Knowledge Integration

Connect your organization's knowledge: local files, SharePoint, enterprise document systems (iFinder), web pages, and databases. AI answers grounded in _your_ content.

### 👤 No Prompting Skills Required

Every app ships with expert-crafted prompts. Your team gets instant value — no AI expertise, no prompt engineering, no training required.

### 🔐 Enterprise-Grade Security

Multi-mode authentication: Anonymous, Local, OIDC (Google, Microsoft, custom), and proxy auth. Group-based permissions. Hierarchical access control. CORS support for embedded deployments.

### 🚀 Deploy in Minutes, Scale Infinitely

Standalone binary, Docker, npm, or Electron. Auto-configuration on first run. Multi-worker clustering for production. No database required.

### 🎨 Modern, Responsive Interface

Clean React SPA with dark/light mode, mobile-friendly design, real-time streaming responses, and full internationalization (English, German, and more).

### 🛠️ Extensible Without Coding

Add new apps, models, and knowledge sources through the admin UI. JSON-based configuration. REST API for integration. Full source code available for deeper customization.

---

## 🚢 Deploy Anywhere

### ⚡ One-Line Installer (Linux/macOS)

The simplest way to install — a single command handles everything:

```bash
curl -fsSL https://raw.githubusercontent.com/intrafind/ihub-apps/main/install.sh | sh
```

```bash
# Install and start immediately:
curl -fsSL https://raw.githubusercontent.com/intrafind/ihub-apps/main/install.sh | sh -s -- --start
```

**CLI Options:**

| Option | Description |
| --------------- | ------------------------------------------------- |
| `--start` | Start iHub Apps immediately after installation |
| `--version=TAG` | Install a specific version (e.g. `--version=v4.2.0`) |
| `-h, --help` | Show help |

**Environment Variables:**

| Variable | Description |
| ------------------ | ----------------------------------- |
| `IHUB_INSTALL_DIR` | Override the install directory |

**Post-install steps:**

1. Edit `~/.config/ihub-apps/.env` to add your API keys
2. Run `ihub-apps` to start the server
3. Open **http://localhost:3000**

> **Windows users**: Download the `.zip` from [GitHub Releases](https://github.com/intrafind/ihub-apps/releases) — the shell installer does not support Windows.

- ✅ Detects OS and architecture automatically
- ✅ Offers Docker if available on your system
- ✅ Verifies download integrity with checksums
- ✅ Generates a secure JWT secret automatically
- ✅ Upgrade-safe — re-run at any time to update

---

### 📦 Binary (Recommended for most users)

The fastest way to run iHub — a single executable with zero dependencies.

```bash
# Download, extract, run
tar -xzf ihub-apps-v*-linux.tar.gz && cd ihub-apps-v* && ./ihub-apps-v*-linux
```

- ✅ Zero dependencies — no Node.js, no Docker required
- ✅ Auto-setup — creates default configuration on first run
- ✅ Cross-platform — Windows, macOS, Linux binaries
- ✅ Production-ready — optimized single executable

📥 **[Download from GitHub Releases](https://github.com/intrafind/ihub-apps/releases)**

---

### 🐳 Docker (Production)

```bash
docker run -d \
  -p 3000:3000 \
  -v $(pwd)/contents:/app/contents \
  --name ihub-apps \
  ghcr.io/intrafind/ihub-apps:latest
```

- ✅ Automatic local contents mounting
- ✅ Multi-platform support (Linux, macOS, Windows)
- ✅ Production-hardened container image

📖 **[Full Docker Guide](docker/DOCKER.md)** · **[Docker Quick Reference](docs/DOCKER-QUICK-REFERENCE.md)**

---

### 💻 npm (Development)

```bash
git clone https://github.com/intrafind/ihub-apps.git
cd ihub-apps
npm run setup:dev
npm run dev
# Open http://localhost:3000
```

Best for: customization, contributing, building new apps.

📖 **[Developer Setup Guide](docs/README.md)**

---

### 🖥️ Electron Desktop App

```bash
npm run install:all
npm run electron:dev
```

Best for: offline usage, desktop integration, kiosk deployments.

---

## 🔌 Extend & Customize

| What                         | Where                                                   |
| ---------------------------- | ------------------------------------------------------- |
| 📱 Create custom AI apps     | [App Creation Guide](docs/apps.md)                      |
| 🤖 Add LLM providers         | [Model Configuration](docs/models.md)                   |
| 📚 Connect knowledge sources | [Sources System](docs/sources.md)                       |
| 🔍 Enable web search tools   | [Web Tools](docs/web-tools.md)                          |
| 🔐 Configure SSO / OIDC      | [Authentication Guide](docs/external-authentication.md) |
| 🖥️ Local LLMs (privacy mode) | [Local LLM Providers](docs/local-llm-providers.md)      |
| 🔧 Full documentation        | [docs/README.md](docs/README.md)                        |

---

## ✨ Key Features

### 🤖 AI & LLM Integration

- **Multi-provider**: OpenAI, Anthropic Claude, Google Gemini, Mistral — unified API
- **Local LLMs**: LM Studio, Jan.ai, vLLM — complete privacy, zero API costs
- **Streaming responses**: Real-time token streaming via Server-Sent Events
- **Structured output**: JSON schema validation for AI responses
- **Tool calling**: Function calling and agentic workflows
- **Thinking models**: Extended reasoning support (Claude, o1-series)

### 📚 Knowledge & Sources

- **Filesystem**: Local markdown, text, and JSON files as AI context
- **Web pages**: Intelligent content extraction from any URL
- **Enterprise docs**: iFinder document management integration
- **Multi-source**: Combine multiple knowledge sources per app
- **Admin interface**: Create, test, and preview sources without coding

### 🛠️ Tools & Integrations

- **Web search**: Brave Search, Tavily, DuckDuckGo
- **Web extraction**: Clean content from any webpage
- **Deep research**: Multi-step iterative research with synthesis
- **Screenshots**: Playwright and Selenium-based page capture
- **File processing**: Upload and analyze PDFs, text, images, audio
- **Microsoft Entra**: Corporate directory and people search
- **Jira integration**: Issue tracking and project management

### 🔐 Security & Authentication

- **Multi-mode auth**: Anonymous, Local, OIDC, Proxy (JWT) — mix and match
- **SSO ready**: Google, Microsoft, Okta, Keycloak, any OIDC provider
- **Group permissions**: Hierarchical group inheritance with granular access control
- **Encrypted secrets**: AES-256-GCM encryption for stored credentials
- **CORS support**: Embed iHub in other web applications

### 🎨 Interface & UX

- **React SPA**: Built with Vite + Tailwind CSS for blazing-fast UI
- **Dark/light mode**: Automatic theme detection and manual switching
- **Mobile-friendly**: Responsive design for all screen sizes
- **Multi-language**: English, German, extensible to any language
- **Dynamic pages**: React components and Markdown content pages
- **Admin panel**: Full configuration management without code changes

### 📊 Operations & Scaling

- **Zero-config startup**: Auto-generates configuration on first run
- **Hot reload**: Config changes apply without server restart
- **Multi-worker**: Process clustering for production throughput
- **Config migrations**: Versioned, Flyway-style migration system
- **Health endpoint**: `/api/health` for load balancer probes
- **Audit logging**: Structured request and response logging

---

## 🏗️ Architecture

iHub Apps is a full-stack Node.js + React application:

- **Server** (`/server`): Express.js REST API with LLM adapters, auth middleware, and config management
- **Client** (`/client`): React/Vite SPA with Tailwind CSS, real-time streaming, and admin interface
- **Configuration** (`contents/`): JSON files for apps, models, groups, and platform settings — fully admin-editable

**Request flow**: Browser → Express → LLM Adapter → Provider API → Streaming SSE → Browser

The server is stateless — all configuration lives in the `contents/` directory, making it easy to mount, back up, and version-control your settings separately from the application.

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community guidelines.

- 🐛 **Report bugs**: [GitHub Issues](https://github.com/intrafind/ihub-apps/issues)
- 💡 **Request features**: [GitHub Issues](https://github.com/intrafind/ihub-apps/issues)
- 📖 **Full documentation**: [docs/README.md](docs/README.md)
- 💬 **Enterprise inquiries**: [sales@intrafind.com](mailto:sales@intrafind.com)

---

_Built with ❤️ by [IntraFind Software AG](https://intrafind.com/) — Berlin · Bonn · Munich · Remote_
