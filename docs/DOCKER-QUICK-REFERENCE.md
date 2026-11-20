---
description: "The Docker commands and mounts for running iHub in containers."
audience: admin
type: reference
---

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
docker build -f docker/Dockerfile -t ihub-apps:dev --target development .

# Production build
docker build -f docker/Dockerfile -t ihub-apps:prod --target production .

# Test your local build
# Quick start with Docker (no JWT_SECRET required)
docker run --rm -p 3000:3000 -v $(pwd)/contents:/app/contents ihub-apps:dev
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

## Storage Commands in a Container

The production image has no `npm` and no `scripts/` directory. Run the storage commands through
their entry point, in the container so that they see the same `contents/` volume and the same
environment (`TOKEN_ENCRYPTION_KEY`, S3 credentials) as the server:

```bash
docker exec <container> node server/storage/commands/run.js check
docker exec <container> node server/storage/commands/run.js show --doc chats <chatId>
```

`copy-blobs` and `encrypt` need the server stopped. Run them in a one-off container with the same
image, volume and environment:

```bash
docker run --rm -v ihub-contents:/app/contents --env-file ihub.env <image> \
  node server/storage/commands/run.js encrypt --dry-run
docker run --rm -v ihub-contents:/app/contents --env-file ihub.env <image> \
  node server/storage/commands/run.js copy-blobs --dry-run
```

| Command      | What it does                                                           | Details                                                                  |
| ------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `check`      | Checks the configured blob storage (S3 bucket, key) without the server | [Storage Providers](storage.md#checking-the-configuration-storagecheck)  |
| `copy-blobs` | Copies blobs from local disk into the configured S3 bucket             | [Storage Providers](storage.md#moving-existing-blobs-storagecopy-blobs)  |
| `encrypt`    | Encrypts the stored data in place                                      | [Storage Encryption](storage-encryption.md#turning-it-on)                |
| `show`       | Prints one stored object decrypted, for support                        | [Storage Encryption](storage-encryption.md#reading-stored-data-for-support-storageshow) |

Exit code 0 means success, 1 a failed check or an incomplete run, 2 a wrong argument.

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
docker pull ghcr.io/intrafind/ihub-apps:latest

# Specific version
docker pull ghcr.io/intrafind/ihub-apps:v1.0.0
```