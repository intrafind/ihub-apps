# Docker Quick Reference

## Key Commands for Local Development

### Automatic Local Contents Folder

The `npm run docker:up` command **automatically** mounts your entire local `contents/` folder:

```bash
# Start development - AUTOMATICALLY uses your local contents folder
npm run docker:up
```

This command:
- ✅ **Automatically mounts your entire `contents/` folder** - no configuration needed
- ✅ **Auto-setup on first run** - If `contents/` is empty, default configuration is copied automatically
- ✅ **All changes appear instantly** in the container
- ✅ **Edit any file locally** - configs, apps, models, pages, prompts, sources
- ✅ **Persistent data** - `contents/data/`, `contents/uploads/`, and logs use Docker volumes

### What This Means

✅ **Zero setup** - Empty `contents/` folder gets default configuration automatically  
✅ **Edit files locally** - Changes in your local `contents/` folder are immediately available in the container  
✅ **No rebuilds needed** - Modify apps, models, and configs without restarting Docker  
✅ **Version control friendly** - Your changes are in your local repository  
✅ **Persistent data** - `contents/data/`, `contents/uploads/`, and logs are stored in Docker volumes  

## Building Docker Images Locally

### Quick Build Commands

```bash
# Build development image locally
npm run docker:build:dev

# Build production image locally
npm run docker:build:prod

# Build and start (rebuild if needed)
npm run docker:up:build
```

### Manual Docker Commands

```bash
# Development build
docker build -f docker/Dockerfile -t ai-hub-apps:dev --target development .

# Production build
docker build -f docker/Dockerfile -t ai-hub-apps:prod --target production .

# Test your local build
docker run --rm -p 3000:3000 -v $(pwd)/contents:/app/contents -e JWT_SECRET=test ai-hub-apps:dev
```

## Other Useful Commands

```bash
# View logs
npm run docker:logs

# Access container shell
npm run docker:shell

# Stop containers
npm run docker:down

# Clean up Docker resources
npm run docker:clean
```

## GitHub CI/CD Triggers

Docker images are built and published when:

1. **Creating a release** on GitHub
2. **Pushing version tags** (e.g., `v1.0.0`)
3. **Manual trigger**: Comment `@build docker images` on any issue/PR
4. **Manual workflow**: Use GitHub Actions "Run workflow" button

## Access URLs

### Development Mode
- **Main application**: http://localhost:3000 (Node.js server + API)
- **Vite dev server**: http://localhost:5173 (Hot reload client)

### Production Mode  
- **Main application**: http://localhost:3000 (Node.js server with built client)

## Published Images

```bash
# Latest version
docker pull ghcr.io/intrafind/ai-hub-apps:latest

# Specific version
docker pull ghcr.io/intrafind/ai-hub-apps:v1.0.0
```