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

// API base URL from white label configuration
const API_BASE_URL = whiteLabelConfig.app.apiBaseUrl;

// Helper function to check if the device is online
const isOnline = (): boolean => {
  return navigator.onLine;
};

// Custom event for unauthorized responses
export const UNAUTHORIZED_EVENT = 'api:unauthorized';

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

    const responseData: ApiResponse<T> = await response.json();
    return responseData;
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

  if (!response.error && response.data) {
    // Mark all activity logs as synced instead of deleting them to maintain complete history
    console.log(`[DEBUG] API: Marking ${logData.action} log as synced`);
    await databaseService.markActivityLogAsSynced(savedLog.id!);
  }

  return response;
}

// Sync unsynced logs
export async function syncUnsyncedLogs(
  token: string,
  workspaceId: number,
): Promise<void> {
  if (!isOnline()) {
    console.log('[API] Cannot sync logs: offline');
    return; // Can't sync if offline
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
    return;
  }

  for (const log of sortedLogs) {
    console.log(
      `[API] Syncing log: ${log.action} at ${log.timestamp} (ID: ${log.id})`,
    );
    const { id, synced, ...logData } = log;
    const response = await apiRequest<ActivityLog>(
      'log-update',
      'POST',
      logData,
      token,
      workspaceId,
    );

    if (!response.error) {
      // Mark all activity logs as synced instead of deleting them to maintain complete history
      console.log(`[API] Marking ${logData.action} log as synced during sync`);
      await databaseService.markActivityLogAsSynced(id!);
      console.log(`[API] Successfully synced log: ${log.action}`);
    } else {
      console.error(
        `[API] Failed to sync log: ${log.action}, error: ${response.message}`,
      );
    }
  }

  console.log('[API] Finished syncing activity logs');
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

      // Get the filename from the path
      const filename = filePath.split('/').pop() || 'screenshot.png';
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

    const responseData = await uploadResponse.json();
    console.log(`[DEBUG] API: Response data: ${JSON.stringify(responseData)}`);
    return responseData;
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
): Promise<void> {
  if (!isOnline()) {
    return; // Can't sync if offline
  }

  const unsyncedScreenshots = await databaseService.getUnsyncedScreenshots();

  for (const screenshot of unsyncedScreenshots) {
    const response = await uploadScreenshot(
      token,
      workspaceId,
      screenshot.filePath,
      screenshot.timestamp,
    );

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
    }
  }
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
