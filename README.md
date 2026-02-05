![INTRAFIND Logo iHub](https://github.com/user-attachments/assets/7aea35c8-1c3f-44f3-abad-528cfc5c65be)

# iHub Apps

**A comprehensive platform for building and deploying AI-powered applications with enterprise-grade features.**

**iHub Apps** is a full-stack application that provides a unified interface for interacting with multip
le AI models and integrating various knowledge sources. Built for both individual users and enterprise environments, it offers flexible authentication, powerful source management, and extensive customization capabilities.

Unleash creativity and productivity in your organization with **iHub** — the iHub that brings the power of generative AI directly into your secure corporate environment. Whether you need to compose emails, generate and edit texts, translate content, analyze files, or brainstorm ideas, **iHub** offers a suite of intuitive micro-apps designed for everyday business needs. With no prompting expertise required and full control over your data, **iHub** lets you work creatively and securely—on-premise or with carefully selected cloud models. Seamlessly integrate **iHub** with your existing **IntraFind** solutions and experience a unified platform for search, knowledge-based answers, and creative AI applications—all free and open source.

![INTRAFIND iHub Startpage](https://github.com/user-attachments/assets/f0495f7e-a0c8-4c25-9e16-4b74d97a3f79)

**iHub** is developed by [**IntraFind Software AG**](https://intrafind.com/) - made with ❤️ from our teams in Berlin, Bonn, Munich + Remote

The Software is free-of-use and "AS-IS without warranty of any kind. - Check the [License Details](LICENSE.md)

**For enterprise-grade support, custom features, or professional services, please contact us at [eMail](mailto:sales@intrafind.com).**

## 🚀 Quick Start

### 💻 For Developers

Get up and running in development mode with hot reload:

```bash
git clone <repository-url>
cd ihub-apps
bun run setup:dev
# Edit .env with your API keys (OpenAI, Anthropic, Google)
bun run dev
```

**📖 Need help?** See [Developer Setup Guide](#method-1-bun-installation-development) | [Complete Documentation](docs/README.md)

### 🏭 For Production

Deploy with Docker (recommended for production):

```bash
# Quick start with Docker
docker run -d \
  -p 3000:3000 \
  -v $(pwd)/contents:/app/contents \
  -e JWT_SECRET=your-secure-secret \
  -e OPENAI_API_KEY=your-key \
  --name ihub-apps \
  ghcr.io/intrafind/ihub-apps:latest
```

**🐳 More options:** [Docker Guide](docker/DOCKER.md) | [Binary Downloads](https://github.com/intrafind/ihub-apps/releases) | [Full Installation Guide](#-installation-overview)

---

## 🎆 **What Makes iHub Apps Special**

- **🤖 Multiple AI Providers**: OpenAI, Anthropic, Google, Mistral with unified interface
- **📚 Intelligent Knowledge Integration**: Access local files, web content, and enterprise documents
- **🔍 Advanced Web Tools**: Search, extract, and analyze web content automatically
- **🔐 Enterprise Security**: Multi-mode authentication with OIDC, JWT, and group-based permissions
- **🚀 Multiple Deployment Options**: npm, Docker, standalone binaries, and Electron desktop apps
- **🎨 Modern Interface**: React SPA with dark/light themes and mobile-friendly design
- **📊 Admin-Friendly**: Comprehensive administration interface for non-technical users

---

**📚 Documentation**: [docs/README.md](docs/README.md) | **🚀 Quick Start**: [Get Started](#-quick-start) | **📝 Help**: `/help` (after startup)

## 🗺️ Table of Contents

- [🚀 **Quick Start**](#-quick-start) - Get started in 2 minutes (dev or production)
- [📋 **Installation Overview**](#-installation-overview) - Detailed installation options and system requirements
- [📱 **Available Applications**](#-available-applications) - Pre-built AI applications for various use cases
- [✨ **Key Features**](#-key-features) - Core platform capabilities and integrations
- [🔐 **Authentication & Security**](#-authentication-and-authorization) - Enterprise-grade security setup
- [📚 **Source Handlers System**](#-source-handlers-system) - Knowledge integration and management
- [🛠️ **Advanced Tools**](#-advanced-tools--integrations) - Web tools and enterprise integrations
- [🏢 **Architecture**](#-architecture--implementation) - Technical implementation details
- [📊 **Documentation**](#-documentation) - Complete documentation index

When you run a production build, the complete documentation is available at `/help/index.html` in your browser.

## Purpose & Vision

iHub Apps bridges the gap between powerful AI models and practical business applications. Whether you're a developer building custom AI solutions, an enterprise looking for secure AI deployment, or a team needing intelligent document processing, iHub Apps provides the foundation for AI-powered workflows.

## 📱 Available Applications

iHub Apps comes with several pre-configured AI applications, each designed for specific use cases:

### 💬 **Chat Applications**

- **Basic Chat**: Conversational AI interface supporting multiple models
- **Chat with Web**: Web-enabled assistant with search and content extraction
- **Knowledge Assistant**: AI with access to integrated knowledge sources

### 🌍 **Translation & Language**

- **Translation**: Multi-language translation capabilities
- **Language processing**: Text analysis and linguistic tasks

### 📚 **Document & Content Management**

- **iFinder Document Explorer**: Enterprise document search and analysis
- **File Upload Processing**: Handle text files and PDFs with automatic processing
- **Content Analysis**: Analyze and summarize uploaded documents

### 🔍 **Research & Analysis**

- **Web Research**: Deep web research with iterative search
- **Content Extraction**: Extract and analyze web page content
- **Research Planning**: Break down complex research topics
- **Answer Evaluation**: Assess information quality and completeness

### 🛠️ **Specialized Tools**

- **Screenshot & PDF Capture**: Visual documentation tools
- **Query Optimization**: Improve search queries for better results
- **Data Processing**: Handle CSV, JSON, and structured data
- **Code Analysis**: Review and analyze code files

All applications are fully configurable and can be customized through the admin interface. New applications can be created by combining different AI models, tools, and knowledge sources.

## ✨ Key Features

### 🤖 **AI Integration**

- Multiple LLM providers (OpenAI, Anthropic, Google, Mistral)
- Streaming responses for real-time interaction
- Configurable token limits and model preferences
- Temperature and output format controls

### 📚 **Source Handlers System**

- **Filesystem Sources**: Local markdown, text, and JSON files
- **URL Sources**: Web pages with intelligent content extraction
- **iFinder Sources**: Enterprise document management integration
- **Page Sources**: Internal application pages (FAQ, documentation)
- **Flexible Integration**: Sources can be provided as context (prompt) or as callable tools
- **Admin Interface**: Comprehensive source management with testing and preview capabilities

### 🛠️ **Advanced Tools**

- **Web Search Tools**: Brave Search, Tavily Search, DuckDuckGo integration
- **Content Extraction**: Clean content extraction from any webpage
- **Research Tools**: Deep research, query rewriting, answer evaluation
- **Screenshot Tools**: Playwright and Selenium-based page capture
- **File Processing**: Upload and process text files and PDFs
- **iFinder Integration**: Enterprise document search and retrieval
- **Microsoft Entra**: Corporate directory and people search

### 🔐 **Authentication & Security**

- **Multiple Auth Modes**: Anonymous, Local, OIDC, Proxy (JWT)
- **Dual Authentication**: Multiple methods can be enabled simultaneously
- **Group-Based Permissions**: Hierarchical group inheritance system
- **Enterprise SSO**: OIDC integration for Google, Microsoft, and custom providers
- **Security Headers**: CORS support for web app integration

### 🎨 **User Interface**

- **Modern React SPA**: Built with Vite and Tailwind CSS
- **Dark/Light Mode**: Automatic theme switching support
- **Responsive Design**: Mobile-friendly interface
- **Real-time Chat**: EventSource streaming for live responses
- **Dynamic Pages**: Support for React components and Markdown content
- **Internationalization**: Multi-language support (English, German)

### 📊 **Administration**

- **Admin Panel**: Comprehensive configuration management
- **Source Management**: Create, edit, test, and preview knowledge sources
- **App Management**: Configure AI applications and prompts
- **Model Configuration**: Manage LLM providers and settings
- **User Management**: Group-based permission system
- **Content Editor**: Built-in editors for Markdown and JSON content

### 🚀 **Deployment Options**

- **npm**: Development and customization
- **Docker**: Production-ready containerization
- **Binary**: Standalone executables (no dependencies)
- **Electron**: Desktop application support
- **Auto-setup**: Automatic configuration on first startup

## 🏢 Architecture & Implementation

### Server

The server is implemented as a Node.js application, likely using a framework like Express.js to provide a REST API gateway. Its primary responsibilities include:

- **Configuration Loading:** Reads configuration files (e.g., JSON) defining available apps, language models (LLMs), endpoints, API keys, default styles, and the disclaimer text.
- **API Endpoints:**
  /api
  /api/apps
  /api/apps/{appId}
  /api/apps/{appId}/chat
  /api/apps/{appId}/chat/{chatId} #openai compatible chat completions endpoint, which supports streaming
  /api/models
  /api/models/{modelId}
  /api/models/{modelId}/chat #openai compatible chat completions endpoint, which supports streaming
  /api/disclaimer
  - Provides endpoints for the frontend to fetch the list of available apps (`/api/apps`).
  - Provides endpoints to fetch the list of available models (`/api/models`).
  - Provides an endpoint to fetch the disclaimer text (`/api/disclaimer`).
  - Provides the main endpoint for handling chat interactions (`/api/chat` or similar).

- **LLM Interaction:**
  - Receives chat messages from the frontend (formatted according to OpenAI's message structure).
  - Identifies the target LLM based on the user's selection or app configuration.
  - Forwards the request, including the conversation history and system prompt, to the appropriate remote LLM API endpoint.
  - Manages API keys required for different LLM services.
- **Response Streaming:** Receives the response stream from the LLM and forwards it back to the connected frontend client using either WebSockets or Server-Sent Events (SSE) for real-time updates.

## Initial Concept

We want to build an application for users to get started working with AI-enabled applications. These applications are using LLMs and we want to let user use them to support their daily work.
The application consists of a start page. When the user opens the start page, the user will be asked for a username, which is only stored in browser local storage, but also used when using our apps. We use this name to personalize the experience as well as tracking who did what. The user can decide to stay anonymous, in this case we generate a username.
When the user returns to the web application, we will show them their last name, if available. Below the input for the username, we also show a disclaimer, which has been loaded from the backend.
After the user has chosen a username on the start page, the web application switches to the next screen. This app overview screen shows his/her/its name and loads the apps from the backend. A maximum of 7 apps are shown. If we have more apps, we show also show a more button. The apps which are loaded from the backend, can be configured in a json file in the backend. Each app consists of a name, a description, a color, an icon, a system, a token limit, a preferred model, a preferred output format (like markdown, html, pure text, ...) and an optional prompt which can contain variables. These variables can have a type like string, date, number or boolean. The variables can have predefined values which consists of a label as well as a text which will be used for replacing the variable in the prompt. The variables will be used to adjust the frontend and allow the user a simpler work / guidance what to fill out.
When a user has selected an app, the chat application opens, where the user can simply chat with the llms. These apps will help the user to translate text, these apps are specialized in generating content, these apps can be used to summarize content incl. voice of tone, writing style as well as the action for the summary like "just summarize", "extract the key facts", "highlight actions items", "list all decisions", "summarize and provide recommendations" or nothing as well as free text or just a full custom app, where the user can enter the system as well as user prompt.
At the app overview page the user can also search for apps via a search box on the page. The search is done purely on the client side.
A user can favorize apps as well as we are tracking which apps he/she/it has used before. This tracking is done in the browser and connected to the username. If the user has chosen a different name, they will not see the used apps from the last time.
When a user has chosen the app, the client will render a chat interface as well as a panel with the information about the app and if the app contains variables with the input fields. It is also possible to expand the system prompt and the normal prompt as well as an option to edit them. A user can save the changes, but they are not written back. A hint should be shown to the user that the changes are only temporarily until the next login.
When a user fills out the optional fields for the variables and enters their text for translation, summarization or whatever the apps is able to do, it will send all the information to the backend in the message format used by OpenAI to simulate a conversion between the assistant and the user.
The backend will send it to an OpenAI compatible LLM hosted remotely and waits for the answer to be streamed back. Our backend will then stream it to our frontend via either Websockets or Server Sent Events.

Example:
instructions: "Talk like a pirate.", #system prompt
input=[
{"role": "user", "content": "knock knock."},
{"role": "assistant", "content": "Who's there?"},
{"role": "user", "content": "Orange."},
] #the messages between the user and the assistant
We will send all messages which have been send before with the request, so we can simulate a conversion and allow the model to use the asked information before. For example, if we have asked to summarize it and afterwards ask to translate it, the llm knows that it has to use the summarized text.
We have to be careful about the context window. This means we should count the tokens on client side and check it against the limit configured in each app.
Our application will also load the available models from our server and if multiples ones are configured, we allow the user to switch the model. Each model has a remote url, an optional api key, a human readable name and a description what it excels in. Depending on the model, our backend will send the request to the configured url.
The conversation in our app looks like a chat with an assistant. A user can modify their input, they can send it again, can copy the text to easily extract it, allow a download for an answer as well as the whole chat.
The user can also tell the assistant how they want to have their response formatted. The user can also chose a certain writing style. Styles allow the user to customize how llm communicates, helping you achieve more while working in a way that feels natural to you. Styles could be:

Normal: Default responses from Claude

Concise: Shorter and more direct responses

Formal: Clear and polished responses

Explanatory: Educational responses for learning new concepts
The default styles are also configured on the backend side and loaded from our web application.
But also custom styles are possible, which are stored in the local storage.

All keys as well as texts has to support i18n / localization.
Therefore we want to build a web application which talks through a small node.js service with the LLMs.

## 🚀 Installation Overview

iHub Apps provides multiple installation methods to suit different use cases and environments. Choose the method that best fits your needs:

### Installation Methods Comparison

| Method     | Best For                               | Setup Time | System Requirements                      | Auto-Updates      |
| ---------- | -------------------------------------- | ---------- | ---------------------------------------- | ----------------- |
| **Bun**    | Development, customization             | ~3 min     | Bun 1.3+                                 | Manual            |
| **Docker** | Production, containerized environments | ~2 min     | Docker Engine 24.0+, Docker Compose 2.0+ | Container restart |
| **Binary** | Quick deployment, no dependencies      | ~1 min     | OS-specific (Windows, macOS, Linux)      | Manual download   |

### Quick Start Commands

```bash
# Bun Installation (Development)
git clone <repository-url> && cd ihub-apps
bun run setup:dev
# Edit .env with your API keys, then run: bun run dev

# Docker Installation (Production-ready)
docker run -p 3000:3000 -e JWT_SECRET=your-secret ghcr.io/intrafind/ihub-apps:latest

# Binary Installation (Standalone)
# Download from: https://github.com/intrafind/ihub-apps/releases
# Extract and run the executable

# Electron Desktop App
bun run install:all && bun run electron:dev
```

### Choosing Your Installation Method

- **Choose Bun** if you need to customize code, develop features, or contribute to the project (recommended for development)
- **Choose Docker** for production deployments, containerized environments, or easy scaling
- **Choose Binary** for quick setup, no dependencies, or when Bun is not available
- **Choose Electron** for a desktop application experience or offline usage

### System Requirements

#### Minimum Requirements by Installation Method

**Bun Installation:**

- Bun 1.3.0 or higher
- 2GB RAM, 1GB free disk space

**Docker Installation:**

- Docker Engine 24.0 or higher
- Docker Compose 2.0 or higher (for development)
- 2GB RAM, 4GB free disk space
- Linux, macOS, or Windows with WSL2

**Binary Installation:**

- **Windows:** Windows 10 or higher
- **macOS:** macOS 10.15 (Catalina) or higher
- **Linux:** glibc 2.17 or higher (most modern distributions)
- 1GB RAM, 500MB free disk space
- No additional dependencies

### Quick Links

- [Complete Documentation](docs/README.md) - Full documentation portal
- [Comprehensive Docker Guide](docker/DOCKER.md)
- [Docker Quick Reference](docs/DOCKER-QUICK-REFERENCE.md)
- [Binary Downloads](https://github.com/intrafind/ihub-apps/releases)
- [Sources System](docs/sources.md) - Knowledge source integration
- [Web Tools](docs/web-tools.md) - Web search and content extraction
- [Authentication Guide](docs/external-authentication.md) - Security setup

## Setup and Installation

### Method 1: Bun Installation (Development)

**Best for:** Development, customization, contributing to the project

#### Prerequisites

- Bun 1.3.0 or higher

#### Installation Steps (Development)

1. Install Bun (if not already installed):

   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

2. Clone the repository:

   ```bash
   git clone <repository-url>
   cd ihub-apps
   ```

2. **Set up the development environment:**

   ```bash
   bun run setup:dev
   # This will copy .env.example to .env and install all dependencies
   ```

3. **Configure API keys:**

   Edit the `.env` file with your API keys:

   ```bash
   # Required API keys
   OPENAI_API_KEY=sk-...
   CLAUDE_3_SONNET_API_KEY=sk-ant-...
   GEMINI_API_KEY=AIza...
   ```

4. **Optional tools setup:**

   ```bash
   bunx playwright install (optional)
   # Selenium tools require Chrome or Chromium in your PATH
   ```

5. **Start the application** (automatically sets up default configuration):

   ```bash
   bun run dev
   ```

   🎉 **That's it!** The server will automatically create default configuration files on first startup, so you can start using iHub Apps immediately.

### Method 2: Docker Installation (Recommended for Production)

**Best for:** Production deployments, containerized environments, easy scaling

#### Prerequisites

- Docker Engine 24.0 or higher
- Docker Compose 2.0 or higher

#### Quick Start with Docker

1. **Using pre-built images (fastest):**

   ```bash
   # Pull and run the latest version
   docker run -d \
     -p 3000:3000 \
     -v $(pwd)/contents:/app/contents \
     -e JWT_SECRET=your-secure-secret \
     --name ihub-apps \
     ghcr.io/intrafind/ihub-apps:latest
   ```

2. **Using Docker Compose for development:**

   ```bash
   # Clone repository and setup environment
   git clone <repository-url>
   cd ihub-apps
   cp .env.example .env  # Edit with your API keys

   # Start development environment (auto-mounts local contents/)
   npm run docker:up
   ```

3. **Access the application:**
   - **Development**: http://localhost:3000 (API) + http://localhost:5173 (Hot reload UI)
   - **Production**: http://localhost:3000 (Combined server + UI)

**Docker Features:**

- ✅ **Automatic local contents mounting** - Changes to `contents/` folder appear instantly
- ✅ **Auto-setup** - Creates default configuration if `contents/` is empty
- ✅ **Persistent data** - User data and uploads stored in Docker volumes
- ✅ **Multi-platform** - Supports Linux, macOS, and Windows

For comprehensive Docker documentation, see [docker/DOCKER.md](docker/DOCKER.md).

### Method 3: Binary Installation (Standalone)

**Best for:** Quick deployment, no dependencies, environments without Node.js

#### Prerequisites

- Windows 10+, macOS 10.15+, or Linux (glibc 2.17+)
- No additional dependencies required

#### Installation Steps

1. **Download the latest binary:**

   Visit [GitHub Releases](https://github.com/intrafind/ihub-apps/releases) and download:
   - **Complete package** (recommended): `ihub-apps-v<version>-<platform>.tar.gz` or `.zip`
   - **Standalone executable**: `ihub-apps-v<version>-<platform>`
   - **Base64 encoded** (for restricted environments): `ihub-apps-v<version>-<platform>.tar.gz.base64.txt` or `.zip.base64.txt`

   💡 **Tip for restricted environments:** If you cannot download zip/tar.gz files directly, use the `.base64.txt` files:

   ```bash
   # Download the base64 file and decode it
   base64 -d ihub-apps-v*-linux.tar.gz.base64.txt > ihub-apps-v*-linux.tar.gz
   # Then extract normally
   tar -xzf ihub-apps-v*-linux.tar.gz
   ```

2. **Extract and run:**

   ```bash
   # macOS/Linux - Complete package
   tar -xzf ihub-apps-v*-linux.tar.gz
   cd ihub-apps-v*
   ./ihub-apps-v*-linux

   # Windows - Complete package
   # Extract the .zip file and run ihub-apps-v*-win.bat

   # Standalone executable (any platform)
   chmod +x ihub-apps-v*-linux  # Linux/macOS only
   ./ihub-apps-v*-linux
   ```

3. **Configure environment variables (optional):**

   ```bash
   export JWT_SECRET=your-secure-secret
   export OPENAI_API_KEY=your-openai-key
   export PORT=3000
   ```

**Binary Features:**

- ✅ **Zero dependencies** - Complete standalone application
- ✅ **Auto-setup** - Creates default configuration on first run
- ✅ **Cross-platform** - Windows, macOS, and Linux binaries
- ✅ **Production-ready** - Optimized single executable

### Method 4: Electron Desktop Application

**Best for:** Desktop app experience, offline usage, system integration

#### Prerequisites

- Node.js 22.x or higher (for building)
- npm 8.x or higher

#### Installation Steps

1. **Clone and install dependencies:**

   ```bash
   git clone <repository-url>
   cd ihub-apps
   npm run install:all
   ```

2. **Run in development mode:**

   ```bash
   npm run electron:dev
   ```

3. **Build desktop installers:**

   ```bash
   npm run electron:build
   ```

   This creates platform-specific installers in the `dist-electron/` directory.

4. **Connect to remote server (optional):**

   ```bash
   REMOTE_SERVER_URL=https://your-server.com npm run electron:dev
   ```

**Electron Features:**

- ✅ **Native desktop experience** - System tray, notifications, file associations
- ✅ **Offline capable** - Can work without internet connection
- ✅ **Cross-platform** - Windows, macOS, and Linux applications
- ✅ **Remote server support** - Connect to existing iHub Apps deployments

### Automatic Configuration Setup

**New in this version**: iHub Apps automatically sets up default configuration when you start the server for the first time!

- ✅ **Zero Configuration**: No manual setup required
- ✅ **Smart Detection**: Only runs setup when the contents directory is empty
- ✅ **Non-Destructive**: Never overwrites existing configuration files
- ✅ **Works Everywhere**: Development, production, and packaged binary deployments

**What happens on first startup:**

1. Server checks if the `contents` directory is empty
2. If empty, copies default configuration from `server/defaults`
3. Includes all apps, models, prompts, and platform settings
4. Server continues normal startup with the new configuration

**Custom contents directory:**

```bash
# Use a different directory for configuration
CONTENTS_DIR=my-custom-config npm run dev
```

The automatic setup works with any custom contents directory you specify.

### Development

To run the application in development mode:

```bash
npm run dev
```

This will:

- Start the Node.js server on port 3000
- Launch the Vite development server for the client
- Enable hot reloading for both client and server changes

### Code Quality and Linting

The project uses automated linting and formatting to ensure code quality:

```bash
# Check all files for linting issues
npm run lint

# Auto-fix linting issues where possible
npm run lint:fix

# Format all files with Prettier
npm run format

# Check if files are properly formatted
npm run format:check
```

**Automated Systems:**

- **Pre-commit hooks**: Automatically run linting on staged files
- **CI/CD**: GitHub Actions runs linting checks on PRs and pushes
- **ESLint 9.x**: Modern flat config with comprehensive rules
- **Prettier**: Consistent code formatting

**Important**: Always run `npm run lint:fix` before committing. Pre-commit hooks will prevent commits with linting errors.

### Testing Server Startup

After making changes to server code, always test that the server starts correctly:

```bash
# Run linting first, then test server startup
npm run lint:fix

# Test server startup with timeout to catch errors quickly
timeout 10s node server/server.js || echo "Server startup check completed"

# Test full development environment
timeout 15s npm run dev || echo "Development environment startup check completed"
```

This should be done after every build or significant refactoring to ensure no linting errors, import errors, missing dependencies, or runtime errors.

## 🏭 Building for Production

### Standard Production Build

To create a production build:

```bash
npm run prod:build
```

This creates a `dist` directory containing:

- Optimized client build in `dist/public`
- Server files in `dist/server`
- Application content and configuration in `dist/contents`
- Example setups in `dist/examples`
- Production dependencies alongside `package.json`

To start the production build:

```bash
npm run start:prod
```

### Building Your Own Binary (Advanced)

**For developers:** You can build your own binary from source.

**Prerequisite:** Node.js 22 or newer is required for creating the binary.

```bash
# Check Node.js version
node -v

# Build binary from source
./build.sh --binary
```

This creates versioned executables in the `dist-bin` directory along with configuration files and assets.

## Configuration

### Server Configuration

The server can be configured through environment variables or by editing the `config.env` file:

| Variable            | Description                | Default     |
| ------------------- | -------------------------- | ----------- |
| `PORT`              | Port the server listens on | `3000`      |
| `HOST`              | Host interface to bind to  | `0.0.0.0`   |
| `REQUEST_TIMEOUT`   | LLM request timeout (ms)   | `60000`     |
| `WORKERS`           | Number of cluster workers  | `CPU count` |
| `OPENAI_API_KEY`    | OpenAI API key             | (required)  |
| `ANTHROPIC_API_KEY` | Anthropic API key          | (required)  |
| `GOOGLE_API_KEY`    | Google AI API key          | (required)  |

The maximum JSON request body size is configured via the `requestBodyLimitMB` option in `contents/config/platform.json`.
Outbound request concurrency can also be tuned with the `requestConcurrency` setting in the same file and overridden per model or tool. Values below `1` or an omitted setting result in unlimited concurrency.

### SSL Configuration

For HTTPS support, set these environment variables or define them in `config.env`:

| Variable   | Description                       |
| ---------- | --------------------------------- |
| `SSL_KEY`  | Path to SSL private key           |
| `SSL_CERT` | Path to SSL certificate           |
| `SSL_CA`   | Path to CA certificate (optional) |

For handling external services with self-signed certificates, see [docs/ssl-certificates.md](docs/ssl-certificates.md).

Example of running with custom configuration:

```bash
PORT=8080 HOST=127.0.0.1 WORKERS=4 npm run start:prod
```

Or with the binary (replace `${VERSION}` with the current version):

```bash
PORT=8080 HOST=127.0.0.1 WORKERS=4 ./dist-bin/ihub-apps-v${VERSION}-macos
```

## 🔄 Update Procedures

### Updating npm Installation

```bash
# Pull latest changes
git pull origin main

# Update dependencies
npm run install:all

# Restart development server
npm run dev
```

### Updating Docker Installation

```bash
# Pull latest image
docker pull ghcr.io/intrafind/ihub-apps:latest

# Stop current container
docker stop ihub-apps
docker rm ihub-apps

# Start with new image (preserving data)
docker run -d \
  -p 3000:3000 \
  -v $(pwd)/contents:/app/contents \
  -e JWT_SECRET=your-secure-secret \
  --name ihub-apps \
  ghcr.io/intrafind/ihub-apps:latest

# Or using Docker Compose
npm run docker:down
docker-compose pull
npm run docker:up
```

### Updating Binary Installation

1. **Backup your configuration:**

   ```bash
   # Create backup of contents directory
   cp -r contents contents-backup-$(date +%Y%m%d)
   ```

2. **Download new version:**

   Visit [GitHub Releases](https://github.com/intrafind/ihub-apps/releases) and download the latest binary.

3. **Replace executable and restart:**

   ```bash
   # Stop current application (Ctrl+C)
   # Replace the executable file
   chmod +x ihub-apps-v*-new-version  # Linux/macOS

   # Start new version (it will use existing contents/)
   ./ihub-apps-v*-new-version
   ```

**Note:** Your `contents/` directory (containing apps, models, and data) is preserved between updates.

### Updating Electron Application

```bash
# Update source code
git pull origin main

# Update dependencies
npm run install:all

# Rebuild application
npm run electron:build
```

### Version Checking

Check your current version:

```bash
# npm installation
npm run --silent version

# Docker container
docker exec ihub-apps cat /app/package.json | grep version

# Binary
./ihub-apps-v*-platform --version

# Web interface
# Visit /api/health endpoint for version information
curl http://localhost:3000/api/health
```

### Migration Notes

- **Configuration files** in `contents/config/` are automatically migrated
- **User data** in `contents/data/` and `contents/uploads/` is preserved
- **Custom apps and models** are maintained across updates
- **Breaking changes** are documented in release notes

## 🔐 Authentication and Authorization

iHub Apps includes a comprehensive authentication system supporting multiple authentication modes with enterprise-grade security.

### Authentication Modes

The system supports four authentication modes with **dual authentication capability**:

| Mode          | Description                | Use Case                            |
| ------------- | -------------------------- | ----------------------------------- |
| **Anonymous** | No authentication required | Public demos, open access           |
| **Local**     | Built-in username/password | Development, small teams            |
| **OIDC**      | OpenID Connect integration | Enterprise SSO, Google, Microsoft   |
| **Proxy**     | Reverse proxy + Pure JWT   | nginx, OAuth2 Proxy, corporate auth |

**NEW**: Multiple authentication methods can be enabled simultaneously! Users can authenticate via local login, OIDC providers, or JWT tokens based on their preference and your configuration.

### Quick Start

**Default Setup (No Authentication):**

```bash
# Just start the application - works out of the box!
npm run dev
```

All users have full access to all apps and features by default.

**Enable Local Authentication:**

```bash
# Set environment variables
export LOCAL_AUTH_ENABLED=true
export JWT_SECRET=your-secure-secret

# Or edit contents/config/platform.json
{
  "auth": { "mode": "local" },
  "localAuth": { "enabled": true }
}
```

**Enable Dual Authentication (Local + OIDC):**

```json
{
  "auth": { "mode": "oidc" },
  "localAuth": { "enabled": true },
  "oidcAuth": { "enabled": true }
}
```

**Enable Pure JWT Authentication:**

```json
{
  "auth": { "mode": "proxy" },
  "proxyAuth": {
    "enabled": true,
    "jwtProviders": [
      {
        "name": "your-provider",
        "issuer": "https://your-provider.com",
        "audience": "ihub-apps",
        "jwkUrl": "https://your-provider.com/.well-known/jwks.json"
      }
    ]
  }
}
```

**Demo Accounts:**

- Admin: `admin` / `password123`
- User: `user` / `password123`

### Admin Access Security

The admin panel uses a **strict security model** based on authentication mode:

| Auth Mode            | Admin Access          | Admin Secret |
| -------------------- | --------------------- | ------------ |
| **Anonymous**        | Admin secret required | ✅ Enabled   |
| **Local/OIDC/Proxy** | User groups only      | ❌ Disabled  |

**Benefits:**

- **No bypass attacks** - Admin secret can't bypass proper authentication
- **Dynamic admin groups** - Configure admin access without code changes
- **Seamless UX** - Admin users go directly to admin panel

### Permission System

Access control uses group-based permissions:

```json
{
  "groups": {
    "admin": {
      "apps": ["*"],
      "prompts": ["*"],
      "models": ["*"],
      "adminAccess": true
    },
    "user": {
      "apps": ["chat", "translator"],
      "prompts": ["general"],
      "models": ["gpt-3.5-turbo"],
      "adminAccess": false
    }
  }
}
```

### ⚙️ Configuration

Authentication is configured in `contents/config/platform.json`:

```json
{
  "auth": {
    "mode": "local",
    "authenticatedGroup": "authenticated"
  },
  "anonymousAuth": {
    "enabled": false
  },
  "authorization": {
    "adminGroups": ["admin", "admins"],
    "userGroups": ["user", "users"]
  }
}
```

For complete authentication documentation, see:

- [External Authentication Guide](docs/external-authentication.md)
- [OIDC Authentication Setup](docs/oidc-authentication.md)
- [Security Implementation Details](concepts/2025-07-20-Final-Authentication-Security-Implementation.md)

## 📚 Source Handlers System

iHub Apps includes a comprehensive source handlers system that provides unified access to different types of knowledge sources. This system enables AI applications to dynamically access and integrate content from multiple sources.

### Supported Source Types

#### 1. FileSystem Sources

Load content from local files within the `contents/sources/` directory:

- Markdown (.md), Text (.txt), JSON (.json) files
- UTF-8 text-based formats
- Internal documentation and knowledge base articles

#### 2. URL Sources

Fetch and process content from web URLs with intelligent content extraction:

- External documentation and company websites
- Automatic content cleaning and extraction
- Configurable timeout, retry logic, and content limits
- Metadata extraction (title, description)

#### 3. iFinder Sources

Enterprise document management system integration:

- Document search functionality
- User authentication support
- Specific document retrieval by ID
- Configurable search profiles

#### 4. Page Sources

Access internal application pages as sources:

- FAQ pages, help documentation
- Dynamic content pages
- Multi-language support

### Source Integration Modes

**Prompt Mode (`exposeAs: "prompt")`**:

- Content loaded immediately and included in AI prompt
- Suitable for static, contextual information
- Content appears in XML tags with metadata

**Tool Mode (`exposeAs: "tool")`**:

- Source becomes a callable tool for the AI
- Content loaded only when AI calls the tool
- Reduces token usage for large sources
- Perfect for dynamic, searchable content

### Administration Interface

The source system includes a comprehensive admin interface at `/admin/sources`:

- **Source Management**: Create, edit, delete, and organize sources
- **Connection Testing**: Verify source connectivity and content
- **Content Preview**: View source content before saving
- **File Operations**: Browse, edit, and upload source files
- **Dependency Tracking**: View which apps use each source
- **Performance Statistics**: Monitor source usage and cache performance

For detailed source system documentation, see [Sources Documentation](docs/sources.md).

## 🛠️ Advanced Tools & Integrations

### Web Tools

iHub Apps includes powerful web integration capabilities:

- **Enhanced Web Search**: Combined search with automatic content extraction
- **Web Content Extractor**: Clean content extraction from any webpage
- **Search Providers**: Brave Search, Tavily Search integration
- **Screenshot Tools**: Playwright and Selenium page capture
- **Research Tools**: Deep research, query rewriting, answer evaluation

### File Upload & Processing

- **Text File Support**: .txt, .md, .csv, .json, .html, .css, .js files
- **PDF Processing**: Automatic conversion to markdown
- **File Size**: Up to 10MB supported
- **AI Integration**: Automatic content inclusion in conversations

### Enterprise Integrations

- **iFinder Document Management**: Full document search and retrieval
- **Microsoft Entra**: Corporate directory and people search
- **Tool Chaining**: Combine multiple tools for complex workflows

For complete tools documentation, see:

- [Web Tools Documentation](docs/web-tools.md)
- [Tools Configuration](docs/tools.md)
- [File Upload Feature](docs/file-upload-feature.md)

## ⚙️ Configuration Files

Configuration JSON files are kept in `contents/config` during development. When building, they are copied to `dist/contents/config`.

### apps.json

This file defines all available applications in the iHub. Each app has the following structure:

```json
{
  "id": "unique-id",
  "name": {
    "en": "App Name",
    "de": "App Name German"
  },
  "description": {
    "en": "Short description of the app",
    "de": "Kurze Beschreibung der App"
  },
  "color": "#HEXCOLOR",
  "icon": "icon-name",
  "system": {
    "en": "System prompt text for the LLM",
    "de": "Systemaufforderungstext für das LLM"
  },
  "tokenLimit": 16000,
  "preferredModel": "model-id",
  "preferredTemperature": 0.7,
  "preferredOutputFormat": "markdown",
  "variables": [
    {
      "name": "variableName",
      "type": "string",
      "label": {
        "en": "Human-readable label",
        "de": "Menschenlesbare Bezeichnung"
      },
      "predefinedValues": [
        {
          "label": {
            "en": "Option 1",
            "de": "Option 1 DE"
          },
          "value": "option1-value"
        }
      ],
      "required": true
    }
  ]
}
```

Variable types can be:

- `string`: Text input
- `text`: Multi-line text input
- `date`: Date picker
- `number`: Numeric input
- `boolean`: Toggle/checkbox
- `select`: Selection from predefined values

### models.json

This file defines the available LLM models:

```json
[
  {
    "id": "model-id",
    "name": "Model Name",
    "description": "Model description",
    "provider": "openai|anthropic|google",
    "maxTokens": 16000,
    "default": true,
    "endpointOverride": "https://custom-endpoint.com" (optional)
  }
]
```

Add `"default": true` to one model to designate it as the fallback when apps do not specify a preferred model.

The `provider` field determines which adapter is used to format requests to the LLM.

### styles.json

Defines writing styles available to the user:

```json
{
  "concise": "Please keep your responses brief and to the point.",
  "formal": "Please use formal language and a professional tone.",
  "explanatory": "Please provide detailed explanations suitable for someone learning the concept."
}
```

### ui.json

Configures the user interface elements:

```json
{
  "title": {
    "en": "iHub",
    "de": "KI-Hub"
  },
  "header": {
    "links": [
      {
        "name": {
          "en": "Home",
          "de": "Startseite"
        },
        "url": "/"
      }
    ]
  },
  "footer": {
    "text": {
      "en": "© 2025 iHub. All rights reserved.",
      "de": "© 2025 KI-Hub. Alle Rechte vorbehalten."
    },
    "links": [
      {
        "name": {
          "en": "Privacy Policy",
          "de": "Datenschutzerklärung"
        },
        "url": "/page/privacy"
      }
    ]
  },
  "disclaimer": {
    "text": {
      "en": "Disclaimer text...",
      "de": "Haftungsausschluss Text..."
    },
    "version": "1.0",
    "updated": "2023-01-01"
  },
  "pages": {
    "privacy": {
      "title": {
        "en": "Privacy Policy",
        "de": "Datenschutzerklärung"
      },
      "content": {
        "en": "# Privacy Policy Content in Markdown",
        "de": "# Datenschutzerklärung Inhalt in Markdown"
      }
    }
  }
}
```

## 🌍 Localization

The application supports internationalization through localization files:

### Server-side Localization

Server-side strings are built into the application under `shared/i18n/{lang}.json`.
Create files in `contents/locales/{lang}.json` to override individual keys if customization is needed.

### Client-side Localization

Client-side translations are shared with the server and stored in `shared/i18n/{lang}.json`.

### Adding a New Language

1. Create a new JSON file in `shared/i18n/` named after the language code (e.g., `fr.json`).
2. Optionally create an override file in `contents/locales/` if you need to customize specific keys.
3. Copy the structure from an existing language file and translate all values.
4. Update the language selector in `client/src/components/LanguageSelector.jsx` to include the new language.

## 📝 Creating Custom Pages

Custom pages can be added through the `ui.json` configuration in the `pages` section:

1. Add a new entry to the `pages` object:

   ```json
   "pages": {
     "page-id": {
       "title": {
         "en": "Page Title",
         "de": "Seitentitel"
       },
       "content": {
         "en": "# Page content in markdown format",
         "de": "# Seiteninhalt im Markdown-Format"
       }
     }
   }
   ```

2. The content field supports Markdown, which will be rendered by the application.

3. To link to the page from the header, add an entry to the `header.links` array:

   ```json
   "header": {
     "links": [
       {
         "name": {
           "en": "Page Title",
           "de": "Seitentitel"
         },
         "url": "/page/page-id"
       }
     ]
   }
   ```

4. To link to the page from the footer, add an entry to the `footer.links` array:
   ```json
   "footer": {
     "links": [
       {
         "name": {
           "en": "Page Title",
           "de": "Seitentitel"
         },
         "url": "/page/page-id"
       }
     ]
   }
   ```

Custom pages are rendered using the `UnifiedPage` component and are accessible at the path `/page/{id}`.

### React Component Pages

iHub Apps supports dynamic React component rendering for advanced page functionality:

1. **Create React component files** in `contents/pages/{lang}/{page-id}.jsx`
2. **Component Structure**:

   ```jsx
   function UserComponent(props) {
     const { React, useState, useEffect, t, navigate, user } = props;

     return <div className="p-4">{/* Your component JSX */}</div>;
   }
   ```

3. **Available Props**: Full React hooks, translation function, navigation, user context
4. **Styling**: Tailwind CSS classes available
5. **Auto-detection**: System automatically detects React vs Markdown content

For more details, see [React Component Feature](docs/react-component-feature.md).

## 👩‍💻 Development Guidelines

### Code Quality Standards

- **ESLint 9.x**: Modern flat config with comprehensive rules
- **Prettier**: Consistent code formatting with pre-commit hooks
- **Testing**: Always test server startup after changes
- **Documentation**: Update relevant docs when adding features

### Architecture Patterns

- **Modular Design**: Maintain the adapter pattern for LLM providers
- **Security First**: Follow authentication and authorization patterns
- **Source System**: Use the source handlers for knowledge integration
- **Tool Integration**: Follow established tool development patterns
- **API Consistency**: Maintain RESTful endpoint conventions

### UI/UX Standards

- **Theme Support**: All UI changes must support dark/light modes
- **Internationalization**: Include translations for new features
- **Responsive Design**: Mobile-friendly components
- **Accessibility**: Follow WCAG guidelines
- **Component Reuse**: Leverage existing design system components

### Development Workflow

```bash
# Always run before committing
npm run lint:fix

# Test server startup
timeout 10s node server/server.js || echo "Server startup check completed"

# Run development environment
npm run dev
```

## ❓ Frequently Asked Questions

### What's New in Recent Versions?

- **📚 Source Handlers System**: Unified knowledge source integration (filesystem, URLs, iFinder, pages)
- **🔍 Enhanced Web Tools**: Advanced web search, content extraction, and research capabilities
- **📎 File Upload Processing**: Support for text files and PDFs with automatic content integration
- **🔐 Improved Authentication**: Multi-mode authentication with simultaneous local and OIDC support
- **📊 Admin Interface Enhancements**: Comprehensive source management and testing capabilities
- **🎨 React Component Pages**: Dynamic page rendering with full React support

### Which Installation Method Should I Choose?

- **💻 Developers**: Use **npm installation** for customization and development
- **🚀 Production**: Use **Docker** for scalable, containerized deployments
- **⚡ Quick Setup**: Use **binary** for instant deployment without dependencies
- **🖥️ Desktop**: Use **Electron** for offline or desktop application use

### How Do I Add Knowledge Sources?

1. Access the admin interface at `/admin/sources`
2. Create a new source (filesystem, URL, iFinder, or page)
3. Test the source connection
4. Assign the source to your applications
5. Sources can be used as context (prompt) or callable tools

### Can I Use Multiple AI Providers?

Yes! iHub Apps supports multiple AI providers simultaneously:

- OpenAI (GPT-3.5, GPT-4, etc.)
- Anthropic (Claude models)
- Google (Gemini models)
- Mistral AI models
- Configure API keys and let users choose their preferred model

### Is iHub Apps Enterprise-Ready?

Absolutely! Enterprise features include:

- 🔐 OIDC/SSO integration (Google, Microsoft, custom providers)
- 📁 Group-based permissions with inheritance
- 📚 Enterprise document management (iFinder integration)
- 🔒 JWT authentication for secure API access
- 📊 Admin interface for non-technical management
- 🚀 Multiple deployment options (Docker, Kubernetes-ready)

---

**Need Help?** Check the [complete documentation](docs/README.md) or visit `/help` after starting the application.

---

_A default FAQ page with more detailed answers is also available in [contents/pages/en/faq.md](contents/pages/en/faq.md) and can be customized or translated._

## 📊 Documentation

Comprehensive documentation is available in the `/docs` directory and includes:

### Core Documentation

- [Complete Documentation Portal](docs/README.md) - Full documentation index
- [Getting Started Guide](docs/GETTING_STARTED.md) - Quick setup and first steps
- [Installation Guide](docs/INSTALLATION.md) - Detailed installation instructions
- [User Guide](docs/user-guide.md) - End-user documentation
- [Architecture Overview](docs/architecture.md) - System architecture and components
- [Architecture Diagrams](docs/diagrams.md) - Visual system documentation

### Configuration & Setup

- [Server Configuration](docs/server-config.md) - Server setup and tuning
- [Configuration Validation](docs/configuration-validation.md) - Config troubleshooting
- [Apps Configuration](docs/apps.md) - Application setup
- [Models](docs/models.md) - LLM configuration
- [Platform Configuration](docs/platform.md) - Core platform settings

### Security & Authentication

- [Security Guide](docs/security.md) - Comprehensive security implementation
- [External Authentication](docs/external-authentication.md) - Security and user management
- [OIDC Authentication](docs/oidc-authentication.md) - Enterprise SSO setup
- [JWT Authentication](docs/jwt-authentication.md) - Token-based authentication
- [SSL Certificates](docs/ssl-certificates.md) - SSL/TLS configuration

### Features & Integration

- [Sources System](docs/sources.md) - Knowledge source integration
- [Web Tools](docs/web-tools.md) - Web search and content extraction
- [File Upload](docs/file-upload-feature.md) - File processing capabilities
- [Tools System](docs/tools.md) - AI tool integration
- [iFinder Integration](docs/iFinder-Integration.md) - Enterprise document management
- [React Components](docs/react-component-feature.md) - Dynamic page rendering
- [Electron App](docs/electron-app.md) - Desktop application

### Development & Deployment

- [Developer Onboarding](docs/developer-onboarding.md) - Complete development setup
- [Docker Quick Reference](docs/DOCKER-QUICK-REFERENCE.md) - Fast Docker commands
- [Troubleshooting](docs/troubleshooting.md) - Problem diagnosis and solutions

### Additional Resources

The documentation is also available as a rendered mdBook at `/help` when running the application, providing an interactive browsing experience with search functionality.
