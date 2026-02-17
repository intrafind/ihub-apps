# Nginx Reverse Proxy Setup - How To Guide

## Overview

This guide covers how to use the nginx reverse proxy configuration that forwards requests from `/ihub` subpath to your local development server running on `localhost:5173`.

## Quick Start

### 1. Start your application

Make sure your app is running on `localhost:5173`:

```bash
# Example for a typical dev server
npm run dev
# or
yarn dev
# or whatever command starts your app on port 5173
```

### 2. Start nginx (if not already running)

```bash
nginx -c /Users/danielmanzke/Workspaces/github.intrafind/ai-hub-apps/nginx.conf
```

### 3. Access your app

Open your browser and navigate to:

```
http://localhost:8081/ihub/
```

## Configuration Details

- **nginx Port:** 8081
- **Proxy Target:** localhost:5173
- **Subpath:** `/ihub`
- **Config File:** `nginx.conf` (in this directory)

## Management Commands

### Start nginx

```bash
nginx -c /Users/danielmanzke/Workspaces/github.intrafind/ai-hub-apps/nginx.conf
```

### Stop nginx

```bash
nginx -s quit
```

### Reload configuration (after making changes)

```bash
nginx -s reload -c /Users/danielmanzke/Workspaces/github.intrafind/ai-hub-apps/nginx.conf
```

### Test configuration

```bash
nginx -t -c /Users/danielmanzke/Workspaces/github.intrafind/ai-hub-apps/nginx.conf
```

### Check if nginx is running

```bash
ps aux | grep nginx
# or
lsof -i :8081
```

## Endpoints

| URL                            | Purpose                              |
| ------------------------------ | ------------------------------------ |
| `http://localhost:8081/ihub/`  | Your app (proxied to localhost:5173) |
| `http://localhost:8081/ihub`   | Redirects to `/ihub/`                |
| `http://localhost:8081/health` | Health check endpoint                |
| `http://localhost:8081/`       | Returns 404 (not configured)         |

## Features

✅ **WebSocket Support** - Hot reload and dev server features work  
✅ **Proper Headers** - Real IP and forwarded headers are set  
✅ **Path Rewriting** - `/ihub/xyz` becomes `/xyz` when forwarded  
✅ **Auto Redirect** - `/ihub` redirects to `/ihub/`  
✅ **Health Check** - Simple endpoint to verify nginx is running  
✅ **SSE Streaming** - Server-Sent Events for LLM chat streaming (no buffering)  
✅ **Long Connections** - 24-hour timeout for extended chat sessions

## Important Configuration Notes

### Server-Sent Events (SSE) Streaming

The nginx configuration includes critical settings for streaming LLM responses:

```nginx
# Disable buffering for Server-Sent Events (SSE)
proxy_buffering off;
proxy_request_buffering off;

# Long timeout for streaming requests (24 hours)
proxy_read_timeout 86400s;
proxy_send_timeout 86400s;
```

**Why these settings are critical:**

- **`proxy_buffering off`**: Without this, nginx buffers the entire response before sending it to the client. This defeats the purpose of streaming and causes the UI to freeze until the entire LLM response is complete.
- **`proxy_request_buffering off`**: Prevents buffering of request bodies, useful for large file uploads.
- **`proxy_read_timeout 86400s`**: Sets a 24-hour timeout for reading responses. This prevents nginx from closing connections during long-running chat sessions.
- **`proxy_send_timeout 86400s`**: Sets a 24-hour timeout for sending data to the backend.

**Without these settings:**
- Chat responses appear all at once instead of streaming word-by-word
- Connections may timeout during extended conversations
- The user experience is significantly degraded

## Troubleshooting

### Port 8081 already in use

```bash
# Check what's using the port
lsof -i :8081

# If nginx is already running, stop it first
nginx -s quit

# Or kill the process
sudo kill -9 <PID>
```

### nginx won't start

```bash
# Test the configuration
nginx -t -c /Users/danielmanzke/Workspaces/github.intrafind/ai-hub-apps/nginx.conf

# Check nginx error logs
tail -f /opt/homebrew/var/log/nginx/error.log
```

### App not accessible through proxy

1. Verify your app is running on `localhost:5173`
2. Test direct access: `curl http://localhost:5173`
3. Test proxy: `curl http://localhost:8081/ihub/`
4. Check nginx error logs for issues

### Making configuration changes

1. Edit the `nginx.conf` file in this directory
2. Test the configuration: `nginx -t -c /path/to/nginx.conf`
3. Reload nginx: `nginx -s reload -c /path/to/nginx.conf`

## Example Workflow

```bash
# 1. Start your dev server
npm run dev  # or your app start command

# 2. Start nginx proxy (if not running)
nginx -c /Users/danielmanzke/Workspaces/github.intrafind/ai-hub-apps/nginx.conf

# 3. Open browser to http://localhost:8081/ihub/

# 4. When done, stop nginx
nginx -s quit
```

## Files in this setup

- `nginx.conf` - Main nginx configuration
- `nginx-proxy-howto.md` - This guide

---

**Note:** This setup is designed for local development. The configuration includes settings optimized for dev servers with hot reload capabilities.
