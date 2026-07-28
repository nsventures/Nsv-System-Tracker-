import {
  LoginRequest,
  LogUpdateRequest,
  ApiResponse,
  User,
  Config,
  ActivityLog,
} from '../types';
import databaseService from './database';
import whiteLabelConfig from '../../whiteLabel.config';
import { MAX_SYNC_ATTEMPTS, isInBackoff } from '../utils/syncBackoff';

// API base URL from white label configuration
const API_BASE_URL = whiteLabelConfig.app.apiBaseUrl;

// Helper function to check if the device is online
const isOnline = (): boolean => {
  return navigator.onLine;
};

// Custom event for unauthorized responses
export const UNAUTHORIZED_EVENT = 'api:unauthorized';

// Normalize a non-2xx response body into our ApiResponse shape.
// The server signals rejections with an HTTP status and a body like
// { message: 'FORCE_CLOCKOUT', code: 'FORCE_CLOCKOUT' } that carries no
// `error` flag. Without this, `!response.error` reads as success and a
// rejected log/screenshot gets marked synced (and its local file deleted).
function normalizeErrorResponse<T>(
  status: number,
  body: Partial<ApiResponse<T>> | null,
): ApiResponse<T> {
  return {
    ...(body || {}),
    error: true,
    message: body?.message || `Request failed with status ${status}`,
    // Fall back to `message` so a body that only carries FORCE_CLOCKOUT there
    // is still recognized by the force-clockout handlers.
    code: body?.code || body?.message,
    status,
  } as ApiResponse<T>;
}

// A 4xx (other than FORCE_CLOCKOUT, handled separately) means the server will
// reject this payload every time — e.g. 422 validation. Retrying it on the 60s
// sync loop would repeat forever, so such logs are dropped from the queue.
// 5xx and network failures have no `status` here and stay retryable.
function isTerminalRejection<T>(response: ApiResponse<T>): boolean {
  return (
    typeof response.status === 'number' &&
    response.status >= 400 &&
    response.status < 500 &&
    response.code !== 'FORCE_CLOCKOUT'
  );
}

// Parse a JSON body without throwing on empty/non-JSON error responses
async function parseJsonSafely<T>(
  response: Response,
): Promise<Partial<ApiResponse<T>> | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// Helper function to make API requests
async function apiRequest<T>(
  endpoint: string,
  method: string,
  data?: any,
  token?: string,
  workspaceId?: number,
): Promise<ApiResponse<T>> {
  try {
    // eslint-disable-next-line no-undef
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    if (workspaceId) {
      headers['workspace-id'] = workspaceId.toString();
    }

    const response = await fetch(`${API_BASE_URL}/${endpoint}`, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });

    // Check for 401 Unauthorized response
    if (response.status === 401) {
      console.log('Received 401 Unauthorized response, triggering logout');
      // Dispatch a custom event to notify the app
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
      return {
        error: true,
        message: 'Unauthorized. Please log in again.',
      };
    }

    const body = await parseJsonSafely<T>(response);

    // A rejection (e.g. 403 FORCE_CLOCKOUT) may arrive without an `error` flag.
    // Derive it from the status so downstream success checks stay correct.
    if (!response.ok) {
      const normalized = normalizeErrorResponse<T>(response.status, body);
      console.warn(
        `[API] ${endpoint} rejected with status ${response.status}, code: ${normalized.code}`,
      );
      return normalized;
    }

    return (body || { error: false, message: '' }) as ApiResponse<T>;
  } catch (error) {
    console.error('API request failed:', error);
    return {
      error: true,
      message: 'Network error. Please check your connection.',
    };
  }
}

// Login function
export async function login(
  credentials: LoginRequest,
): Promise<ApiResponse<User>> {
  if (!isOnline()) {
    return {
      error: true,
      message: 'You are offline. Please check your internet connection.',
    };
  }

  const response = await apiRequest<User>('login', 'POST', credentials);

  if (!response.error && response.data && response.token) {
    // Save auth data to IndexedDB for offline use
    // eslint-disable-next-line import/no-named-as-default-member
    await databaseService.saveAuth({
      token: response.token,
      user: response.data,
      isAuthenticated: true,
    });
  }

  return response;
}

// Load configuration
export async function loadConfig(
  token: string,
  workspaceId: number,
): Promise<ApiResponse<Config>> {
  // Try to get config from local storage first
  // eslint-disable-next-line import/no-named-as-default-member
  const localConfig = await databaseService.getConfig();

  // If offline, return local config if available
  if (!isOnline()) {
    if (localConfig) {
      return {
        error: false,
        message: 'Config loaded from local storage.',
        data: localConfig,
      };
    }
    return {
      error: true,
      message: 'You are offline and no local configuration is available.',
    };
  }

  // If online, fetch from server
  const response = await apiRequest<Config>(
    'load-config',
    'GET',
    undefined,
    token,
    workspaceId,
  );

  if (!response.error && response.data) {
    // Get existing config to preserve local-only fields (like totalBreakTime and lastBreakResetDate)
    const existingConfig = await databaseService.getConfig();
    const mergedConfig = {
      ...existingConfig,
      ...response.data,
    };
    // Save config to IndexedDB for offline use
    // eslint-disable-next-line import/no-named-as-default-member
    await databaseService.saveConfig(mergedConfig);
  }

  return response;
}

// Log update function
export async function logUpdate(
  token: string,
  workspaceId: number,
  logData: LogUpdateRequest,
): Promise<ApiResponse<ActivityLog>> {
  // Create activity log with synced status
  const activityLog: ActivityLog = {
    ...logData,
    synced: false, // Start as unsynced; will be marked synced after successful API call
  };

  // eslint-disable-next-line import/no-named-as-default-member
  const savedLog = await databaseService.saveActivityLog(activityLog);

  // If offline, queue for later sync
  if (!isOnline()) {
    return {
      error: false,
      message: 'Log saved locally and will be synced when online.',
      data: savedLog,
    };
  }

  const response = await apiRequest<ActivityLog>(
    'log-update',
    'POST',
    logData,
    token,
    workspaceId,
  );

  // Any non-error response means the server accepted the punch, deduped it, or
  // deliberately ignored it (code: 'NOOP' for a redundant/out-of-order punch).
  // All three are terminal — mark it synced so it is not retried forever.
  // Do NOT also require `response.data`: no-op and duplicate responses may omit it.
  if (!response.error) {
    console.log(
      `[DEBUG] API: Marking ${logData.action} log as synced${
        response.code ? ` (code: ${response.code})` : ''
      }`,
    );
    await databaseService.markActivityLogAsSynced(savedLog.id!);
  }

  return response;
}

// Sync unsynced logs
export async function syncUnsyncedLogs(
  token: string,
  workspaceId: number,
): Promise<boolean> {
  if (!isOnline()) {
    console.log('[API] Cannot sync logs: offline');
    return false; // Can't sync if offline
  }

  const unsyncedLogs = await databaseService.getUnsyncedActivityLogs();

  // Sort chronologically by ID to guarantee strict chronological order when syncing back to the server
  const sortedLogs = [...unsyncedLogs].sort(
    (a, b) => (a.id || 0) - (b.id || 0),
  );

  console.log(
    `[API] Found ${sortedLogs.length} unsynced activity logs to sync`,
  );

  if (sortedLogs.length === 0) {
    console.log('[API] No unsynced logs to sync');
    return false;
  }

  let forceClockoutDetected = false;

  for (const log of sortedLogs) {
    // Space out retries of a repeatedly-failing item so it doesn't re-hit the
    // server every 60s and block healthy items behind it.
    if (isInBackoff(log)) {
      console.log(
        `[API] Skipping ${log.action} (in backoff, attempt ${log.attempts})`,
      );
      // eslint-disable-next-line no-continue
      continue;
    }

    console.log(
      `[API] Syncing log: ${log.action} at ${log.timestamp} (ID: ${log.id})`,
    );
    const { id } = log;
    // Send only the four contract fields — never the local queue bookkeeping
    // (attempts/lastAttemptAt/deadLettered/syncError) or the synced flag.
    const logData = {
      user_id: log.user_id,
      action: log.action,
      timestamp: log.timestamp,
      reason: log.reason,
    };
    const response = await apiRequest<ActivityLog>(
      'log-update',
      'POST',
      logData,
      token,
      workspaceId,
    );

    if (response && response.error && response.code === 'FORCE_CLOCKOUT') {
      // The user is clocked out server-side, so this punch will be rejected on
      // every future attempt. Retire it from the queue — leaving it unsynced
      // made each 60s sync cycle re-POST it, re-trigger the force-clockout
      // handler and re-notify the user indefinitely. Keep draining the rest of
      // the queue (a queued clock-in later in the batch is still acceptable to
      // the server) and report the force-clockout once, at the end.
      console.warn(
        `[API] FORCE_CLOCKOUT while syncing ${log.action} at ${log.timestamp} — retiring from queue`,
      );
      await databaseService.markActivityLogAsSynced(id!);
      forceClockoutDetected = true;
    } else if (isTerminalRejection(response)) {
      // Permanently rejected (e.g. 422 validation). Retrying would loop forever
      // on the 60s sync cycle, so retire it from the queue and log loudly.
      console.error(
        `[API] Dropping permanently rejected log: ${log.action} at ${log.timestamp} ` +
          `(status ${response.status}, code: ${response.code}, message: ${response.message})`,
      );
      await databaseService.markActivityLogAsSynced(id!);
    } else if (!response.error) {
      // Mark all activity logs as synced instead of deleting them to maintain complete history
      console.log(`[API] Marking ${logData.action} log as synced during sync`);
      await databaseService.markActivityLogAsSynced(id!);
      console.log(`[API] Successfully synced log: ${log.action}`);
    } else {
      // Transient failure (5xx / network). Count the attempt so it backs off,
      // and dead-letter only at the high safety cap so a poison item can't
      // grow the queue forever — while a real outage keeps retrying.
      const attemptCount = await databaseService.bumpActivityLogAttempts(id!);
      if (attemptCount >= MAX_SYNC_ATTEMPTS) {
        console.error(
          `[API] Dead-lettering log after ${attemptCount} attempts: ${log.action} at ${log.timestamp} — ${response.message}`,
        );
        await databaseService.deadLetterActivityLog(
          id!,
          response.message || 'unknown sync error',
        );
      } else {
        console.error(
          `[API] Failed to sync log (attempt ${attemptCount}/${MAX_SYNC_ATTEMPTS}): ${log.action}, error: ${response.message}`,
        );
      }
    }
  }

  console.log('[API] Finished syncing activity logs');
  return forceClockoutDetected;
}

// Check auth status
export async function checkAuthStatus(): Promise<boolean> {
  const auth = await databaseService.getAuth();
  return !!auth && auth.isAuthenticated;
}

// Logout function
export async function logout(): Promise<void> {
  await databaseService.clearAuth();
}

// Upload screenshot function
export async function uploadScreenshot(
  token: string,
  workspaceId: number,
  filePath: string,
  timestamp: string,
): Promise<ApiResponse<any>> {
  console.log(`[DEBUG] API: Starting screenshot upload for file: ${filePath}`);

  if (!isOnline()) {
    console.log('[DEBUG] API: Device is offline, cannot upload screenshot');
    return {
      error: true,
      message: 'You are offline. Screenshot will be uploaded when online.',
    };
  }

  try {
    // Create FormData object
    const formData = new FormData();
    console.log('[DEBUG] API: Created FormData object');

    // Read the file from the filesystem using the main process
    try {
      console.log('[DEBUG] API: Attempting to read file using Electron IPC');

      // Get the filename from the path. Split on both separators: main.ts
      // builds this path with path.join(), so it is backslash-separated on
      // Windows and splitting on '/' alone sent the entire absolute path
      // ("C:\Users\...\screenshot-x.png") as the multipart filename.
      const filename = filePath.split(/[\\/]/).pop() || 'screenshot.png';
      console.log(`[DEBUG] API: Filename extracted: ${filename}`);

      // Read the file as base64 using the main process
      const result = await window.electron.system.readFileAsBase64(filePath);
      console.log(`[DEBUG] API: File read result: ${JSON.stringify(result)}`);

      if (result.error || !result.data) {
        console.error(`[DEBUG] API: Error reading file: ${result.message}`);
        return {
          error: true,
          message: `Error reading screenshot file: ${result.message || 'No data returned'}`,
        };
      }

      // Convert base64 to blob
      const base64Data = result.data;
      const byteCharacters = atob(base64Data);
      const byteArrays = [];

      for (let offset = 0; offset < byteCharacters.length; offset += 512) {
        const slice = byteCharacters.slice(offset, offset + 512);

        const byteNumbers = new Array(slice.length);
        for (let i = 0; i < slice.length; i++) {
          byteNumbers[i] = slice.charCodeAt(i);
        }

        const byteArray = new Uint8Array(byteNumbers);
        byteArrays.push(byteArray);
      }

      const blob = new Blob(byteArrays, { type: 'image/png' });
      console.log(
        `[DEBUG] API: Created blob from base64 data, size: ${blob.size} bytes`,
      );

      // Append the blob to FormData
      formData.append('screenshot', blob, filename);
      console.log('[DEBUG] API: Appended screenshot blob to FormData');
    } catch (fileError) {
      console.error(
        `[DEBUG] API: Error processing screenshot file: ${fileError}`,
      );
      return {
        error: true,
        message: `Error processing screenshot file: ${fileError}`,
      };
    }

    // Append the timestamp
    formData.append('timestamp', timestamp);
    console.log(`[DEBUG] API: Appended timestamp: ${timestamp}`);

    // Set up headers
    const headers: HeadersInit = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'workspace-id': workspaceId.toString(),
    };
    console.log('[DEBUG] API: Set up request headers');

    // Make the request
    console.log(
      `[DEBUG] API: Sending POST request to ${API_BASE_URL}/upload-screenshot`,
    );
    const uploadResponse = await fetch(`${API_BASE_URL}/upload-screenshot`, {
      method: 'POST',
      headers,
      body: formData,
    });
    console.log(
      `[DEBUG] API: Received response with status: ${uploadResponse.status}`,
    );

    const responseData = await parseJsonSafely<any>(uploadResponse);
    console.log(`[DEBUG] API: Response data: ${JSON.stringify(responseData)}`);

    // Same normalization as apiRequest: without it a 403 FORCE_CLOCKOUT reads
    // as success and the local screenshot file is deleted from disk.
    if (!uploadResponse.ok) {
      const normalized = normalizeErrorResponse<any>(
        uploadResponse.status,
        responseData,
      );
      console.warn(
        `[API] Screenshot upload rejected with status ${uploadResponse.status}, code: ${normalized.code}`,
      );
      return normalized;
    }

    return (responseData || { error: false, message: '' }) as ApiResponse<any>;
  } catch (error) {
    console.error(`[DEBUG] API: Error uploading screenshot: ${error}`);
    return {
      error: true,
      message: `Error uploading screenshot: ${error}`,
    };
  }
}

// Sync unsynced screenshots
export async function syncUnsyncedScreenshots(
  token: string,
  workspaceId: number,
): Promise<boolean> {
  if (!isOnline()) {
    return false; // Can't sync if offline
  }

  const unsyncedScreenshots = await databaseService.getUnsyncedScreenshots();
  console.log(
    `[API] Found ${unsyncedScreenshots.length} unsynced screenshots to sync`,
  );

  for (const screenshot of unsyncedScreenshots) {
    // Back off a repeatedly-failing upload instead of retrying it every cycle.
    if (isInBackoff(screenshot)) {
      console.log(
        `[API] Skipping screenshot ${screenshot.id} (in backoff, attempt ${screenshot.attempts})`,
      );
      // eslint-disable-next-line no-continue
      continue;
    }

    console.log(
      `[API] Syncing screenshot: ${screenshot.filePath} (ID: ${screenshot.id})`,
    );
    const response = await uploadScreenshot(
      token,
      workspaceId,
      screenshot.filePath,
      screenshot.timestamp,
    );

    if (response && response.error && response.code === 'FORCE_CLOCKOUT') {
      // The user is clocked out server-side. Unlike an activity log — a
      // discrete event the server refuses permanently — a screenshot captured
      // before the clock-out is real work product, so it is KEPT for retry
      // rather than discarded. Stop after this one rejection instead of pushing
      // the whole backlog at a server that will refuse all of it; the
      // idempotency guard in handleForceClockout() prevents the repeat
      // rejections from re-notifying the user each cycle.
      console.warn(
        `[API] FORCE_CLOCKOUT while syncing screenshots — preserving backlog of ` +
          `${unsyncedScreenshots.length} screenshot(s) for retry after next clock-in`,
      );
      return true;
    }

    if (!response.error) {
      // Delete the record from the local database once synced
      await databaseService.deleteScreenshot(screenshot.id!);

      // Delete the file from the filesystem using electron IPC
      try {
        console.log(
          `[DEBUG] Sync: Deleting local file from disk: ${screenshot.filePath}`,
        );
        await window.electron.system.deleteFile(screenshot.filePath);
      } catch (error) {
        console.error(
          'Error deleting synced screenshot file from disk:',
          error,
        );
      }
    } else if (isTerminalRejection(response)) {
      // The server will reject this upload every time (e.g. 422). Retiring it
      // reclaims the disk and stops it looping forever.
      console.error(
        `[API] Dropping permanently rejected screenshot ${screenshot.id} ` +
          `(status ${response.status}, code ${response.code})`,
      );
      await databaseService.deadLetterScreenshot(
        screenshot.id!,
        response.message || 'terminal rejection',
      );
      try {
        await window.electron.system.deleteFile(screenshot.filePath);
      } catch (error) {
        console.error('Error deleting rejected screenshot file:', error);
      }
    } else {
      // Transient failure: back off, and dead-letter only at the safety cap.
      const attemptCount = await databaseService.bumpScreenshotAttempts(
        screenshot.id!,
      );
      if (attemptCount >= MAX_SYNC_ATTEMPTS) {
        console.error(
          `[API] Dead-lettering screenshot ${screenshot.id} after ${attemptCount} attempts — ${response.message}`,
        );
        await databaseService.deadLetterScreenshot(
          screenshot.id!,
          response.message || 'unknown sync error',
        );
        try {
          await window.electron.system.deleteFile(screenshot.filePath);
        } catch (error) {
          console.error('Error deleting dead-lettered screenshot file:', error);
        }
      } else {
        console.error(
          `[API] Failed to upload screenshot ${screenshot.id} (attempt ${attemptCount}/${MAX_SYNC_ATTEMPTS}): ${response.message}`,
        );
      }
    }
  }

  // Reaching here means the whole queue drained without a force-clockout.
  console.log('[API] Finished syncing screenshots');
  return false;
}

// Export the API service
const apiService = {
  login,
  loadConfig,
  logUpdate,
  syncUnsyncedLogs,
  uploadScreenshot,
  syncUnsyncedScreenshots,
  checkAuthStatus,
  logout,
  isOnline,
};

export default apiService;
