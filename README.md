![INTRAFIND Logo iHub](https://github.com/user-attachments/assets/7aea35c8-1c3f-44f3-abad-528cfc5c65be)

# iHub Apps

**19+ ready-to-use AI apps for your team. Self-hosted. No prompting expertise needed.**

[![License](https://img.shields.io/badge/License-Custom-blue.svg)](LICENSE.md)
[![Docker](https://img.shields.io/badge/Docker-ghcr.io%2Fintrafind%2Fihub--apps-blue)](https://github.com/intrafind/ihub-apps/pkgs/container/ihub-apps)
[![GitHub Stars](https://img.shields.io/github/stars/intrafind/ihub-apps)](https://github.com/intrafind/ihub-apps/stargazers)

```bash
docker run -d -p 3000:3000 -v $(pwd)/contents:/app/contents ghcr.io/intrafind/ihub-apps:latest
```

---

![INTRAFIND iHub Startpage](https://github.com/user-attachments/assets/f0495f7e-a0c8-4c25-9e16-4b74d97a3f79)

---

## Quick Start

**3 steps. Under 2 minutes.**

```bash
# 1. Clone and install
git clone https://github.com/intrafind/ihub-apps.git && cd ihub-apps
npm run setup:dev

# 2. Start
npm run dev

# 3. Open http://localhost:3000 → Settings → Models → Add your API key
```

That's it. iHub Apps auto-configures itself on first startup — no `.env` required.

---

## What's Included

19 pre-built AI apps, ready to use out of the box:

| App                             | Description                        |
| ------------------------------- | ---------------------------------- |
| 💬 **Chat**                     | General-purpose AI chat assistant  |
| 🌐 **Chat with Web**            | AI assistant with live web search  |
| 🌍 **Translator**               | Multi-language translation         |
| ✉️ **Email Composer**           | Draft professional emails          |
| 📝 **Content Summarizer**       | Summarize and extract key insights |
| 💡 **Idea Coach**               | Brainstorm and develop ideas       |
| 📊 **Mermaid Diagrams**         | Generate diagrams from text        |
| 🖼️ **Image Generator**          | AI image generation                |
| 📄 **File Analysis**            | Analyze text files and PDFs        |
| 🎵 **Audio Transcription**      | Transcribe audio files             |
| 📱 **Social Media**             | Create social media content        |
| ⚖️ **NDA Risk Analyzer**        | Analyze legal documents            |
| 🔍 **iFinder Document Actions** | Enterprise document search         |
| 🤖 **iAssistant Demo**          | Customizable AI assistant demo     |
| 🌐 **IntraFind Websites Bot**   | Chat with IntraFind documentation  |
| 🌍 **Wikipedia Assistant**      | Explore Wikipedia with AI          |
| 🌐 **External Website Bot**     | Chat with any website content      |
| 🎯 **iHub Support Bot**         | Self-service support assistant     |
| 📦 **Zoll Tarif Assistant**     | Customs tariff lookup assistant    |

All apps are fully configurable. Build your own in minutes — [see the guide](docs/apps.md).

---

## Deploy Anywhere

### Docker (recommended for production)

```bash
docker run -d \
  -p 3000:3000 \
  -v $(pwd)/contents:/app/contents \
  --name ihub-apps \
  ghcr.io/intrafind/ihub-apps:latest
```

→ [Complete Docker guide](docker/DOCKER.md)

### Standalone Binary (no dependencies)

Download the platform binary from [GitHub Releases](https://github.com/intrafind/ihub-apps/releases), extract, and run. Works on Windows, macOS, and Linux.

→ [Installation guide](docs/INSTALLATION.md)

### npm (for development and customization)

```bash
git clone https://github.com/intrafind/ihub-apps.git && cd ihub-apps
npm run setup:dev && npm run dev
```

→ [Developer onboarding](docs/developer-onboarding.md)

### Electron (desktop app)

```bash
npm run install:all && npm run electron:dev
```

→ [Electron guide](docs/electron-app.md)

---

## Extend

iHub Apps is built to be customized. Everything is configured via JSON files — no code changes needed.

- **[Create custom apps](docs/apps.md)** — Configure AI apps with prompts, variables, and tool access
- **[Add AI models](docs/models.md)** — Connect OpenAI, Anthropic, Google, Mistral, or local models (LM Studio, vLLM)
- **[Set up authentication](docs/external-authentication.md)** — Anonymous, local users, OIDC/SSO, or proxy auth
- **[Add knowledge sources](docs/sources.md)** — Files, websites, enterprise documents
- **[Configure web tools](docs/web-tools.md)** — Brave Search, Tavily, DuckDuckGo, content extraction
- **[Full documentation](docs/README.md)** — Complete reference

---

## Contributing

iHub Apps is developed by [IntraFind Software AG](https://intrafind.com/) — made with ❤️ from Berlin, Bonn, Munich + Remote.

The software is free to use under [our license](LICENSE.md). For enterprise support, custom features, or professional services: [sales@intrafind.com](mailto:sales@intrafind.com).

Contributions are welcome. See [Developer Onboarding](docs/developer-onboarding.md) to get started.
