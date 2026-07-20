// Disable no-unused-vars, broken for spread args
/* eslint no-unused-vars: off */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

export type Channels =
  | 'ipc-example'
  | 'check-idle'
  | 'idle-status'
  | 'take-screenshot'
  | 'screenshot-taken'
  | 'check-online-status'
  | 'online-status'
  | 'check-startup-status'
  | 'set-startup-status'
  | 'show-startup-prompt'
  | 'read-file-as-base64'
  | 'clock-out-and-exit'
  | 'check-clock-in-status'
  | 'clock-in-status-response'
  | 'system-suspend-before-715'
  | 'clock-out-complete'
  | 'save-session'
  | 'get-session';

const electronHandler = {
  ipcRenderer: {
    sendMessage(channel: Channels, ...args: unknown[]) {
      ipcRenderer.send(channel, ...args);
    },
    on(channel: Channels, func: (...args: unknown[]) => void) {
      const subscription = (_event: IpcRendererEvent, ...args: unknown[]) =>
        func(...args);
      ipcRenderer.on(channel, subscription);

      return () => {
        ipcRenderer.removeListener(channel, subscription);
      };
    },
    once(channel: Channels, func: (...args: unknown[]) => void) {
      ipcRenderer.once(channel, (_event, ...args) => func(...args));
    },
    invoke(channel: Channels, ...args: unknown[]) {
      return ipcRenderer.invoke(channel, ...args);
    },
  },
  // System utilities
  system: {
    // Check if the system is online
    isOnline: () => navigator.onLine,

    // Get the current timestamp
    getCurrentTimestamp: () =>
      new Date().toISOString().replace('T', ' ').substring(0, 19),

    getIdleTime: () => {
      return ipcRenderer.invoke('get-idle-time');
    },

    // Take a screenshot (will be implemented in the main process)
    takeScreenshot: () => {
      return new Promise<string>((resolve) => {
        ipcRenderer.once('screenshot-taken', (_event, screenshotPath) => {
          resolve(screenshotPath);
        });
        ipcRenderer.send('take-screenshot');
      });
    },

    // Read a file as base64 (will be implemented in the main process)
    readFileAsBase64: (filePath: string) => {
      return ipcRenderer.invoke('read-file-as-base64', filePath);
    },

    // Delete a file
    deleteFile: (filePath: string) => {
      return ipcRenderer.invoke('delete-file', filePath);
    },

    // Check if the app is set to start at login
    isStartupEnabled: () => {
      return ipcRenderer.invoke('check-startup-status');
    },

    // Set whether the app should start at login
    setStartupEnabled: (enable: boolean) => {
      return ipcRenderer.invoke('set-startup-status', enable);
    },

    // Show a prompt asking the user if they want to enable startup
    showStartupPrompt: () => {
      return ipcRenderer.invoke('show-startup-prompt');
    },

    getSession: () => {
      return ipcRenderer.invoke('get-session');
    },
  },
};

contextBridge.exposeInMainWorld('electron', electronHandler);

// Make sure the TypeScript interface includes all the methods we've added
export interface ElectronHandler {
  ipcRenderer: {
    sendMessage(channel: Channels, ...args: unknown[]): void;
    on(channel: Channels, func: (...args: unknown[]) => void): () => void;
    once(channel: Channels, func: (...args: unknown[]) => void): void;
    invoke(channel: Channels, ...args: unknown[]): Promise<unknown>;
  };
  system: {
    isOnline(): boolean;
    getCurrentTimestamp(): string;
    getIdleTime(): Promise<number>;
    takeScreenshot(): Promise<string>;
    readFileAsBase64(
      filePath: string,
    ): Promise<{ error: boolean; message: string; data: string | null }>;
    deleteFile(filePath: string): Promise<{ error: boolean; message: string }>;
    isStartupEnabled(): Promise<boolean>;
    setStartupEnabled(enable: boolean): Promise<boolean>;
    showStartupPrompt(): Promise<boolean>;
    getSession(): Promise<any>;
  };
}

