# Reverse Proxy Testing Guide

## Current Setup Issue

The application is showing a blank page when accessing `/ihub/admin/sources` directly. This is happening because of a configuration mismatch.

## The Problem

There are two conflicting approaches:

### Approach 1: Strip Prefix (Current nginx.conf)

- Nginx strips `/ihub` and forwards `/admin/sources` to backend
- Backend receives requests WITHOUT the `/ihub` prefix
- Problem: The app was built with `VITE_BASE_PATH=/ihub` but runs without it

### Approach 2: Keep Prefix

- Nginx keeps `/ihub` and forwards `/ihub/admin/sources` to backend
- Backend receives requests WITH the `/ihub` prefix
- Problem: Backend routes are not registered under `/ihub`

## Solution Options

### Option 1: Run WITHOUT Base Path Configuration (Recommended)

1. **Start the application without BASE_PATH:**

```bash
# Just run normally without BASE_PATH
PORT=3001 npm run dev
# OR for production
PORT=3001 npm start
```

2. **Use current nginx.conf** (with trailing slash that strips prefix)

3. **Access via:** `http://localhost:8081/ihub/`

The runtime base path detection in the client will detect `/ihub` from the URL.

### Option 2: Run WITH Base Path Configuration

1. **Build with base path:**

```bash
VITE_BASE_PATH=/ihub npm run build
```

2. **Run with base path:**

```bash
BASE_PATH=/ihub PORT=3001 npm start
```

3. **Modify nginx to NOT strip the prefix:**

```nginx
location /ihub {
    proxy_pass http://localhost:3001;  # No trailing slash
    # ... other settings ...
}
```

### Option 3: Use Development Mode with Proxy

1. **Run dev server:**

```bash
PORT=3001 npm run dev
```

2. **Configure nginx for dev mode:**

```nginx
location /ihub/ {
    proxy_pass http://localhost:5173/;  # Vite dev server
    # ... other settings ...
}
```

## Testing Steps

1. **Check what's currently running:**

```bash
lsof -i :3001
lsof -i :5173
```

2. **Check if nginx is running:**

```bash
ps aux | grep nginx
```

3. **Test the health endpoint:**

```bash
# Direct access
curl http://localhost:3001/health

# Through proxy
curl http://localhost:8081/health
curl http://localhost:8081/ihub/health
```

4. **Check browser console:**

- Open Developer Tools (F12)
- Check Console for errors
- Check Network tab for failed resource loads
- Look for 404s on JS/CSS files

## Debugging the Blank Page

When you see a blank page, check:

1. **View Page Source** - Is index.html loading?
2. **Network Tab** - Are JS/CSS files loading from correct paths?
3. **Console Errors** - Any JavaScript errors?
4. **React DevTools** - Is React app mounting?

Common issues:

- Assets loading from wrong path (e.g., `/assets/` instead of `/ihub/assets/`)
- API calls going to wrong endpoints
- React Router basename mismatch

## Recommended Fix

For immediate fix, restart your application WITHOUT the BASE_PATH:

```bash
# Stop current process
# Then restart without BASE_PATH
PORT=3001 npm run dev
```

Then reload nginx:

```bash
nginx -s reload -c /Users/danielmanzke/Workspaces/github.intrafind/ai-hub-apps/nginx.conf
```

Access the app at: `http://localhost:8081/ihub/`

The runtime base path detection should handle the routing correctly.
