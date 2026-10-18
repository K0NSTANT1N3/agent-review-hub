import { writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, Notification, app, ipcMain, powerMonitor, safeStorage, shell } from 'electron';
import { addAgent, startLeader } from '@quorum/leader';
import { resolveClaudeExecutable, startDaemon } from '@quorum/node';
import type { ApiRouteName, UiEvent } from '@quorum/protocol';
import { IPC, type ApiCallOptions, type AppState, type DesktopSettings, type HostSetup, type JoinSetup } from '../shared/ipc.js';
import { Services } from './services.js';

const here = fileURLToPath(new URL('.', import.meta.url));
let window: BrowserWindow | null = null;

// Separate data folders let several instances (e.g. a host and a member) run on one computer.
if (process.env.QUORUM_USER_DATA) app.setPath('userData', process.env.QUORUM_USER_DATA);

const secrets = {
  encrypt(plain: string): string {
    return safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(plain).toString('base64')}` : `plain:${plain}`;
  },
  decrypt(stored: string): string {
    if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    return stored.startsWith('plain:') ? stored.slice(6) : stored;
  },
};

const notifier = createNotifier();

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
  void window.loadFile(join(here, '../renderer/index.html'));
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
handle(IPC.reset, () => services.reset());
handle(IPC.networkAddresses, () => lanAddresses());
handle(IPC.checkAgent, () => services.checkAgent());
handle(IPC.openExternal, async (url: string) => {
  if (/^https?:\/\//.test(url)) await shell.openExternal(url);
});
handle(IPC.api, (route: ApiRouteName, options?: ApiCallOptions) => services.api(route, options));

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return [...out, '127.0.0.1'];
}

/** OS notifications for the user's own tasks: merged, escalated, or needing attention. */
function createNotifier(): (event: UiEvent, state: AppState) => void {
  const lastState = new Map<number, string>();
  return (event, state) => {
    if (!Notification.isSupported()) return;
    if (event.type === 'task.updated') {
      const t = event.data;
      const prev = lastState.get(t.id);
      lastState.set(t.id, t.state);
      if (prev === undefined || prev === t.state || t.requesterOwner !== state.ownerName) return;
      if (t.state === 'MERGED') new Notification({ title: 'Merged ✓', body: `#${t.id} ${t.title}` }).show();
      if (t.state === 'ESCALATED') new Notification({ title: 'Needs your decision', body: `#${t.id} ${t.title}: ${t.escalationReason ?? ''}` }).show();
    } else if (event.type === 'task.needs_attention') {
      new Notification({ title: `Task #${event.data.taskId} needs attention`, body: event.data.message }).show();
    } else if (event.type === 'agent.updated' && event.data.id === state.agentId && event.data.rateLimitedUntil !== null) {
      const until = new Date(event.data.rateLimitedUntil).toLocaleTimeString();
      new Notification({ title: 'Your agent is rate-limited', body: `Usage resets around ${until}.` }).show();
    }
  };
}

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
    await services.boot();
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
