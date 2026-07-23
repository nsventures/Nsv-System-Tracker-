import { NetworkStatus } from '../types';
import apiService from './api';
import databaseService from './database';
import activityService from './activity';
import whiteLabelConfig from '../../whiteLabel.config';

// Create a class to manage network status and synchronization
class NetworkService {
  private isOnline: boolean;

  private listeners: ((status: NetworkStatus) => void)[];

  private lastSyncTime: string | null = null;

  constructor() {
    this.isOnline = navigator.onLine;
    this.listeners = [];

    // Add event listeners for online/offline events
    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);

    // Trigger initial sync on startup after a small delay to let services initialize
    setTimeout(() => {
      console.log('[Sync] Triggering initial startup sync...');
      this.syncDataWithRetry();
    }, 5000);

    // Periodically run sync every 1 minute in case of temporary server outages
    setInterval(() => {
      if (this.isOnline) {
        console.log('[Sync] Running periodic background sync...');
        this.syncData();
      }
    }, 60000); // 1 minute
  }

  // Handle online event
  private handleOnline = async () => {
    console.log('Network connection restored');
    this.isOnline = true;

    // Notify listeners
    this.notifyListeners();

    // Wait a moment for network to stabilize before syncing
    console.log('Waiting 1 second for network to stabilize...');
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Sync unsynced logs with retry mechanism
    await this.syncDataWithRetry();
  };

  // Handle offline event
  private handleOffline = () => {
    console.log('Network connection lost');
    this.isOnline = false;

    // Notify listeners
    this.notifyListeners();
  };

  // Notify all listeners of network status change
  private notifyListeners() {
    const status: NetworkStatus = {
      isOnline: this.isOnline,
      lastSyncTime: this.lastSyncTime || undefined,
    };
    this.listeners.forEach((listener) => listener(status));
  }

  // Add a listener for network status changes
  public addListener(listener: (status: NetworkStatus) => void) {
    this.listeners.push(listener);

    // Immediately notify the new listener of the current status
    listener({ isOnline: this.isOnline });

    // Return a function to remove the listener
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  // Get current network status
  public getStatus(): NetworkStatus {
    return {
      isOnline: this.isOnline,
      lastSyncTime: this.lastSyncTime || undefined,
    };
  }

  // Sync data with retry mechanism
  private async syncDataWithRetry(maxRetries: number = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[Sync] Attempt ${attempt} of ${maxRetries}`);
        await this.syncData();
        console.log('[Sync] Successfully synced all data');
        return; // Success, exit retry loop
      } catch (error) {
        console.error(`[Sync] Attempt ${attempt} failed:`, error);

        if (attempt < maxRetries) {
          // Exponential backoff: 2s, 4s, 8s
          const delayMs = 2 ** attempt * 1000;
          console.log(`[Sync] Retrying in ${delayMs / 1000} seconds...`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        } else {
          console.error('[Sync] All retry attempts failed');
        }
      }
    }
  }

  // Sync data with the server
  public async syncData() {
    if (!this.isOnline) {
      console.log('[Sync] Cannot sync data: offline');
      return;
    }

    try {
      console.log('[Sync] Starting data synchronization...');

      // Get auth data
      const auth = await databaseService.getAuth();

      if (!auth || !auth.isAuthenticated) {
        console.log('[Sync] Cannot sync data: not authenticated');
        return;
      }

      console.log(
        `[Sync] Authenticated as user ID: ${auth.user.user_id}, workspace ID: ${auth.user.workspace_id}`,
      );

      // Sync unsynced logs
      console.log('[Sync] Syncing unsynced activity logs...');
      const logsForceClockout = await apiService.syncUnsyncedLogs(
        auth.token,
        auth.user.workspace_id,
      );

      if (logsForceClockout) {
        // NOTE: deliberately does NOT clock the user out. See the comment
        // before the screenshot sync below.
        console.warn(
          '[Sync] FORCE_CLOCKOUT while syncing backlog logs — backlog paused, live session untouched',
        );
      }

      // Recalculate break time from newly synced logs
      await activityService.recalculateBreakTime();

      // Sync unsynced screenshots. This deliberately runs even when the log
      // sync above reported a force-clockout: returning early here meant a
      // backlog of screenshots captured offline could never drain, because
      // every sync cycle bailed out before reaching this point.
      console.log('[Sync] Syncing unsynced screenshots...');
      const screenshotsForceClockout = await apiService.syncUnsyncedScreenshots(
        auth.token,
        auth.user.workspace_id,
      );

      // A FORCE_CLOCKOUT here concerns a QUEUED, HISTORICAL item — a punch or
      // screenshot captured minutes or hours ago. The server rejects it because
      // the user was clocked out *at that item's timestamp*, which says nothing
      // about the session running right now. Acting on it clocked users out
      // seconds after a fresh clock-in, because a stale screenshot from an
      // earlier clocked-out period was still sitting in the backlog.
      //
      // So the sync path never terminates the live session. A genuine admin
      // force-clockout is still caught within one screenshot interval by the
      // live paths (logActivity and captureAndUpload), which submit
      // current-timestamped items and therefore reflect the user's real state.
      if (screenshotsForceClockout) {
        console.warn(
          '[Sync] FORCE_CLOCKOUT while syncing backlog screenshots — backlog paused, live session untouched',
        );
      }

      const now = new Date();

      const options: Intl.DateTimeFormatOptions = {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: whiteLabelConfig.timezone.default,
      };

      const formattedDate = now
        .toLocaleString('en-US', options)
        .replace(
          /(\d+)\/(\d+)\/(\d+),\s(\d+):(\d+):(\d+)/,
          '$3-$1-$2T$4:$5:$6',
        );

      this.lastSyncTime = `${formattedDate}Z`; // Adding Z to indicate UTC format for ISO compatibility

      // Notify listeners of the updated sync time
      this.notifyListeners();

      console.log('Data synchronized successfully');
    } catch (error) {
      console.error('Error syncing data:', error);
    }
  }

  // Clean up event listeners
  public cleanup() {
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
  }
}

// Create and export a singleton instance
const networkService = new NetworkService();

export default networkService;
