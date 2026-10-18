// Sandboxed preload (CommonJS). Exposes the typed QuorumBridge; nothing else from Node/Electron reaches the page.
import { contextBridge, ipcRenderer } from 'electron';
import type { QuorumBridge } from '../shared/ipc.js';

// Channel names duplicated from shared/ipc.ts: a sandboxed preload cannot require local modules.
const IPC = {
  getState: 'quorum:get-state',
  setupHost: 'quorum:setup-host',
  setupJoin: 'quorum:setup-join',
  invite: 'quorum:invite',
  updateSettings: 'quorum:update-settings',
  restart: 'quorum:restart',
  reset: 'quorum:reset',
  networkAddresses: 'quorum:network-addresses',
  openExternal: 'quorum:open-external',
  api: 'quorum:api',
  state: 'quorum:state',
  uiEvent: 'quorum:ui-event',
} as const;

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_e: unknown, value: T) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const bridge: QuorumBridge = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  setupHost: (setup) => ipcRenderer.invoke(IPC.setupHost, setup),
  setupJoin: (setup) => ipcRenderer.invoke(IPC.setupJoin, setup),
  invite: (args) => ipcRenderer.invoke(IPC.invite, args),
  updateSettings: (settings) => ipcRenderer.invoke(IPC.updateSettings, settings),
  restart: () => ipcRenderer.invoke(IPC.restart),
  reset: () => ipcRenderer.invoke(IPC.reset),
  networkAddresses: () => ipcRenderer.invoke(IPC.networkAddresses),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  api: (route, options) => ipcRenderer.invoke(IPC.api, route, options),
  onState: (listener) => subscribe(IPC.state, listener),
  onUiEvent: (listener) => subscribe(IPC.uiEvent, listener),
};

contextBridge.exposeInMainWorld('quorum', bridge);
