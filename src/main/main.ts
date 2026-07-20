/* eslint global-require: off, no-console: off, promise/always-return: off */

/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `npm run build` or `npm run build:main`, this file is compiled to
 * `./src/main.js` using webpack. This gives us some performance wins.
 */
import path from 'path';
import {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  powerMonitor,
  desktopCapturer,
  dialog,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import fs from 'fs';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import MenuBuilder from './menu';
import { resolveHtmlPath } from './util';

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
}

class AppUpdater {
  constructor() {
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    autoUpdater.checkForUpdatesAndNotify();
  }
}

let mainWindow: BrowserWindow | null = null;
let isAppQuitting = false;
let isClockoutInitiated = false;
let isClockoutComplete = false;

function getLocalTimestamp(timezone: string = 'Asia/Kolkata'): string {
  const now = new Date();
  const options = {
    year: 'numeric' as const,
    month: '2-digit' as const,
    day: '2-digit' as const,
    hour: '2-digit' as const,
    minute: '2-digit' as const,
    second: '2-digit' as const,
    hour12: false,
    timeZone: timezone,
  };
  return now
    .toLocaleString('en-US', options)
    .replace(/(\d+)\/(\d+)\/(\d+),\s(\d+):(\d+):(\d+)/, '$3-$1-$2 $4:$5:$6');
}

function performDirectClockoutAsync(session: any): Promise<void> {
  return new Promise((resolve) => {
    try {
      const serverUrl =
        session.serverUrl || 'http://localhost/api/plugin/timetracker';
      const endpoint = `${serverUrl}/log-update`;
      console.log(
        `[DEBUG] Graceful shutdown async: Sending direct native HTTP/HTTPS clockout request to ${endpoint}...`,
      );

      const formattedDate = getLocalTimestamp(session.timezone);

      const payload = JSON.stringify({
        user_id: session.userId,
        action: 'clock-out',
        timestamp: formattedDate,
        reason: 'Gracefully clocked out on PC shutdown',
      });

      const parsedUrl = new URL(endpoint);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.request(
        endpoint,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.token}`,
            'workspace-id': String(session.workspaceId),
            'is-device': 'electron',
            'User-Agent': 'Electron',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 4000,
        },
        (res) => {
          console.log(
            `[DEBUG] Graceful shutdown async: Response status: ${res.statusCode}`,
          );
          res.resume();
          res.on('end', () => {
            resolve();
          });
        },
      );

      req.on('error', (err) => {
        console.error(
          `[DEBUG] Graceful shutdown async: Request error: ${err.message}`,
        );
        resolve();
      });

      req.on('timeout', () => {
        console.warn('[DEBUG] Graceful shutdown async: Request timed out');
        req.destroy();
        resolve();
      });

      req.write(payload);
      req.end();
    } catch (error: any) {
      console.error(
        `[DEBUG] Graceful shutdown async: Direct async clockout initiation failed: ${error?.message || error}`,
      );
      resolve();
    }
  });
}

function handleGracefulShutdown(event: any, source: string): void {
  console.log(
    `[DEBUG] handleGracefulShutdown called from ${source}. isClockoutInitiated=${isClockoutInitiated}, isClockoutComplete=${isClockoutComplete}`,
  );
  isAppQuitting = true;

  if (isClockoutComplete) {
    return;
  }

  // Prevent default to allow async operation to run
  if (event && typeof event.preventDefault === 'function') {
    event.preventDefault();
  }

  if (isClockoutInitiated) {
    return;
  }

  const sessionPath = path.join(app.getPath('userData'), 'session.json');
  if (fs.existsSync(sessionPath)) {
    try {
      const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      if (session && session.isClockedIn && session.token && session.userId) {
        console.log(
          `[DEBUG] Graceful shutdown (${source}): User is clocked in. Writing session.json synchronously...`,
        );
        const lastActiveTime = getLocalTimestamp(session.timezone);
        session.isClockedIn = false;
        session.lastActiveTime = lastActiveTime;
        fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));

        console.log(
          `[DEBUG] Graceful shutdown (${source}): Performing direct async clockout...`,
        );
        isClockoutInitiated = true;

        let isDone = false;
        const finish = () => {
          if (isDone) return;
          isDone = true;
          isClockoutComplete = true;
          console.log(
            `[DEBUG] Graceful shutdown (${source}) complete. Quitting app...`,
          );
          app.quit();
        };

        // Fallback safety timeout
        setTimeout(finish, 4500);

        performDirectClockoutAsync(session)
          .then(finish)
          .catch((err) => {
            console.error(`[DEBUG] Async clockout promise rejection:`, err);
            finish();
          });

        return;
      }
    } catch (err) {
      console.error(
        `[DEBUG] Graceful shutdown (${source}): Failed to read/write session.json or initiate clockout:`,
        err,
      );
    }
  }

  // If we get here, no clockout was needed or we couldn't start it
  isClockoutComplete = true;
  app.quit();
}

// Handle save-session IPC event from renderer
ipcMain.on('save-session', (_, sessionData) => {
  try {
    const sessionPath = path.join(app.getPath('userData'), 'session.json');
    const existingSession = fs.existsSync(sessionPath)
      ? JSON.parse(fs.readFileSync(sessionPath, 'utf8'))
      : {};

    const updatedSession = {
      ...existingSession,
      ...sessionData,
      timezone:
        sessionData.timezone || existingSession.timezone || 'Asia/Kolkata',
    };

    fs.writeFileSync(sessionPath, JSON.stringify(updatedSession, null, 2));
    console.log(
      '[DEBUG] Main process: session.json updated successfully:',
      updatedSession,
    );
  } catch (error) {
    console.error('[DEBUG] Main process: Error writing session.json:', error);
  }
});

ipcMain.handle('get-session', () => {
  try {
    const sessionPath = path.join(app.getPath('userData'), 'session.json');
    if (fs.existsSync(sessionPath)) {
      return JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    }
  } catch (error) {
    console.error('[DEBUG] Main process: Error reading session.json:', error);
  }
  return null;
});

// Handle IPC messages from renderer
ipcMain.on('ipc-example', async (event, arg) => {
  const msgTemplate = (pingPong: string) => `IPC test: ${pingPong}`;
  console.log(msgTemplate(arg));
  event.reply('ipc-example', msgTemplate('pong'));
});

// Handle idle time check
ipcMain.handle('get-idle-time', () => {
  return powerMonitor.getSystemIdleTime();
});

// Handle reading a file as base64
ipcMain.handle('read-file-as-base64', async (_, filePath) => {
  try {
    console.log(`[DEBUG] Main process: Reading file as base64: ${filePath}`);
    if (!fs.existsSync(filePath)) {
      console.error(`[DEBUG] Main process: File does not exist: ${filePath}`);
      return { error: true, message: 'File does not exist', data: null };
    }

    const data = fs.readFileSync(filePath);
    const base64Data = data.toString('base64');
    console.log(
      `[DEBUG] Main process: File read successfully, size: ${data.length} bytes`,
    );
    return {
      error: false,
      message: 'File read successfully',
      data: base64Data,
    };
  } catch (error) {
    console.error(`[DEBUG] Main process: Error reading file: ${error}`);
    return { error: true, message: `Error reading file: ${error}`, data: null };
  }
});

// Handle deleting a file
ipcMain.handle('delete-file', async (_, filePath) => {
  try {
    console.log(`[DEBUG] Main process: Deleting file: ${filePath}`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(
        `[DEBUG] Main process: File deleted successfully: ${filePath}`,
      );
      return { error: false, message: 'File deleted successfully' };
    }
    console.warn(
      `[DEBUG] Main process: File to delete does not exist: ${filePath}`,
    );
    return { error: true, message: 'File does not exist' };
  } catch (error) {
    console.error(`[DEBUG] Main process: Error deleting file: ${error}`);
    return { error: true, message: `Error deleting file: ${error}` };
  }
});

// Handle screenshot request
ipcMain.on('take-screenshot', async (event) => {
  try {
    console.log('[DEBUG] Main process: Starting screenshot capture');
    // Get all available sources
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    });
    console.log(`[DEBUG] Main process: Got ${sources.length} screen sources`);

    if (sources.length > 0) {
      const primaryDisplay = sources[0];
      const screenshotPath = path.join(app.getPath('userData'), 'screenshots');
      console.log(
        `[DEBUG] Main process: Screenshot directory: ${screenshotPath}`,
      );

      // Create screenshots directory if it doesn't exist
      if (!fs.existsSync(screenshotPath)) {
        console.log('[DEBUG] Main process: Creating screenshots directory');
        fs.mkdirSync(screenshotPath, { recursive: true });
      }

      // Save screenshot
      const timestamp = new Date().toISOString().replace(/:/g, '-');
      const filePath = path.join(screenshotPath, `screenshot-${timestamp}.png`);
      console.log(`[DEBUG] Main process: Saving screenshot to: ${filePath}`);

      // Convert NativeImage to buffer and save to file
      const imageBuffer = primaryDisplay.thumbnail.toPNG();
      fs.writeFileSync(filePath, imageBuffer);
      console.log('[DEBUG] Main process: Screenshot saved successfully');

      // Read the file to verify it exists and has content
      try {
        const stats = fs.statSync(filePath);
        console.log(
          `[DEBUG] Main process: Screenshot file size: ${stats.size} bytes`,
        );
        if (stats.size === 0) {
          console.error('[DEBUG] Main process: Screenshot file is empty');
        }
      } catch (readError) {
        console.error(
          `[DEBUG] Main process: Error reading screenshot file: ${readError}`,
        );
      }

      event.reply('screenshot-taken', filePath);
    } else {
      console.error('[DEBUG] Main process: No screen sources available');
      event.reply('screenshot-taken', '');
    }
  } catch (error) {
    console.error(`[DEBUG] Main process: Error taking screenshot: ${error}`);
    event.reply('screenshot-taken', '');
  }
});

// Check if app is set as a startup item
ipcMain.handle('check-startup-status', () => {
  const settings = app.getLoginItemSettings();
  return settings.openAtLogin;
});

// Set app as a startup item
ipcMain.handle('set-startup-status', (_, enable) => {
  app.setLoginItemSettings({
    openAtLogin: enable,
    // On macOS, this opens the app in the background
    openAsHidden: false,
  });
  return app.getLoginItemSettings().openAtLogin;
});

// Show startup prompt dialog
ipcMain.handle('show-startup-prompt', async () => {
  if (!mainWindow) return false;

  const settings = app.getLoginItemSettings();
  // If already set to open at login, don't show the prompt
  if (settings.openAtLogin) return true;

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Yes', 'No'],
    defaultId: 0,
    title: 'Startup Settings',
    message:
      'Would you like to start this application automatically when you log in?',
    detail: 'This can be changed later in the application settings.',
  });

  const enableStartup = response === 0; // 'Yes' button was clicked

  if (enableStartup) {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: false,
    });
  }

  return enableStartup;
});

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

if (isDebug) {
  require('electron-debug').default();
}

const installExtensions = async () => {
  // Bypass extension installation due to Manifest V3 service worker registration/sandbox compatibility issues in newer Electron versions
  return null;
  /*
  try {
    const installer = require('electron-devtools-installer');
    const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
    const extensions = ['REACT_DEVELOPER_TOOLS'];

    console.log('Attempting to install DevTools extensions...');

    try {
      const result = await installer.default(
        extensions.map((name) => installer[name]),
        forceDownload,
      );
      console.log('DevTools extensions installed:', result);
      return result;
    } catch (err) {
      console.log('Error installing DevTools extensions:', err);
      return null;
    }
  } catch (error) {
    console.log('Failed to load electron-devtools-installer:', error);
    return null;
  }
  */
};

const createWindow = async () => {
  if (isDebug) {
    await installExtensions();
  }

  const RESOURCES_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets');

  const getAssetPath = (...paths: string[]): string => {
    return path.join(RESOURCES_PATH, ...paths);
  };

  mainWindow = new BrowserWindow({
    show: false,
    width: 450,
    height: 800,
    resizable: false,
    maximizable: false,
    icon: getAssetPath('nsv.png'),
    webPreferences: {
      preload: app.isPackaged
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, '../../.erb/dll/preload.js'),
    },
  });

  mainWindow.loadURL(resolveHtmlPath('index.html'));

  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) {
      throw new Error('"mainWindow" is not defined');
    }
    if (process.env.START_MINIMIZED) {
      mainWindow.minimize();
    } else {
      mainWindow.show();

      // Automatically enable startup on login (for both Mac and Windows)
      if (process.env.NODE_ENV === 'production') {
        const settings = app.getLoginItemSettings();

        // If not already set, enable it automatically
        if (!settings.openAtLogin) {
          console.log('Enabling auto-start on login...');
          app.setLoginItemSettings({
            openAtLogin: true,
            openAsHidden: false, // Open normally, not hidden
          });
          console.log('Auto-start enabled successfully');
        }
      }
    }
  });

  // Handle minimize event to ensure app continues running in background
  mainWindow.on('minimize', () => {
    console.log(
      '[DEBUG] Main process: Window minimized, app will continue running in background',
    );
    // The app will continue running in the background
    // No need to do anything special here, just log for debugging
  });

  // Handle Windows session end / shutdown events
  mainWindow.on('session-end', () => {
    console.log(
      '[DEBUG] Main process: session-end event received on mainWindow.',
    );
    isAppQuitting = true;
    app.quit();
  });

  mainWindow.on('query-session-end', (event) => {
    handleGracefulShutdown(event, 'query-session-end');
  });

  // Handle close event to show confirmation dialog
  mainWindow.on('close', (event) => {
    if (isAppQuitting) {
      return;
    }
    // Prevent the default close behavior
    event.preventDefault();

    // Ask renderer for clock-in status
    mainWindow?.webContents.send('check-clock-in-status');

    // Wait for a one-time response from renderer
    ipcMain.once('clock-in-status-response', (_e, isUserClockedIn: boolean) => {
      console.log(
        `[DEBUG] Main process: User clocked in status: ${isUserClockedIn}`,
      );

      if (isUserClockedIn) {
        dialog
          .showMessageBox(mainWindow!, {
            type: 'question',
            buttons: ['Clock Out & Exit', 'Continue Working'],
            defaultId: 1,
            title: 'Confirm Exit',
            message: 'Do you want to clock out and exit?',
            detail:
              'If you exit without clocking out, the app will stop taking screenshots and logging activity.',
          })
          .then(({ response }) => {
            if (response === 0) {
              mainWindow!.webContents.send('clock-out-and-exit');
              setTimeout(() => {
                mainWindow!.destroy();
              }, 1000);
            }
          })
          .catch(console.error);
      } else {
        dialog
          .showMessageBox(mainWindow!, {
            type: 'question',
            buttons: ['Exit', 'Cancel'],
            defaultId: 1,
            title: 'Confirm Exit',
            message: 'Do you want to exit the application?',
            detail: 'You are not currently clocked in.',
          })
          .then(({ response }) => {
            if (response === 0) {
              mainWindow!.destroy();
            }
          })
          .catch(console.error);
      }
    });
  });

  // Handle closed event (after the window is actually closed)
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Listen for system suspend/sleep and shutdown events
  powerMonitor.on('suspend', () => {
    console.log('[DEBUG] Main process: System entering suspend/sleep mode');
    if (!mainWindow) return;

    // Get current hour and minute in Indian Standard Time (IST)
    const now = new Date();
    const istTimeStr = now.toLocaleString('en-US', {
      timeZone: 'Asia/Kolkata',
    });
    const istDate = new Date(istTimeStr);
    const istHour = istDate.getHours();
    const istMinute = istDate.getMinutes();

    // Check if it is after 7:15 PM IST (19:15)
    const isAfter715PmIst =
      istHour > 19 || (istHour === 19 && istMinute >= 15) || istHour < 6;

    if (isAfter715PmIst) {
      console.log(
        '[DEBUG] Main process: Suspend event after 7:15 PM IST. Triggering clock-out...',
      );
      mainWindow.webContents.send('clock-out-and-exit');
    } else {
      console.log(
        '[DEBUG] Main process: Suspend event before 7:15 PM IST. Marking user as idle...',
      );
      mainWindow.webContents.send('system-suspend-before-715');
    }
  });

  powerMonitor.on('shutdown', () => {
    console.log(
      '[DEBUG] Main process: System shutting down. Calling app.quit() to trigger graceful clockout...',
    );
    app.quit();
  });

  const menuBuilder = new MenuBuilder(mainWindow);
  menuBuilder.buildMenu();

  // Open urls in the user's browser
  mainWindow.webContents.setWindowOpenHandler((edata) => {
    shell.openExternal(edata.url);
    return { action: 'deny' };
  });

  // Remove this if your app does not use auto updates
  // eslint-disable-next-line
  new AppUpdater();
};

app.on('before-quit', (event) => {
  handleGracefulShutdown(event, 'before-quit');
});

app.on('window-all-closed', () => {
  // Respect the OSX convention of having the application in memory even
  // after all windows have been closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app
  .whenReady()
  .then(() => {
    createWindow();
    app.on('activate', () => {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (mainWindow === null) createWindow();
    });
  })
  .catch(console.log);
