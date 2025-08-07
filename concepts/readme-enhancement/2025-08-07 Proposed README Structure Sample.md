# Proposed README.md Structure Sample

**Document Date**: 2025-08-07  
**Document Type**: Implementation Sample  
**Purpose**: Demonstrate the proposed new installation section structure  

## Sample Implementation

This sample shows how the new installation section would appear in the README.md, replacing the current content from line 97 onwards.

---

## Installation Overview

Choose your installation method based on your needs. iHub Apps offers four installation options designed for different use cases and technical requirements:

| Method | Best For | Setup Time | Requirements | Skill Level |
|--------|----------|------------|--------------|-------------|
| 🚀 **Binary** | Quick evaluation, demos, non-technical users | 2 minutes | None | Beginner |
| 🐳 **Docker** | Production deployment, isolation, easy cleanup | 3 minutes | Docker Engine 24.0+ | Intermediate |
| 📦 **npm** | Development, customization, contributions | 5 minutes | Node.js 20+, npm 8+ | Advanced |
| 🖥️ **Electron** | Desktop application, offline use | 5 minutes | Node.js 20+ | Intermediate |

### Choose Your Path

- **Just want to try it?** → [Binary Installation](#-binary-installation-recommended-for-evaluation)
- **Production deployment?** → [Docker Installation](#-docker-installation-recommended-for-production)  
- **Want to contribute or customize?** → [Development Installation](#-development-installation-recommended-for-contributors)
- **Need a desktop app?** → [Desktop Application](#-desktop-application)

## Quick Installation Methods

### 🚀 Binary Installation (Recommended for Evaluation)

**Get started in 2 minutes with zero dependencies:**

1. **Download for your platform:**
   - [**Windows**](https://github.com/intrafind/ai-hub-apps/releases/latest/download/ai-hub-apps-win.zip) • [**macOS**](https://github.com/intrafind/ai-hub-apps/releases/latest/download/ai-hub-apps-macos.tar.gz) • [**Linux**](https://github.com/intrafind/ai-hub-apps/releases/latest/download/ai-hub-apps-linux.tar.gz)

2. **Extract and run:**
   ```bash
   # Windows
   ai-hub-apps-v{VERSION}-win.bat
   
   # macOS/Linux
   ./ai-hub-apps-v{VERSION}-macos    # or -linux
   ```

3. **Open http://localhost:3000** ✅

**Perfect for:** Quick evaluation, demos, non-technical users  
**No installation required:** Just download and run!

[📖 Detailed binary installation instructions →](#binary-installation-detailed)

---

### 🐳 Docker Installation (Recommended for Production)

**Production-ready deployment with automatic local contents mounting:**

1. **Install Docker Engine 24.0+** (if not already installed)

2. **Start with automatic local contents:**
   ```bash
   git clone https://github.com/intrafind/ai-hub-apps.git
   cd ai-hub-apps
   cp .env.example .env  # Edit with your API keys
   npm run docker:up
   ```

3. **Open http://localhost:3000** ✅

**Perfect for:** Production deployments, team environments, containerized infrastructure  
**Key benefit:** Automatic mounting of local `contents/` folder for easy configuration

[📖 Comprehensive Docker guide →](docker/DOCKER.md) • [🔧 Production deployment →](#docker-production-deployment)

---

### 📦 Development Installation (Recommended for Contributors)

**Full source code access with hot reloading:**

1. **Install prerequisites:**
   ```bash
   # Node.js 20.x or higher, npm 8.x or higher
   node -v && npm -v
   ```

2. **Clone and start development environment:**
   ```bash
   git clone https://github.com/intrafind/ai-hub-apps.git
   cd ai-hub-apps
   npm run install:all
   npm run dev
   ```

3. **Open http://localhost:3000** ✅

**Perfect for:** Developers, contributors, customization needs  
**Key benefits:** Hot reloading, full source access, development tools

[📖 Development setup details →](#development-installation-detailed)

---

### 🖥️ Desktop Application

**Native desktop experience with Electron:**

1. **Install Node.js 20+** (if not already installed)

2. **Build desktop application:**
   ```bash
   git clone https://github.com/intrafind/ai-hub-apps.git
   cd ai-hub-apps
   npm run install:all
   npm run electron:build
   ```

3. **Launch the installed application**

**Perfect for:** Desktop integration, offline use, native OS experience

[📖 Desktop app documentation →](#electron-desktop-application-detailed)

## Detailed Installation Instructions

### Binary Installation Detailed

#### System Requirements
- **Windows**: Windows 10 or later (x64)
- **macOS**: macOS 10.15 or later (Intel/Apple Silicon)  
- **Linux**: Ubuntu 18.04+ or equivalent (x64)
- **Memory**: 512MB available RAM
- **Storage**: 100MB free disk space
- **Network**: Internet connection for LLM API access

#### Step-by-Step Installation

1. **Download the latest release:**
   
   Visit [iHub Apps Releases](https://github.com/intrafind/ai-hub-apps/releases/latest) and download:
   - **Windows**: `ai-hub-apps-v{VERSION}-win.zip`
   - **macOS**: `ai-hub-apps-v{VERSION}-macos.tar.gz`
   - **Linux**: `ai-hub-apps-v{VERSION}-linux.tar.gz`

2. **Extract the package:**
   ```bash
   # Windows (using built-in extraction)
   # Right-click → Extract All
   
   # macOS
   tar -xzf ai-hub-apps-v{VERSION}-macos.tar.gz
   
   # Linux
   tar -xzf ai-hub-apps-v{VERSION}-linux.tar.gz
   ```

3. **Run the application:**
   ```bash
   # Windows
   cd ai-hub-apps-v{VERSION}-win
   ai-hub-apps.bat
   
   # macOS
   cd ai-hub-apps-v{VERSION}-macos
   ./ai-hub-apps
   
   # Linux  
   cd ai-hub-apps-v{VERSION}-linux
   chmod +x ai-hub-apps  # If needed
   ./ai-hub-apps
   ```

4. **Verify installation:**
   - Application starts and shows "Server running on port 3000"
   - Open http://localhost:3000 in your browser
   - You should see the iHub Apps interface

#### Configuration

The binary includes default configuration that works out of the box. To customize:

1. **Locate the contents directory:**
   - Same folder as the executable
   - Contains `config/`, `pages/`, and other configuration files

2. **Edit configuration files:**
   - `contents/config/platform.json` - Server and authentication settings
   - `contents/config/apps.json` - Available AI applications
   - `contents/config/models.json` - LLM model configurations

3. **Restart the application** to apply changes

#### Updating

To update to a new version:
1. Download the latest release
2. Stop the current application
3. Backup your `contents/` directory (if customized)
4. Extract the new version
5. Copy your customized `contents/` directory to the new version (if needed)
6. Start the new version

#### Troubleshooting

**Port 3000 already in use:**
```bash
# Windows
set PORT=8080 && ai-hub-apps.bat

# macOS/Linux
PORT=8080 ./ai-hub-apps
```

**Permission denied (macOS/Linux):**
```bash
chmod +x ai-hub-apps
./ai-hub-apps
```

**macOS Gatekeeper warning:**
- Right-click the executable → "Open" → "Open" (bypass Gatekeeper)
- Or: System Preferences → Security & Privacy → Allow anyway

---

### Docker Installation Detailed

#### System Requirements
- **Docker Engine**: 24.0 or later
- **Docker Compose**: 2.0 or later (included with Docker Desktop)
- **Memory**: 1GB available RAM
- **Storage**: 500MB free disk space
- **Platforms**: Linux, macOS, Windows with Docker Desktop

#### Quick Development Setup

The Docker setup automatically mounts your local `contents/` directory, making configuration changes instantly available:

1. **Prepare environment:**
   ```bash
   git clone https://github.com/intrafind/ai-hub-apps.git
   cd ai-hub-apps
   cp .env.example .env
   ```

2. **Configure API keys** (edit `.env`):
   ```bash
   OPENAI_API_KEY=your_openai_key
   ANTHROPIC_API_KEY=your_anthropic_key
   GOOGLE_API_KEY=your_google_key
   ```

3. **Start development environment:**
   ```bash
   npm run docker:up
   ```

4. **Access the application:**
   - **Main app**: http://localhost:3000 (Node.js server + static files)
   - **Vite dev server**: http://localhost:5173 (Hot reload development)

#### Production Deployment

For production use with optimized containers:

1. **Prepare production environment:**
   ```bash
   cp .env.example .env.production
   # Configure with production secrets
   ```

2. **Build and start production:**
   ```bash
   npm run docker:build:prod
   npm run docker:prod:up
   ```

3. **Access**: http://localhost:3000

#### Volume Strategy

- **Local contents**: Your entire `contents/` folder mounted read-write
- **Persistent data**: `contents/data/`, `contents/uploads/`, logs use Docker volumes
- **Configuration changes**: Immediately available without container restart

#### Docker Commands Reference

```bash
# Development
npm run docker:up              # Start dev environment
npm run docker:down            # Stop and remove containers
npm run docker:logs            # View container logs

# Production  
npm run docker:build:prod      # Build production image
npm run docker:prod:up         # Start production environment
npm run docker:prod:down       # Stop production environment

# Manual Docker commands
docker build -f docker/Dockerfile -t ai-hub-apps:dev --target development .
docker build -f docker/Dockerfile -t ai-hub-apps:prod --target production .
```

#### Troubleshooting

**Port conflicts:**
```bash
# Use different ports
PORT=8080 VITE_PORT=8173 npm run docker:up
```

**Permission issues with volumes:**
```bash
# Fix permissions (Linux/macOS)
sudo chown -R $USER:$USER contents/
```

**Container won't start:**
```bash
# Check logs
npm run docker:logs

# Rebuild images
npm run docker:build:dev
```

For comprehensive Docker documentation, see [docker/DOCKER.md](docker/DOCKER.md).

---

### Development Installation Detailed

This method provides full source code access with hot reloading for development and customization.

#### Prerequisites

- **Node.js**: 20.x or higher ([Download](https://nodejs.org/))
- **npm**: 8.x or higher (included with Node.js)
- **Git**: For cloning the repository

Verify your installation:
```bash
node -v    # Should show v20.x.x or higher
npm -v     # Should show 8.x.x or higher
```

#### Step-by-Step Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/intrafind/ai-hub-apps.git
   cd ai-hub-apps
   ```

2. **Install all dependencies:**
   ```bash
   npm run install:all
   npx playwright install
   # Playwright is used for testing; Chrome/Chromium required
   ```

   This installs dependencies for:
   - Root project (build tools, scripts)
   - Client application (React, Vite, etc.)  
   - Server application (Express, LLM adapters, etc.)

3. **Start the development environment:**
   ```bash
   npm run dev
   ```

   This starts:
   - Node.js server on port 3000 (backend API)
   - Vite development server on port 5173 (frontend with hot reload)

4. **Verify installation:**
   - Server console shows "Server running on port 3000"
   - Browser automatically opens to http://localhost:5173
   - Hot reloading works (try editing a file in `client/src`)

#### Automatic Configuration Setup

**New feature**: iHub Apps automatically sets up default configuration on first startup:

- ✅ **Zero Configuration**: No manual setup required
- ✅ **Smart Detection**: Only runs when `contents/` directory is empty  
- ✅ **Non-Destructive**: Never overwrites existing files
- ✅ **Works Everywhere**: Development, production, and binary deployments

**What happens on first startup:**
1. Server checks if `contents/` directory exists and has content
2. If empty, copies default configuration from `server/defaults/`
3. Includes all apps, models, prompts, and platform settings
4. Server continues normal startup with new configuration

#### Development Workflow

**File Structure:**
```
ai-hub-apps/
├── client/          # React frontend application
├── server/          # Node.js backend application  
├── contents/        # Configuration and content files
├── docker/          # Docker configuration
└── docs/           # Documentation
```

**Key Commands:**
```bash
# Development
npm run dev          # Start both client and server with hot reload
npm run dev:client   # Start only client (Vite dev server)
npm run dev:server   # Start only server (Node.js with nodemon)

# Code Quality
npm run lint         # Check all files for linting issues
npm run lint:fix     # Auto-fix linting issues  
npm run format       # Format all files with Prettier

# Testing
npm run test:all     # Test all LLM adapters
npm run test:openai  # Test OpenAI integration
npm run test:anthropic # Test Anthropic integration

# Building
npm run build        # Build client for production
npm run prod:build   # Build complete production package
```

#### Configuration for Development

**Environment Variables:**
Create `.env` file in the root directory:
```bash
# API Keys (required for LLM functionality)
OPENAI_API_KEY=your_openai_key
ANTHROPIC_API_KEY=your_anthropic_key
GOOGLE_API_KEY=your_google_key

# Server Configuration
PORT=3000
HOST=0.0.0.0
REQUEST_TIMEOUT=60000

# Development Settings
NODE_ENV=development
```

**Custom Contents Directory:**
```bash
# Use different directory for configuration
CONTENTS_DIR=my-custom-config npm run dev
```

#### Troubleshooting

**Port conflicts:**
```bash
# Check what's using port 3000/5173
lsof -i :3000
lsof -i :5173

# Use different ports
PORT=8000 VITE_PORT=8080 npm run dev
```

**npm install errors:**
```bash
# Clear npm cache
npm cache clean --force

# Delete node_modules and reinstall
rm -rf node_modules client/node_modules server/node_modules
npm run install:all
```

**Hot reload not working:**
```bash
# Restart development servers
npm run dev:client  # In one terminal
npm run dev:server  # In another terminal
```

**Permission errors (macOS/Linux):**
```bash
# Fix npm permissions
sudo chown -R $USER:$USER ~/.npm
sudo chown -R $USER:$USER node_modules
```

For additional development guidance, see [docs/README.md](docs/README.md).

---

## System Requirements Summary

| Component | Binary | Docker | npm | Electron |
|-----------|--------|--------|-----|----------|
| **OS** | Win10+, macOS 10.15+, Ubuntu 18+ | Docker Desktop | Win10+, macOS 10.15+, Ubuntu 18+ | Win10+, macOS 10.15+, Ubuntu 18+ |
| **Memory** | 512MB | 1GB | 2GB | 1GB |
| **Storage** | 100MB | 500MB | 1GB | 800MB |
| **Dependencies** | None | Docker 24.0+ | Node.js 20+, npm 8+ | Node.js 20+ |
| **Network** | Internet for APIs | Internet for APIs | Internet for APIs & packages | Internet for APIs |

## Getting Help and Support

### Documentation Resources
- **[Complete Documentation](docs/README.md)** - Comprehensive guides and API reference
- **[Docker Guide](docker/DOCKER.md)** - Detailed Docker deployment documentation  
- **[Authentication Setup](docs/external-authentication.md)** - Enterprise authentication configuration
- **[Development Guide](CLAUDE.md)** - Development patterns and contribution guide

### Community Support
- **[GitHub Issues](https://github.com/intrafind/ai-hub-apps/issues)** - Bug reports and feature requests
- **[GitHub Discussions](https://github.com/intrafind/ai-hub-apps/discussions)** - Questions and community help
- **[FAQ](contents/pages/en/faq.md)** - Frequently asked questions

### Common Issues Quick Links
- [Port conflicts](#troubleshooting) - When ports 3000/5173 are in use
- [Permission issues](#troubleshooting) - macOS/Linux executable permissions  
- [API key setup](#configuration) - Configuring LLM provider keys
- [Docker problems](docker/DOCKER.md#troubleshooting) - Container and volume issues

---

*Ready to get started? Choose your [installation method](#installation-overview) above and have iHub Apps running in minutes!*

---

## [Rest of existing README content continues from here...]

## Building for Production

[Existing content from line 214 onwards, with updates to reflect the new structure...]
