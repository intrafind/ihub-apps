import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let serverProcess;
const remoteUrl = process.env.REMOTE_SERVER_URL;

function getServerEntry() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'dist', 'server', 'server.js');
  }
  return path.join(__dirname, '../server/server.js');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });
  if (remoteUrl) {
    win.loadURL(remoteUrl);
  } else if (!app.isPackaged) {
    win.loadURL('http://localhost:3000');
  } else {
    win.loadFile(path.join(process.resourcesPath, 'dist', 'public', 'index.html'));
  }
}

app.whenReady().then(() => {
  if (!remoteUrl) {
    serverProcess = spawn('node', [getServerEntry()], {
      env: process.env,
      stdio: 'inherit'
    });
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (serverProcess) {
    serverProcess.kill();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
