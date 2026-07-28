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
  systemPreferences,
  session as electronSession,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import fs from 'fs';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { URL } from 'url';
import MenuBuilder from './menu';
import { resolveHtmlPath } from './util';

const isLinux = process.platform === 'linux';
const isWaylandSession =
  isLinux &&
  (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);

if (isLinux) {
  app.commandLine.appendSwitch('no-sandbox');

  if (isWaylandSession) {
    // On Wayland, desktopCapturer.getSources() opens a NEW xdg-desktop-portal
    // ScreenCast session on every call, and the compositor asks the user to
    // consent to each one — so a 5-minute capture loop prompts endlessly.
    // The renderer instead holds a single getDisplayMedia() stream (see
    // screenshot.ts): one consent for the whole session, and the portal's own
    // picker can offer "remember" for persistence across restarts. PipeWire is
    // the transport that makes that stream work under Wayland.
    app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
    console.log(
      '[DEBUG] Main process: Wayland session detected — using persistent getDisplayMedia capture via PipeWire portal',
    );
  }
}

// Persist logs to userData/logs/main.log with rotation, and capture crashes in
// the main process so a field failure leaves a trace instead of vanishing.
log.transports.file.level = 'info';
log.transports.file.maxSize = 5 * 1024 * 1024; // rotate at 5 MB
process.on('uncaughtException', (error) => {
  log.error('[crash] Uncaught exception (main process):', error);
});
process.on('unhandledRejection', (reason) => {
  log.error('[crash] Unhandled promise rejection (main process):', reason);
});

// Re-check for updates on this cadence. The tracker runs for days without
// quitting, so a single check at startup would rarely catch a release; a
// downloaded update still only installs on the next app quit/restart.
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

class AppUpdater {
  constructor() {
    log.transports.file.level = 'info';
    autoUpdater.logger = log;

    // Surface the update lifecycle in main.log so a rollout is observable per
    // machine (what version was offered, downloaded, or why it was skipped).
    autoUpdater.on('checking-for-update', () => {
      log.info('[updater] Checking for update…');
    });
    autoUpdater.on('update-available', (info) => {
      log.info(`[updater] Update available: ${info.version}`);
    });
    autoUpdater.on('update-not-available', () => {
      log.info('[updater] No update available');
    });
    autoUpdater.on('update-downloaded', (info) => {
      log.info(
        `[updater] Update ${info.version} downloaded; installs on next quit/restart`,
      );
    });
    autoUpdater.on('error', (error) => {
      log.info(`[updater] Error: ${error?.message || error}`);
    });

    // A .deb install and unpackaged runs cannot self-update (no app-update.yml
    // / apt owns the package), so the check rejects — informational, not fatal.
    const check = () => {
      autoUpdater.checkForUpdatesAndNotify().catch((error) => {
        log.info(`[updater] Update check skipped: ${error?.message || error}`);
      });
    };

    check();
    setInterval(check, UPDATE_CHECK_INTERVAL_MS);
  }
}

let mainWindow: BrowserWindow | null = null;
let isAppQuitting = false;
let isClockoutInitiated = false;
let isClockoutComplete = false;

// Set by the OS-level shutdown handler before it calls app.quit(), so the
// generic before-quit path can tell a real system shutdown apart from an
// ordinary quit. Cleared implicitly by process exit.
let systemQuitSource: string | null = null;

/**
 * Human-readable reason recorded on the clock-out written when the app is
 * terminated while the user is still clocked in. The previous code labelled
 * every one of these "Gracefully clocked out on PC shutdown", which was
 * misleading — an overnight OS update reboot or a log-off is not a shutdown.
 */
function describeClockoutTrigger(source: string): string {
  switch (source) {
    case 'query-session-end':
    case 'session-end':
      return 'Auto clock-out: system session ended (restart, log-off, or OS update)';
    case 'system-shutdown':
      return 'Auto clock-out: system was shutting down';
    case 'before-quit':
    default:
      return 'Auto clock-out: application closed while still clocked in';
  }
}

// Must stay in sync with formatApiTimestamp() in
// src/renderer/utils/timeUtils.ts — the shutdown clock-out below is a real
// punch. Currently emits the legacy naive format; see API_TIMESTAMP_FORMAT
// there for why ISO-8601 is temporarily reverted.
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

function performDirectClockoutAsync(
  session: any,
  reason: string,
  timestamp: string,
): Promise<void> {
  return new Promise((resolve) => {
    try {
      const serverUrl =
        session.serverUrl || 'https://app.nsventures.in/api/plugin/timetracker';
      const endpoint = `${serverUrl}/log-update`;
      console.log(
        `[DEBUG] Graceful shutdown async: Sending direct native HTTP/HTTPS clockout request to ${endpoint}...`,
      );

      const payload = JSON.stringify({
        user_id: session.userId,
        action: 'clock-out',
        timestamp,
        reason,
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
  // A real OS shutdown routes through app.quit() → before-quit, which would
  // otherwise look like a plain quit; systemQuitSource preserves the specific
  // trigger so the recorded reason is accurate.
  const effectiveSource = systemQuitSource || source;
  // electron-log persists to userData/logs/main.log; console.log does not, and
  // an overnight OS-triggered quit has no terminal attached — so log here to
  // make the cause of these clock-outs provable after the fact.
  log.info(
    `[lifecycle] handleGracefulShutdown from "${source}" (effective: "${effectiveSource}"). initiated=${isClockoutInitiated}, complete=${isClockoutComplete}`,
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
        const clockoutReason = describeClockoutTrigger(effectiveSource);
        // Stamp the clock-out at the last heartbeated active time (written every
        // 30s by the renderer while clocked in), not "now" — otherwise an
        // overnight sleep or a crash-then-reboot counts every dead minute up to
        // the reboot as worked. Fall back to now only if no heartbeat exists.
        const clockoutTimestamp =
          typeof session.lastActiveTime === 'string' && session.lastActiveTime
            ? session.lastActiveTime
            : getLocalTimestamp(session.timezone);
        log.info(
          `[lifecycle] User still clocked in at ${effectiveSource}; clocking out at ${clockoutTimestamp}. Reason: "${clockoutReason}"`,
        );
        session.isClockedIn = false;
        session.lastActiveTime = clockoutTimestamp;
        fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));

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

        performDirectClockoutAsync(session, clockoutReason, clockoutTimestamp)
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

// Renderer-side crashes (window.onerror / unhandledrejection) are forwarded
// here so they land in the same persistent main.log as everything else.
ipcMain.on('log-error', (_event, payload) => {
  log.error('[crash] Renderer error:', payload);
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

// A blank/failed capture (missing permission, Wayland portal denied) still
// produces a valid but near-empty PNG. Below this it is almost certainly not a
// real screen, so it is dropped rather than uploaded as useless evidence.
const MIN_SCREENSHOT_BYTES = 2048;
let lastScreenshotSignature: string | null = null;

/**
 * Validate a screenshot buffer before it is saved. Returns false to drop the
 * frame. Identical-to-previous frames are logged (a static screen is
 * legitimate) rather than dropped.
 */
function isUsableScreenshot(buffer: Buffer, source: string): boolean {
  if (!buffer || buffer.length === 0) {
    log.warn(`[capture] ${source}: empty screenshot buffer — dropped`);
    return false;
  }
  if (buffer.length < MIN_SCREENSHOT_BYTES) {
    log.warn(
      `[capture] ${source}: screenshot only ${buffer.length} bytes — likely blank, dropped`,
    );
    return false;
  }
  const signature = crypto.createHash('md5').update(buffer).digest('hex');
  if (signature === lastScreenshotSignature) {
    log.warn(
      `[capture] ${source}: screenshot byte-identical to previous frame — capture may be frozen`,
    );
  }
  lastScreenshotSignature = signature;
  return true;
}

let hasPromptedForScreenAccess = false;

/**
 * macOS gates screen capture behind the Screen Recording TCC permission. Without
 * it desktopCapturer still "succeeds" but hands back a blank desktop image, so
 * check before capturing and point the user at System Settings once.
 * Returns false when capture should be skipped this cycle.
 */
function ensureScreenCaptureAccess(): boolean {
  if (process.platform !== 'darwin') {
    return true;
  }

  const status = systemPreferences.getMediaAccessStatus('screen');
  if (status === 'granted') {
    return true;
  }

  // 'not-determined' means the OS has never asked. Letting the capture run is
  // what triggers the system prompt, so do not block it.
  if (status === 'not-determined') {
    console.log(
      '[DEBUG] Main process: Screen recording permission not yet determined, capture will trigger the macOS prompt',
    );
    return true;
  }

  console.warn(
    `[DEBUG] Main process: Screen recording permission is "${status}" — screenshots will be blank`,
  );

  if (!hasPromptedForScreenAccess) {
    hasPromptedForScreenAccess = true;
    dialog
      .showMessageBox({
        type: 'warning',
        buttons: ['Open System Settings', 'Later'],
        defaultId: 0,
        title: 'Screen Recording Permission Required',
        message: 'NS Ventures needs permission to capture your screen.',
        detail:
          'Enable NS Ventures under Privacy & Security → Screen Recording, then restart the app. Until then, screenshots cannot be captured.',
      })
      .then(({ response }) => {
        if (response === 0) {
          shell.openExternal(
            'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
          );
        }
        return null;
      })
      .catch(console.error);
  }

  return false;
}

// Handle screenshot request
ipcMain.on('take-screenshot', async (event) => {
  try {
    console.log('[DEBUG] Main process: Starting screenshot capture');

    if (!ensureScreenCaptureAccess()) {
      event.reply('screenshot-taken', '');
      return;
    }

    // Get all available sources
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    });
    console.log(`[DEBUG] Main process: Got ${sources.length} screen sources`);

    if (sources.length > 0) {
      const primaryDisplay = sources[0];

      // Convert NativeImage to buffer and validate before writing anything.
      const imageBuffer = primaryDisplay.thumbnail.toPNG();
      if (
        primaryDisplay.thumbnail.isEmpty() ||
        !isUsableScreenshot(imageBuffer, 'desktopCapturer')
      ) {
        event.reply('screenshot-taken', '');
        return;
      }

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

// Tells the renderer which capture strategy to use. On Wayland it holds a
// single getDisplayMedia() stream instead of calling desktopCapturer per shot.
ipcMain.handle('get-display-env', () => {
  return {
    platform: process.platform,
    isWayland: isWaylandSession,
  };
});

// Persist a PNG captured in the renderer (the Wayland getDisplayMedia path
// produces the image as base64 there, not on disk). Mirrors the naming and
// location of the desktopCapturer path so the upload flow is identical.
ipcMain.handle('save-screenshot-buffer', async (_, base64Data: string) => {
  try {
    if (!base64Data) {
      return { error: true, message: 'Empty screenshot buffer', filePath: '' };
    }

    const buffer = Buffer.from(base64Data, 'base64');
    // Drop blank/failed captures (a denied Wayland portal yields a valid but
    // near-empty PNG) rather than saving and uploading them.
    if (!isUsableScreenshot(buffer, 'getDisplayMedia')) {
      return { error: true, message: 'Blank screenshot dropped', filePath: '' };
    }

    const screenshotPath = path.join(app.getPath('userData'), 'screenshots');
    if (!fs.existsSync(screenshotPath)) {
      fs.mkdirSync(screenshotPath, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const filePath = path.join(screenshotPath, `screenshot-${timestamp}.png`);
    fs.writeFileSync(filePath, buffer);

    console.log(
      `[DEBUG] Main process: Saved renderer screenshot (${buffer.length} bytes) to ${filePath}`,
    );

    return { error: false, message: 'Screenshot saved', filePath };
  } catch (error) {
    console.error(
      `[DEBUG] Main process: Error saving renderer screenshot: ${error}`,
    );
    return { error: true, message: `${error}`, filePath: '' };
  }
});

/**
 * Login-item support differs per platform (and is unavailable in some Linux
 * desktop environments), so every call is guarded — a failure here must never
 * take down window creation.
 */
function isAutoLaunchEnabled(): boolean {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch (error) {
    console.error(
      '[DEBUG] Main process: Unable to read login item settings:',
      error,
    );
    return false;
  }
}

function setAutoLaunch(enable: boolean): boolean {
  try {
    const settings: Parameters<typeof app.setLoginItemSettings>[0] = {
      openAtLogin: enable,
      // On macOS, this opens the app in the background
      openAsHidden: false,
    };

    // Autostart launches the binary directly, bypassing the desktop entry that
    // carries --no-sandbox, so the flag has to be repeated here or the app
    // aborts at login on distros that restrict unprivileged user namespaces.
    if (process.platform === 'linux') {
      // An AppImage runs from a temporary mountpoint, so process.execPath is
      // not a stable launcher to autostart. $APPIMAGE is the file the user keeps.
      settings.path = process.env.APPIMAGE || process.execPath;
      settings.args = ['--no-sandbox'];
    }

    app.setLoginItemSettings(settings);
    return isAutoLaunchEnabled();
  } catch (error) {
    console.error(
      '[DEBUG] Main process: Unable to update login item settings:',
      error,
    );
    return false;
  }
}

// Check if app is set as a startup item
ipcMain.handle('check-startup-status', () => {
  return isAutoLaunchEnabled();
});

// Set app as a startup item
ipcMain.handle('set-startup-status', (_, enable) => {
  return setAutoLaunch(enable);
});

// Show startup prompt dialog
ipcMain.handle('show-startup-prompt', async () => {
  if (!mainWindow) return false;

  // If already set to open at login, don't show the prompt
  if (isAutoLaunchEnabled()) return true;

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
    setAutoLaunch(true);
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
    // Square 512px source: nsv.png is 104x123, which Windows and GNOME both
    // letterbox into a smudge at taskbar sizes.
    icon: getAssetPath('nsv512x512.png'),
    webPreferences: {
      preload: app.isPackaged
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, '../../.erb/dll/preload.js'),
    },
  });

  // On Wayland the renderer captures via navigator.mediaDevices.getDisplayMedia,
  // which routes through this handler. Prefer the system (portal) picker so the
  // compositor can offer "remember this choice" for cross-restart persistence;
  // fall back to auto-selecting the primary screen if the picker is unavailable,
  // so capture still works headlessly rather than hanging on a dialog.
  if (isWaylandSession) {
    electronSession.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        desktopCapturer
          .getSources({ types: ['screen'] })
          .then((sources) => {
            if (sources.length > 0) {
              callback({ video: sources[0] });
            } else {
              // Electron's types require a source; there is no clean "deny"
              // here, so hand back an empty object and let getDisplayMedia
              // reject in the renderer.
              callback({});
            }
            return null;
          })
          .catch((error) => {
            console.error(
              '[DEBUG] Main process: Display media source selection failed:',
              error,
            );
            callback({});
          });
      },
      // useSystemPicker lets the portal present its own dialog (with a persist
      // option) instead of us silently auto-picking; Electron ignores the
      // handler above when the picker is supported.
      { useSystemPicker: true },
    );
  }

  const startUrl = resolveHtmlPath('index.html');
  console.log(`[DEBUG] Main process: Loading renderer from ${startUrl}`);
  mainWindow.loadURL(startUrl);

  // The window is created hidden and only revealed on 'ready-to-show'. If the
  // renderer fails to load, that event never fires and the app sits running
  // with no window and no error — indistinguishable from "it doesn't open".
  // These handlers make every such failure visible instead of silent.
  let hasShownWindow = false;
  const showMainWindow = (reason: string) => {
    if (hasShownWindow || !mainWindow) return;
    hasShownWindow = true;
    console.log(`[DEBUG] Main process: Showing window (${reason})`);
    if (process.env.START_MINIMIZED) {
      mainWindow.minimize();
    } else {
      mainWindow.show();
    }
  };

  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL) => {
      console.error(
        `[DEBUG] Main process: Renderer failed to load ${validatedURL} — ${errorDescription} (${errorCode})`,
      );
      showMainWindow('did-fail-load');
    },
  );

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(
      `[DEBUG] Main process: Renderer process gone — reason: ${details.reason}, exitCode: ${details.exitCode}`,
    );
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[DEBUG] Main process: Renderer is unresponsive');
  });

  // Last resort: never leave the user staring at nothing.
  const showFallbackTimer = setTimeout(() => {
    if (!hasShownWindow) {
      console.warn(
        '[DEBUG] Main process: ready-to-show did not fire within 15s, showing window anyway',
      );
      showMainWindow('fallback timeout');
    }
  }, 15000);

  mainWindow.on('closed', () => {
    clearTimeout(showFallbackTimer);
  });

  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) {
      throw new Error('"mainWindow" is not defined');
    }
    clearTimeout(showFallbackTimer);
    if (process.env.START_MINIMIZED) {
      mainWindow.minimize();
      hasShownWindow = true;
    } else {
      showMainWindow('ready-to-show');

      // Automatically enable startup on login (Windows, macOS and Linux)
      if (process.env.NODE_ENV === 'production') {
        // If not already set, enable it automatically
        if (!isAutoLaunchEnabled()) {
          console.log('Enabling auto-start on login...');
          const enabled = setAutoLaunch(true);
          console.log(
            enabled
              ? 'Auto-start enabled successfully'
              : 'Auto-start is not available on this platform',
          );
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
    log.info('[lifecycle] session-end received on mainWindow');
    systemQuitSource = 'session-end';
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

    // Use the machine's LOCAL time, matching how the app records everything
    // (whiteLabelConfig.timezone.default resolves to the system timezone). This
    // was previously hardcoded to Asia/Kolkata, so on a machine outside India
    // the "evening" cutoff fell across the working day and a lunchtime suspend
    // clocked the user out. getHours()/getMinutes() are already local.
    const now = new Date();
    const localHour = now.getHours();
    const localMinute = now.getMinutes();

    // After 7:15 PM local (or before 6 AM), suspend means the day is over →
    // clock out. Earlier in the day, a suspend is just a break → mark idle.
    const isAfterEveningCutoff =
      localHour > 19 ||
      (localHour === 19 && localMinute >= 15) ||
      localHour < 6;

    if (isAfterEveningCutoff) {
      console.log(
        '[DEBUG] Main process: Suspend event after 7:15 PM local time. Triggering clock-out...',
      );
      mainWindow.webContents.send('clock-out-and-exit');
    } else {
      console.log(
        '[DEBUG] Main process: Suspend event before 7:15 PM local time. Marking user as idle...',
      );
      mainWindow.webContents.send('system-suspend-before-715');
    }
  });

  powerMonitor.on('shutdown', () => {
    log.info(
      '[lifecycle] powerMonitor shutdown event — system is shutting down',
    );
    systemQuitSource = 'system-shutdown';
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
  if (app.isPackaged) {
    // eslint-disable-next-line
    new AppUpdater();
  }
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

// A second copy of the tracker running at once would double-count activity and
// take duplicate screenshots. Hold a single-instance lock; if another instance
// already owns it, surface that window and quit this one.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  log.info(
    '[lifecycle] Another instance is already running; quitting this one',
  );
  app.quit();
} else {
  app.on('second-instance', () => {
    log.info(
      '[lifecycle] Second-instance launch detected; focusing existing window',
    );
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app
    .whenReady()
    .then(() => {
      // One line that makes a terminal launch self-diagnosing on any platform.
      console.log(
        `[DEBUG] Main process: Starting ${app.getName()} ${app.getVersion()} — ` +
          `electron ${process.versions.electron}, ${process.platform}/${process.arch}, ` +
          `packaged=${app.isPackaged}, userData=${app.getPath('userData')}`,
      );
      createWindow();
      app.on('activate', () => {
        // On macOS it's common to re-create a window in the app when the
        // dock icon is clicked and there are no other windows open.
        if (mainWindow === null) createWindow();
      });
    })
    .catch(console.log);
}
