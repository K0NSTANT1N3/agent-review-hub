import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, Notification, app, dialog, ipcMain, powerMonitor, safeStorage, shell } from 'electron';
import { addAgent, startLeader } from '@quorum/leader';
import { resolveClaudeExecutable, startDaemon } from '@quorum/node';
import type { ApiRouteName } from '@quorum/protocol';
import { IPC, type ApiCallOptions, type DesktopSettings, type HostSetup, type JoinSetup, type ResetOptions } from '../shared/ipc.js';
import { cliInstallPlan, installCli } from './install-cli.js';
import { addressOptions } from './network.js';
import { createNotifier } from './notifier.js';
import { Services } from './services.js';

const here = fileURLToPath(new URL('.', import.meta.url));
let window: BrowserWindow | null = null;

// Separate data folders let several instances (e.g. a host and a member) run on one computer.
if (process.env.QUORUM_USER_DATA) app.setPath('userData', process.env.QUORUM_USER_DATA);

// Without an OS keychain (e.g. Linux with no keyring) the token is kept as plain text; Settings warns about it.
const secrets = {
  encrypt(plain: string): string {
    return safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(plain).toString('base64')}` : `plain:${plain}`;
  },
  decrypt(stored: string): string {
    if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    return stored.startsWith('plain:') ? stored.slice(6) : stored;
  },
  isEncrypted: (stored: string): boolean => stored.startsWith('enc:'),
};

const notifier = createNotifier({
  show: (title, body) => {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  },
  requesterOf: async (id) => {
    const res = await services.api('getTask', { id });
    return res.ok ? res.data.task.requesterOwner : null;
  },
});

const services = new Services(
  app.getPath('userData'),
  {
    startLeader: (config) => startLeader(config),
    addAgent,
    startDaemon: (config, opts) => startDaemon(config, opts),
    secrets,
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    claudeExecutable: resolveClaudeExecutable,
  },
  (state) => window?.webContents.send(IPC.state, state),
  (event) => {
    window?.webContents.send(IPC.uiEvent, event);
    notifier(event, services.state());
  },
);

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'Quorum',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(here, '../preload/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.removeMenu();
  // External links open in the system browser, never inside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (e) => e.preventDefault());
  void window.loadFile(join(here, '../renderer/index.html'), { hash: process.env.QUORUM_START_PAGE ?? '' });
  const shot = process.env.QUORUM_SMOKE_SCREENSHOT;
  if (shot) {
    // Smoke test: render, capture this window to a PNG and quit.
    window.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void window
          ?.capturePage()
          .then((img) => writeFileSync(shot, img.toPNG()))
          .finally(() => app.exit(0));
      }, Number(process.env.QUORUM_SMOKE_DELAY_MS ?? 2500));
    });
  }
  window.on('closed', () => {
    window = null;
  });
}

function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => fn(...(args as A)));
}

handle(IPC.getState, () => services.state());
handle(IPC.setupHost, (setup: HostSetup) => services.setupHost(setup));
handle(IPC.setupJoin, (setup: JoinSetup) => services.setupJoin(setup));
handle(IPC.invite, (args: { agentId: string; ownerName: string }) => services.invite(args));
handle(IPC.updateSettings, (settings: DesktopSettings) => services.updateSettings(settings));
handle(IPC.restart, () => services.restart());
handle(IPC.reset, (options?: ResetOptions) => services.reset({ deleteLeaderData: options?.deleteLeaderData === true }));
handle(IPC.networkAddresses, () => addressOptions());
handle(IPC.installCli, async () => {
  if (!app.isPackaged) throw new Error('Install a packaged Quorum app to use this action.');
  const options = {
    source: join(process.resourcesPath, 'cli'), dataDir: app.getPath('userData'),
    home: app.getPath('home'), version: app.getVersion(), platform: process.platform,
    shell: process.env.SHELL, path: process.env.PATH,
  };
  const plan = cliInstallPlan(options);
  const { response } = await dialog.showMessageBox({
    type: 'question', buttons: ['Cancel', 'Install'], defaultId: 1, cancelId: 0,
    message: 'Install command-line tool?',
    detail: `Copy the bundled tools to ${plan.payload}.\n` + (process.platform === 'win32'
      ? `Add ${plan.bin} to your user PATH.`
      : `Create quorum and quorum-tui symlinks in ${plan.bin}.` + (plan.profile ? `\nAdd this directory to PATH in ${plan.profile}.` : '')),
  });
  return response === 1 ? installCli(options) : 'Installation cancelled.';
});
handle(IPC.checkAgent, () => services.checkAgent());
handle(IPC.saveTuiToken, (token: string) => services.saveTuiToken(token));
handle(IPC.openExternal, async (url: string) => {
  if (/^https?:\/\//.test(url)) await shell.openExternal(url);
});
handle(IPC.api, (route: ApiRouteName, options?: ApiCallOptions) => services.api(route, options));

const single = app.requestSingleInstanceLock();
if (!single) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window !== null) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app.whenReady().then(async () => {
    createWindow();
    await services.boot().catch((error: unknown) => console.error('Quorum failed to start its services', error));
    window?.webContents.send(IPC.state, services.state());
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    void services.stopAll().finally(() => app.quit());
  });
}
