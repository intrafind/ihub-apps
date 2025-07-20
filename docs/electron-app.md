# Electron Desktop Application

The Electron wrapper allows AI Hub Apps to run as a standalone desktop
application that bundles the server and client. It can be packaged for
macOS, Linux and Windows using `electron-builder`.

## Development

Start the Electron app together with the development servers:

```bash
npm run electron:dev
```

This launches the Node.js backend and the Vite dev server, then opens
the Electron window pointing to `http://localhost:3000`.

## Building Packages

Create optimized production files and package them with Electron:

```bash
npm run electron:build
```

The command runs `npm run prod:build` and then uses `electron-builder`
to create platform specific installers (`dmg`, `AppImage`, `nsis`).

### Code Signing

On macOS and Windows you should sign the binaries before distributing
them. Provide the signing certificate details to `electron-builder`
through environment variables or in `package.json`.

## Customization and Updates

Because the server runs locally in the Electron app, you can update the
`contents` folder or add new integrations without rebuilding the
frontend. Distribute updated packages to roll out new versions or use
`autoUpdater` from Electron for in-app updates.

Local deployment can also expose the apps through MCP on `localhost`
which allows other tools (e.g. Claude.ai) to communicate with your
server directly.

Authentication behaves the same as in the normal server setup. You can
still use OIDC or local accounts. The desktop app does not make
authentication harder but allows storing credentials securely on the
client.

## Remote Server Mode

Set the `REMOTE_SERVER_URL` environment variable to skip starting the
embedded Node.js backend and point the Electron window at your existing
server instance. This mode is useful if you only want to ship the
frontend while keeping the backend running on a remote host.
