# iHub Apps Installation Guide

**Complete installation guide for all deployment methods**

This guide provides comprehensive installation instructions for iHub Apps across all supported methods and platforms. Whether you're evaluating the application, deploying to production, or setting up a development environment, this guide will help you get started quickly.

## Table of Contents

- [Quick Start](#quick-start)
- [Installation Methods Overview](#installation-methods-overview)
- [System Requirements](#system-requirements)
- [Installation Instructions](#installation-instructions)
  - [Method 1: Binary Installation (Recommended for Evaluation)](#method-1-binary-installation-recommended-for-evaluation)
  - [Method 2: Docker Installation (Recommended for Production)](#method-2-docker-installation-recommended-for-production)
  - [Method 3: npm Installation (For Development)](#method-3-npm-installation-for-development)
  - [Method 4: Electron Desktop Application](#method-4-electron-desktop-application)
- [Post-Installation Setup](#post-installation-setup)
- [Configuration](#configuration)
- [Update Procedures](#update-procedures)
- [Troubleshooting](#troubleshooting)
- [Security Considerations](#security-considerations)

## Quick Start

**Want to try iHub Apps in under 2 minutes?**

1. **Download the latest binary** from [GitHub Releases](https://github.com/intrafind/ai-hub-apps/releases)
2. **Extract and run** the platform-specific executable
3. **Open** http://localhost:3000 in your browser
4. **Start using** the pre-configured AI applications

That's it! No dependencies, no complex setup required.

## Installation Methods Overview

iHub Apps offers four installation methods designed for different use cases:

### Method Comparison

| Method | Best For | Setup Time | Dependencies | Auto-Updates | Isolation | Customization |
|--------|----------|------------|--------------|--------------|-----------|---------------|
| **🚀 Binary** | Quick evaluation, demos | 2 minutes | None | Manual download | OS-level | Limited |
| **🐳 Docker** | Production, CI/CD | 3 minutes | Docker Engine | Container restart | Full isolation | Via volumes |
| **📦 npm** | Development, contributions | 5 minutes | Node.js, npm | Git pull | None | Full access |
| **🖥️ Electron** | Desktop app, offline use | 5 minutes | Node.js (build) | Manual rebuild | App sandbox | Build-time |

### When to Choose Each Method

**Choose Binary if you:**
- Want to evaluate iHub Apps quickly
- Need a standalone application with no dependencies
- Are running in environments without Docker or Node.js
- Prefer simple update procedures
- Don't need extensive customization

**Choose Docker if you:**
- Are deploying to production environments
- Need containerized deployment for scaling
- Want easy rollback and update procedures
- Require process isolation and security
- Are using CI/CD pipelines

**Choose npm if you:**
- Are developing features or contributing code
- Need to customize the application extensively
- Want hot reloading during development
- Are comfortable with Node.js development
- Need access to the full source code

**Choose Electron if you:**
- Want a native desktop application experience
- Need offline capability
- Require system integration (notifications, file associations)
- Prefer desktop app UX over web interface

## System Requirements

### Minimum Hardware Requirements

- **Memory**: 2GB RAM (4GB recommended for Docker)
- **Storage**: 1GB free disk space (4GB for Docker with images)
- **CPU**: Modern x86_64 processor (ARM64 supported for Docker/npm)
- **Network**: Internet connection for LLM API access

### Software Requirements by Method

#### Binary Installation
- **Windows**: Windows 10 (1809) or higher
- **macOS**: macOS 10.15 (Catalina) or higher, Intel or Apple Silicon
- **Linux**: glibc 2.17 or higher (covers most distributions from 2014+)
- **Architecture**: x86_64 (amd64), ARM64 support planned
- **Additional**: No runtime dependencies required

#### Docker Installation  
- **Docker Engine**: 24.0 or higher
- **Docker Compose**: 2.0 or higher (optional, for development)
- **Platforms**: Linux, macOS, Windows with WSL2
- **Memory**: Docker Desktop allocated 2GB minimum
- **Storage**: 4GB for images and volumes

#### npm Installation
- **Node.js**: 20.0 or higher (LTS recommended)
- **npm**: 8.0 or higher (included with Node.js)
- **Python**: 3.8+ (for some native dependencies)
- **Build tools**: Platform-specific C++ compiler
- **Git**: For cloning repository and updates

#### Electron Application
- **Build requirements**: Same as npm installation
- **Runtime**: Packaged app has no external dependencies
- **Platforms**: Windows 10+, macOS 10.15+, Ubuntu 18.04+

### Network Requirements

- **Outbound HTTPS**: Port 443 for LLM API calls
- **Inbound HTTP**: Port 3000 (configurable) for web interface
- **Development**: Port 5173 for Vite dev server (npm method)
- **Firewalls**: Allow connections to OpenAI, Anthropic, Google, Mistral APIs

## Installation Instructions

### Method 1: Binary Installation (Recommended for Evaluation)

**Perfect for:** Quick trials, demos, environments without Docker/Node.js

#### Step 1: Download Binary

Visit [GitHub Releases](https://github.com/intrafind/ai-hub-apps/releases/latest) and download the appropriate package:

**Complete Packages (Recommended):**
- **Windows**: `ai-hub-apps-v{VERSION}-win.zip`
- **macOS**: `ai-hub-apps-v{VERSION}-macos.tar.gz`
- **Linux**: `ai-hub-apps-v{VERSION}-linux.tar.gz`

**Standalone Executables:**
- **Windows**: `ai-hub-apps-v{VERSION}-win.bat`
- **macOS**: `ai-hub-apps-v{VERSION}-macos`
- **Linux**: `ai-hub-apps-v{VERSION}-linux`

#### Step 2: Extract and Prepare

**Windows:**
```powershell
# Extract ZIP file to desired location
Expand-Archive -Path "ai-hub-apps-v*-win.zip" -DestinationPath "C:\ihub-apps"
cd "C:\ihub-apps"
```

**macOS:**
```bash
# Extract package
tar -xzf ai-hub-apps-v*-macos.tar.gz
cd ai-hub-apps-v*-macos

# Make executable (if needed)
chmod +x ai-hub-apps-v*-macos
```

**Linux:**
```bash
# Extract package
tar -xzf ai-hub-apps-v*-linux.tar.gz
cd ai-hub-apps-v*-linux

# Make executable
chmod +x ai-hub-apps-v*-linux
```

#### Step 3: Configure Environment (Optional)

Set environment variables for API keys:

**Windows (PowerShell):**
```powershell
$env:JWT_SECRET="your-secure-secret-here"
$env:OPENAI_API_KEY="your-openai-key"
$env:ANTHROPIC_API_KEY="your-anthropic-key"
```

**macOS/Linux:**
```bash
export JWT_SECRET="your-secure-secret-here"
export OPENAI_API_KEY="your-openai-key" 
export ANTHROPIC_API_KEY="your-anthropic-key"
```

Or create a `.env` file in the application directory:
```bash
# .env file
JWT_SECRET=your-secure-secret-here
OPENAI_API_KEY=your-openai-key
ANTHROPIC_API_KEY=your-anthropic-key
PORT=3000
```

#### Step 4: Run Application

**Windows:**
```powershell
# Run the batch file
.\ai-hub-apps-v*-win.bat

# Or run the executable directly
.\ai-hub-apps-v*-win.exe
```

**macOS/Linux:**
```bash
# Run the application
./ai-hub-apps-v*-platform
```

#### Step 5: Verify Installation

1. **Check console output** for "Server running on port 3000"
2. **Open browser** to http://localhost:3000
3. **Verify interface** loads with default applications available
4. **Test functionality** by trying a simple chat interaction

#### Binary Installation Features

✅ **Zero dependencies** - Complete standalone application  
✅ **Auto-configuration** - Creates default config on first run  
✅ **Cross-platform** - Native binaries for all major platforms  
✅ **Production-ready** - Optimized single executable  
✅ **Portable** - Can be moved between systems  
✅ **Quick updates** - Simple executable replacement  

### Method 2: Docker Installation (Recommended for Production)

**Perfect for:** Production deployments, containerized environments, easy scaling

#### Prerequisites Check

Verify Docker installation:
```bash
# Check Docker version (24.0+ required)
docker --version

# Check Docker Compose version (2.0+ required)  
docker compose version

# Test Docker functionality
docker run --rm hello-world
```

#### Option A: Pre-built Images (Fastest)

**Production deployment:**
```bash
# Create contents directory for configuration
mkdir -p ./contents

# Run latest version
docker run -d \
  --name ihub-apps \
  -p 3000:3000 \
  -v $(pwd)/contents:/app/contents \
  -e JWT_SECRET=your-secure-secret \
  -e OPENAI_API_KEY=your-openai-key \
  -e ANTHROPIC_API_KEY=your-anthropic-key \
  --restart unless-stopped \
  ghcr.io/intrafind/ai-hub-apps:latest
```

**Development with automatic local contents:**
```bash
# Clone repository for development
git clone https://github.com/intrafind/ai-hub-apps.git
cd ai-hub-apps

# Copy environment template
cp .env.example .env
# Edit .env with your API keys

# Start development environment (auto-mounts contents/)
npm run docker:up
```

#### Option B: Build from Source

```bash
# Clone repository
git clone https://github.com/intrafind/ai-hub-apps.git
cd ai-hub-apps

# Build development image
npm run docker:build:dev

# Build production image  
npm run docker:build:prod

# Run your built image
docker run -d \
  --name ihub-apps-custom \
  -p 3000:3000 \
  -v $(pwd)/contents:/app/contents \
  -e JWT_SECRET=your-secure-secret \
  ai-hub-apps:prod
```

#### Docker Development Workflow

```bash
# Start development environment
npm run docker:up

# View logs
npm run docker:logs

# Access container shell
npm run docker:shell

# Stop containers
npm run docker:down

# Clean up resources
npm run docker:clean
```

#### Access URLs

- **Development**: 
  - Main app: http://localhost:3000
  - Vite dev server: http://localhost:5173
- **Production**: http://localhost:3000

#### Docker Installation Features

✅ **Automatic local contents mounting** - Changes appear instantly  
✅ **Auto-setup** - Creates default config if contents/ empty  
✅ **Persistent data** - Volumes for uploads and runtime data  
✅ **Multi-platform** - Supports AMD64 and ARM64  
✅ **Production-ready** - Optimized containers with security  
✅ **Easy updates** - Pull new image and restart  

For comprehensive Docker documentation, see [docker/DOCKER.md](../docker/DOCKER.md).

### Method 3: npm Installation (For Development)

**Perfect for:** Development, customization, contributing to the project

#### Prerequisites Installation

**Install Node.js and npm:**

**Windows (using Chocolatey):**
```powershell
# Install Chocolatey if not already installed
# Then install Node.js
choco install nodejs

# Verify installation
node --version
npm --version
```

**macOS (using Homebrew):**
```bash
# Install Homebrew if not already installed
# Then install Node.js
brew install node

# Verify installation
node --version
npm --version
```

**Linux (Ubuntu/Debian):**
```bash
# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify installation
node --version
npm --version
```

**Additional dependencies:**
```bash
# Install build tools (if needed for native dependencies)
# Windows: Visual Studio Build Tools
# macOS: Xcode Command Line Tools
xcode-select --install

# Linux: build essentials
sudo apt-get install build-essential python3
```

#### Installation Steps

1. **Clone the repository:**
```bash
git clone https://github.com/intrafind/ai-hub-apps.git
cd ai-hub-apps
```

2. **Install dependencies:**
```bash
# Install all dependencies (client, server, shared)
npm run install:all

# Install Playwright for testing (optional)
npx playwright install
```

3. **Configure environment:**
```bash
# Copy environment template
cp .env.example .env

# Edit .env with your configuration
nano .env  # or use your preferred editor
```

4. **Start development server:**
```bash
# Start both server and client with hot reloading
npm run dev
```

This will:
- Start Node.js server on port 3000
- Launch Vite development server on port 5173  
- Enable hot reloading for both client and server
- Automatically open browser to development interface

#### Development Features

✅ **Hot reloading** - Instant updates during development  
✅ **Source code access** - Full customization capability  
✅ **Debugging tools** - Development server with source maps  
✅ **Testing integration** - Full test suite available  
✅ **Code quality tools** - ESLint, Prettier, pre-commit hooks  
✅ **Build tools** - Production builds and binary generation  

#### Development Commands

```bash
# Code quality
npm run lint          # Check linting issues
npm run lint:fix      # Auto-fix linting issues
npm run format        # Format with Prettier

# Testing
npm run test:openai   # Test OpenAI integration
npm run test:anthropic # Test Anthropic integration
npm run test:all      # Run all tests

# Building
npm run build         # Production build
npm run prod:build    # Complete production build
./build.sh --binary   # Create standalone binary
```

### Method 4: Electron Desktop Application

**Perfect for:** Desktop app experience, offline usage, system integration

#### Prerequisites

- Node.js 20.0+ and npm 8.0+ (same as npm installation)
- Platform-specific build tools

#### Installation Steps

1. **Clone and install dependencies:**
```bash
git clone https://github.com/intrafind/ai-hub-apps.git
cd ai-hub-apps
npm run install:all
```

2. **Configure environment:**
```bash
cp .env.example .env
# Edit .env with your API keys and configuration
```

3. **Run in development mode:**
```bash
# Start Electron app with local server
npm run electron:dev
```

4. **Build desktop installers:**
```bash
# Create platform-specific installers
npm run electron:build

# Find installers in dist-electron/ directory
ls dist-electron/
```

#### Electron Features

✅ **Native desktop experience** - System tray, notifications  
✅ **Offline capable** - Local processing when possible  
✅ **Cross-platform** - Windows, macOS, Linux applications  
✅ **Remote server support** - Connect to existing deployments  
✅ **Auto-updater** - Built-in update mechanism  
✅ **System integration** - File associations, protocol handlers  

#### Remote Server Connection

Connect to existing iHub Apps deployment:
```bash
# Set remote server URL
export REMOTE_SERVER_URL=https://your-ihub-server.com

# Start Electron app connected to remote server
npm run electron:dev
```

## Post-Installation Setup

### Initial Configuration

After installation, iHub Apps automatically creates default configuration on first startup. This includes:

- **Default applications** (chat, translation, summarization)
- **Model configurations** for supported providers
- **UI customization** settings
- **Authentication** configuration (anonymous by default)

### API Key Configuration

Configure LLM provider API keys for full functionality:

#### Environment Variables Method
```bash
export OPENAI_API_KEY="your-openai-key"
export ANTHROPIC_API_KEY="your-anthropic-key"
export GOOGLE_API_KEY="your-google-key"
export MISTRAL_API_KEY="your-mistral-key"
```

#### Configuration File Method
Edit `contents/config/platform.json`:
```json
{
  "llmProviders": {
    "openai": {
      "apiKey": "${OPENAI_API_KEY}",
      "baseURL": "https://api.openai.com"
    },
    "anthropic": {
      "apiKey": "${ANTHROPIC_API_KEY}",
      "baseURL": "https://api.anthropic.com"
    }
  }
}
```

### Security Configuration

#### Generate Secure Secrets
```bash
# Generate JWT secret
openssl rand -base64 32

# Generate admin secret (if using anonymous mode)
openssl rand -base64 16
```

#### Configure Authentication
Edit `contents/config/platform.json`:
```json
{
  "auth": {
    "mode": "anonymous",  // or "local", "oidc", "proxy"
    "jwtSecret": "your-generated-jwt-secret"
  },
  "anonymousAuth": {
    "enabled": true,
    "adminSecret": "your-admin-secret"
  }
}
```

### Verify Installation

1. **Check application startup:**
   - Console shows "Server running on port 3000"
   - No error messages in logs
   - Process starts within 30 seconds

2. **Test web interface:**
   - Browser opens to http://localhost:3000
   - Applications are visible on main page
   - Chat interface loads without errors

3. **Verify API functionality:**
   ```bash
   # Test health endpoint
   curl http://localhost:3000/api/health
   
   # Test apps endpoint
   curl http://localhost:3000/api/apps
   ```

4. **Test LLM integration:**
   - Try a simple chat interaction
   - Verify responses are generated
   - Check different model options

## Configuration

### Directory Structure

```
contents/
├── config/           # Core configuration files
│   ├── apps.json    # Application definitions
│   ├── models.json  # LLM model configurations
│   ├── platform.json # Server and auth configuration
│   ├── groups.json  # User groups and permissions
│   └── ui.json      # UI customization
├── data/            # Runtime data (created automatically)
├── uploads/         # User file uploads (created automatically)
├── locales/         # Custom localization overrides
└── pages/           # Custom page content
    ├── en/          # English pages
    └── de/          # German pages
```

### Key Configuration Files

#### apps.json - Application Definitions
Defines available AI applications with prompts, variables, and settings.

#### models.json - LLM Provider Configuration  
Configures OpenAI, Anthropic, Google, and other LLM providers.

#### platform.json - Server Configuration
Core server settings including authentication, CORS, and performance.

#### ui.json - User Interface Customization
Branding, navigation, footer content, and custom pages.

For detailed configuration documentation, see the main README.md Configuration section.

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PORT` | Server port | 3000 | No |
| `HOST` | Bind address | 0.0.0.0 | No |
| `JWT_SECRET` | JWT signing key | - | Yes* |
| `ADMIN_SECRET` | Admin access key | - | No |
| `OPENAI_API_KEY` | OpenAI API key | - | No |
| `ANTHROPIC_API_KEY` | Anthropic API key | - | No |
| `GOOGLE_API_KEY` | Google AI key | - | No |
| `MISTRAL_API_KEY` | Mistral AI key | - | No |
| `CONTENTS_DIR` | Config directory | ./contents | No |
| `NODE_ENV` | Environment | development | No |

*Required for production or when using authentication

## Update Procedures

### Binary Installation Updates

**Safe update procedure with configuration preservation:**

1. **Backup current installation:**
```bash
# Create backup of entire directory
cp -r ai-hub-apps-current ai-hub-apps-backup-$(date +%Y%m%d)

# Or backup just configuration
cp -r contents contents-backup-$(date +%Y%m%d)
```

2. **Stop current application:**
```bash
# Stop the application (Ctrl+C or close terminal)
# Or kill process if running in background
pkill -f ai-hub-apps
```

3. **Download new version:**
   - Visit [GitHub Releases](https://github.com/intrafind/ai-hub-apps/releases/latest)
   - Download the appropriate package for your platform
   - Extract to a new directory

4. **Migrate configuration:**
```bash
# Copy your configuration to new installation
cp -r contents-backup-*/* new-version/contents/

# Or copy specific files if needed
cp contents-backup-*/config/platform.json new-version/contents/config/
cp -r contents-backup-*/data/* new-version/contents/data/
```

5. **Start updated application:**
```bash
cd new-version
chmod +x ai-hub-apps-v*-platform  # Linux/macOS only
./ai-hub-apps-v*-platform
```

6. **Verify update:**
   - Check version in web interface or API
   - Verify all applications still work
   - Test configuration settings

### Docker Installation Updates

**Update with data preservation:**

```bash
# Method 1: Using Docker Compose
npm run docker:down
docker compose pull  # or: docker-compose pull
npm run docker:up

# Method 2: Manual container update
docker stop ihub-apps
docker rm ihub-apps
docker pull ghcr.io/intrafind/ai-hub-apps:latest

# Start with same volume mounts (preserves data)
docker run -d \
  --name ihub-apps \
  -p 3000:3000 \
  -v $(pwd)/contents:/app/contents \
  -e JWT_SECRET=your-secret \
  --restart unless-stopped \
  ghcr.io/intrafind/ai-hub-apps:latest
```

### npm Installation Updates

```bash
# Pull latest changes from repository
git pull origin main

# Update all dependencies
npm run install:all

# Restart development server
npm run dev
```

### Electron Application Updates

```bash
# Update source code
git pull origin main

# Update dependencies
npm run install:all

# Rebuild application
npm run electron:build
```

### Version Management

**Check current version:**
```bash
# Binary installation
./ai-hub-apps --version

# Docker container
docker exec ihub-apps node -p "require('/app/package.json').version"

# npm installation
cat package.json | grep version

# Web interface
curl http://localhost:3000/api/health | jq '.version'
```

**Rollback procedures:**
- **Binary**: Replace executable with backup version
- **Docker**: Use specific version tag: `ghcr.io/intrafind/ai-hub-apps:v3.2.0`
- **npm**: `git checkout v3.2.0` (or specific commit)

### Update Automation

**Docker with Watchtower (automatic updates):**
```bash
docker run -d \
  --name watchtower \
  -v /var/run/docker.sock:/var/run/docker.sock \
  containrrr/watchtower:latest \
  ihub-apps
```

**Binary update script example:**
```bash
#!/bin/bash
# update-ihub-apps.sh

CURRENT_VERSION=$(./ai-hub-apps --version | cut -d' ' -f2)
LATEST_VERSION=$(curl -s https://api.github.com/repos/intrafind/ai-hub-apps/releases/latest | jq -r '.tag_name')

if [ "$CURRENT_VERSION" != "$LATEST_VERSION" ]; then
  echo "Updating from $CURRENT_VERSION to $LATEST_VERSION"
  # Download and update logic here
fi
```

## Troubleshooting

### Common Installation Issues

#### Port Already in Use
**Error**: "EADDRINUSE: address already in use :::3000"

**Solutions:**
```bash
# Find process using port 3000
lsof -i :3000
# or
netstat -tulpn | grep :3000

# Kill process (replace PID)
kill -9 <PID>

# Or use different port
export PORT=3001
```

#### Permission Denied (Linux/macOS)
**Error**: "Permission denied" when running binary

**Solutions:**
```bash
# Make executable
chmod +x ai-hub-apps-v*-platform

# Check file permissions
ls -la ai-hub-apps-v*-platform

# Run with explicit shell
bash ./ai-hub-apps-v*-platform
```

#### Docker Image Pull Failed
**Error**: "pull access denied" or "image not found"

**Solutions:**
```bash
# Try different registry
docker pull ghcr.io/intrafind/ai-hub-apps:latest

# Check available tags
curl -s https://api.github.com/repos/intrafind/ai-hub-apps/releases

# Build image locally
npm run docker:build:prod
```

#### Node.js Version Incompatible
**Error**: "node: ^20.0.0 (current: v18.x.x)"

**Solutions:**
```bash
# Update Node.js using nvm (recommended)
nvm install 20
nvm use 20

# Or download from nodejs.org
# Or use package manager
brew install node@20  # macOS
choco install nodejs  # Windows
```

### Runtime Issues

#### Application Won't Start
**Check these common causes:**

1. **Configuration issues:**
```bash
# Validate JSON configuration
cat contents/config/platform.json | jq '.'

# Check for syntax errors in logs
tail -f logs/server.log
```

2. **Missing dependencies:**
```bash
# Binary: Check OS compatibility
ldd ai-hub-apps-v*-linux  # Linux
otool -L ai-hub-apps-v*-macos  # macOS

# npm: Reinstall dependencies
rm -rf node_modules
npm run install:all
```

3. **File permissions:**
```bash
# Check contents directory permissions
ls -la contents/
chmod -R 755 contents/  # Fix if needed
```

#### LLM API Errors
**Error**: "API key not configured" or connection timeouts

**Solutions:**
```bash
# Verify API keys are set
env | grep API_KEY

# Test API connectivity
curl -H "Authorization: Bearer $OPENAI_API_KEY" \
  https://api.openai.com/v1/models

# Check firewall/proxy settings
curl -I https://api.openai.com
```

#### Memory or Performance Issues
**Symptoms**: Slow response, crashes, high CPU usage

**Solutions:**
```bash
# Check system resources
htop  # or top on macOS
df -h  # disk space

# Docker: Increase memory allocation
# Docker Desktop -> Settings -> Resources

# Node.js: Increase heap size
export NODE_OPTIONS="--max-old-space-size=4096"
```

### Debugging Steps

#### Enable Debug Logging
```bash
# Set debug environment
export DEBUG=*
export LOG_LEVEL=debug

# Start application with verbose output
npm run dev 2>&1 | tee debug.log
```

#### Collect System Information
```bash
# System info
uname -a
node --version
docker --version

# Application info
curl http://localhost:3000/api/health

# Process info
ps aux | grep ai-hub
netstat -tulpn | grep 3000
```

#### Common Log Locations
- **Binary**: `./logs/` directory
- **Docker**: `docker logs ihub-apps`
- **npm**: Console output
- **System logs**: `/var/log/` (Linux), `Console.app` (macOS)

### Getting Help

If you encounter issues not covered here:

1. **Check existing documentation:**
   - [docker/DOCKER.md](../docker/DOCKER.md) for Docker-specific issues
   - [docs/external-authentication.md](external-authentication.md) for auth problems
   - Project README.md for general configuration

2. **Search existing issues:**
   - GitHub Issues: https://github.com/intrafind/ai-hub-apps/issues

3. **Create detailed bug report:**
   - Include installation method and platform
   - Provide error messages and logs
   - Describe steps to reproduce
   - Include system information

4. **Community resources:**
   - GitHub Discussions for general questions
   - Check release notes for breaking changes

## Security Considerations

### General Security

#### API Key Protection
- **Never commit API keys** to version control
- **Use environment variables** or secure key management
- **Rotate keys regularly** and monitor usage
- **Limit API key permissions** where possible

#### Network Security
```bash
# Configure firewall (example for Ubuntu)
sudo ufw allow 3000/tcp
sudo ufw deny from <untrusted-ip>

# Use HTTPS in production
export SSL_CERT=/path/to/certificate.crt
export SSL_KEY=/path/to/private.key
```

#### File System Security
```bash
# Secure contents directory
chmod 755 contents/
chmod 644 contents/config/*.json
chmod 700 contents/data/  # User data should be more restricted
```

### Installation-Specific Security

#### Binary Installation
- **Verify checksums** of downloaded files
- **Check file signatures** if available
- **Download only from official releases**
- **Run with minimal privileges** (non-root user)

```bash
# Verify download (if checksums provided)
sha256sum ai-hub-apps-v*-linux
# Compare with published checksum
```

#### Docker Installation
- **Use official images** from ghcr.io/intrafind/ai-hub-apps
- **Pin image versions** in production: `:v3.3.0` not `:latest`
- **Scan images for vulnerabilities**:
```bash
docker scan ghcr.io/intrafind/ai-hub-apps:latest
# or use trivy
trivy image ghcr.io/intrafind/ai-hub-apps:latest
```

#### npm Installation  
- **Audit dependencies** regularly:
```bash
npm audit
npm audit fix
```
- **Use npm ci** instead of npm install in production
- **Keep Node.js updated** to latest LTS version

### Production Deployment Security

#### Authentication Configuration
```json
{
  "auth": {
    "mode": "oidc",  // Use proper auth in production
    "jwtSecret": "long-random-secret-from-secure-generator"
  },
  "anonymousAuth": {
    "enabled": false  // Disable anonymous access
  }
}
```

#### Rate Limiting and Monitoring
```json
{
  "rateLimiting": {
    "enabled": true,
    "windowMs": 900000,  // 15 minutes
    "max": 100           // requests per window
  },
  "monitoring": {
    "enabled": true,
    "logLevel": "info"
  }
}
```

#### Reverse Proxy (Recommended)
Use nginx or similar reverse proxy:
```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Security Checklist

**Before Production Deployment:**

- [ ] API keys stored securely (not in code)
- [ ] Strong JWT secret generated
- [ ] Authentication enabled (not anonymous)
- [ ] HTTPS configured with valid certificates
- [ ] Firewall rules configured
- [ ] Rate limiting enabled
- [ ] Logging and monitoring configured
- [ ] Regular backup strategy implemented
- [ ] Update procedure documented and tested
- [ ] Security scanning included in CI/CD
- [ ] Dependencies regularly audited
- [ ] Access logs reviewed regularly

---

## Conclusion

This installation guide provides comprehensive instructions for deploying iHub Apps using any of the four supported methods. Choose the method that best fits your use case:

- **Binary** for quick evaluation and simple deployments
- **Docker** for production environments and containerized deployments  
- **npm** for development and customization
- **Electron** for desktop application experience

For additional help, consult the method-specific documentation or create an issue on GitHub.

**Quick Links:**
- [GitHub Repository](https://github.com/intrafind/ai-hub-apps)
- [Release Downloads](https://github.com/intrafind/ai-hub-apps/releases)
- [Docker Documentation](../docker/DOCKER.md)
- [Authentication Guide](external-authentication.md)