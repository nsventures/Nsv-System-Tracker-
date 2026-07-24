import { Screenshot } from '../types';
import apiService from './api';
import databaseService from './database';
// Note: networkService import removed as unused
import activityService from './activity';
import whiteLabelConfig from '../../whiteLabel.config';
import { formatApiTimestamp } from '../utils/timeUtils';

class ScreenshotService {
  private screenshotInterval: number = 300000; // Default: 5 minutes (in milliseconds)

  private intervalId: NodeJS.Timeout | null = null;

  private isRunning: boolean = false;

  private token: string | null = null;

  private workspaceId: number | null = null;

  // Wayland capture state. On Wayland the desktopCapturer path prompts for
  // portal consent on every call, so we hold ONE getDisplayMedia stream for the
  // whole session and grab still frames from it instead.
  private useDisplayMedia: boolean = false;

  private captureStream: MediaStream | null = null;

  private captureVideo: HTMLVideoElement | null = null;

  // Initialize the screenshot service
  public async initialize(): Promise<void> {
    try {
      console.log('[DEBUG] Initializing screenshot service');
      // Get auth data
      const auth = await databaseService.getAuth();
      if (!auth || !auth.isAuthenticated) {
        console.log(
          '[DEBUG] Cannot initialize screenshot service: not authenticated',
        );
        return;
      }

      this.token = auth.token;
      this.workspaceId = auth.user.workspace_id;
      console.log(
        '[DEBUG] Screenshot service authenticated with token and workspace ID',
      );

      // Decide the capture strategy once, from the session type reported by the
      // main process.
      try {
        const env = await window.electron.system.getDisplayEnv();
        this.useDisplayMedia = env.isWayland;
        console.log(
          `[DEBUG] Screenshot capture strategy: ${
            this.useDisplayMedia
              ? 'getDisplayMedia stream (Wayland)'
              : 'desktopCapturer (default)'
          }`,
        );
      } catch (envError) {
        console.error(
          '[DEBUG] Could not determine display env, defaulting to desktopCapturer:',
          envError,
        );
        this.useDisplayMedia = false;
      }

      // Get config
      const config = await databaseService.getConfig();
      if (config && config.screenshotInterval) {
        // Convert from seconds to milliseconds
        this.screenshotInterval = config.screenshotInterval;
      }

      console.log(
        `[DEBUG] Screenshot interval set to ${this.screenshotInterval / 1000} seconds`,
      );
    } catch (error) {
      console.error('[DEBUG] Error initializing screenshot service:', error);
    }
  }

  // Start taking screenshots at the specified interval
  public start(): void {
    console.log('[DEBUG] Starting screenshot service');
    if (this.isRunning) {
      console.log('[DEBUG] Screenshot service is already running');
      return;
    }

    if (!this.token || !this.workspaceId) {
      console.log('[DEBUG] Cannot start screenshot service: not authenticated');
      return;
    }

    this.isRunning = true;
    console.log('[DEBUG] Taking initial screenshot');
    this.captureAndUpload(); // Take a screenshot immediately

    // Set up interval for future screenshots
    console.log(
      `[DEBUG] Setting up screenshot interval: ${this.screenshotInterval / 1000} seconds`,
    );
    this.intervalId = setInterval(() => {
      this.captureAndUpload();
    }, this.screenshotInterval);

    console.log('[DEBUG] Screenshot service started successfully');
  }

  // Stop taking screenshots
  public stop(): void {
    console.log('[DEBUG] Stopping screenshot service');
    if (!this.isRunning || !this.intervalId) {
      console.log('[DEBUG] Screenshot service is not running');
      return;
    }

    clearInterval(this.intervalId);
    this.intervalId = null;
    this.isRunning = false;

    console.log('[DEBUG] Screenshot service stopped successfully');
  }

  // Update the screenshot interval
  public updateInterval(intervalMs: number): void {
    this.screenshotInterval = intervalMs;

    // Restart the service if it's running
    if (this.isRunning) {
      this.stop();
      this.start();
    }

    console.log(
      `[DEBUG] Screenshot interval updated to ${this.screenshotInterval} ms`,
    );
  }

  // Capture a screenshot and upload it to the server
  private async captureAndUpload(): Promise<void> {
    try {
      console.log('[DEBUG] Starting screenshot capture process');
      if (!this.token || !this.workspaceId) {
        console.log('[DEBUG] Cannot capture screenshot: not authenticated');
        return;
      }

      // Check if user is clocked in
      console.log('[DEBUG] Checking if user is clocked in');
      const isUserClockedIn = await activityService.isUserClockedIn();
      console.log(`[DEBUG] User clocked in status: ${isUserClockedIn}`);
      if (!isUserClockedIn) {
        console.log('[DEBUG] Skipping screenshot: user is not clocked in');
        return;
      }

      // Check if user is on break
      console.log('[DEBUG] Checking if user is on break');
      const isUserOnBreak = activityService.isUserOnBreak();
      console.log(`[DEBUG] User on break status: ${isUserOnBreak}`);
      if (isUserOnBreak) {
        console.log('[DEBUG] Skipping screenshot: user is on break');
        return;
      }

      // Take a screenshot. On Wayland this grabs a frame from the held
      // getDisplayMedia stream; elsewhere it goes through desktopCapturer.
      console.log('[DEBUG] Calling capture path to take screenshot');
      const screenshotPath = this.useDisplayMedia
        ? await this.captureViaDisplayMedia()
        : await window.electron.system.takeScreenshot();
      console.log(`[DEBUG] Screenshot path received: ${screenshotPath}`);

      if (!screenshotPath) {
        console.error('[DEBUG] Failed to capture screenshot - path is empty');
        return;
      }

      // Get current timestamp in the format expected by the API (ISO-8601 with
      // an explicit UTC offset, so the server need not infer a timezone)
      const timestamp = formatApiTimestamp();

      console.log(
        `[DEBUG] Generated timestamp with timezone ${whiteLabelConfig.timezone.default}: ${timestamp}`,
      );

      // Create a screenshot object
      const screenshot: Screenshot = {
        filePath: screenshotPath,
        timestamp,
        synced: false,
      };
      console.log(
        `[DEBUG] Created screenshot object: ${JSON.stringify(screenshot)}`,
      );

      // Save the screenshot to the database
      console.log('[DEBUG] Saving screenshot to database');
      const savedScreenshot = await databaseService.saveScreenshot(screenshot);
      console.log(
        `[DEBUG] Screenshot saved to database with ID: ${savedScreenshot.id}`,
      );

      // If online, upload the screenshot
      const isOnline = apiService.isOnline();
      console.log(`[DEBUG] Network status - Online: ${isOnline}`);

      if (isOnline) {
        console.log('[DEBUG] Attempting to upload screenshot');
        try {
          const response = await apiService.uploadScreenshot(
            this.token,
            this.workspaceId,
            screenshotPath,
            timestamp,
          );
          console.log(`[DEBUG] Upload response: ${JSON.stringify(response)}`);

          if (
            response &&
            response.error &&
            response.code === 'FORCE_CLOCKOUT'
          ) {
            console.warn(
              'Received FORCE_CLOCKOUT from server during screenshot upload',
            );
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            activityService.handleForceClockout('upload-screenshot');
            return;
          }

          if (!response.error) {
            // Delete the screenshot from the database
            console.log('[DEBUG] Upload successful, deleting from database');
            await databaseService.deleteScreenshot(savedScreenshot.id!);
            console.log(
              '[DEBUG] Screenshot uploaded successfully and deleted from database',
            );

            // Delete the local file from disk
            try {
              console.log(
                `[DEBUG] Deleting local file from disk: ${screenshotPath}`,
              );
              await window.electron.system.deleteFile(screenshotPath);
            } catch (deleteError) {
              console.error(
                '[DEBUG] Failed to delete local screenshot file:',
                deleteError,
              );
            }
          } else {
            console.error(
              `[DEBUG] Error uploading screenshot: ${response.message}`,
            );
          }
        } catch (uploadError) {
          console.error('[DEBUG] Exception during upload:', uploadError);
        }
      } else {
        console.log(
          '[DEBUG] Offline: Screenshot saved locally and will be uploaded when online',
        );
      }
    } catch (error) {
      console.error('[DEBUG] Error capturing and uploading screenshot:', error);
    }
  }

  /**
   * Ensure a live getDisplayMedia stream exists. The first call triggers the
   * portal's consent dialog once; the stream is then reused for every
   * subsequent capture so the user is not re-prompted each interval.
   */
  private async ensureCaptureStream(): Promise<boolean> {
    const existingTrack = this.captureStream?.getVideoTracks()[0];
    if (existingTrack && existingTrack.readyState === 'live') {
      return true;
    }

    // Any half-dead stream from a previous attempt is cleared before retrying.
    this.releaseCaptureStream();

    try {
      console.log('[DEBUG] Acquiring getDisplayMedia stream (Wayland)');
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 1, max: 5 },
        },
        audio: false,
      });

      const video = document.createElement('video');
      video.muted = true;
      video.srcObject = stream;
      await video.play();

      // Give the first frame a moment to arrive; videoWidth is 0 until then.
      if (video.videoWidth === 0) {
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          video.addEventListener('loadeddata', done, { once: true });
          setTimeout(done, 1000);
        });
      }

      this.captureStream = stream;
      this.captureVideo = video;

      // If the user stops sharing (or a monitor is unplugged), drop the stream
      // so the next capture re-acquires — which will re-prompt, unavoidably.
      const track = stream.getVideoTracks()[0];
      track.addEventListener('ended', () => {
        console.log('[DEBUG] getDisplayMedia track ended, releasing stream');
        this.releaseCaptureStream();
      });

      console.log(
        `[DEBUG] getDisplayMedia stream ready (${video.videoWidth}x${video.videoHeight})`,
      );
      return true;
    } catch (error) {
      console.error('[DEBUG] Failed to acquire getDisplayMedia stream:', error);
      this.releaseCaptureStream();
      return false;
    }
  }

  // Tear down the held stream and its video element.
  private releaseCaptureStream(): void {
    if (this.captureStream) {
      this.captureStream.getTracks().forEach((track) => track.stop());
      this.captureStream = null;
    }
    if (this.captureVideo) {
      this.captureVideo.srcObject = null;
      this.captureVideo = null;
    }
  }

  /**
   * Grab a single frame from the held stream, encode it as PNG, and write it to
   * disk via the main process. Returns the saved file path, or '' on failure.
   */
  private async captureViaDisplayMedia(): Promise<string> {
    const ready = await this.ensureCaptureStream();
    if (!ready || !this.captureVideo) {
      return '';
    }

    const video = this.captureVideo;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width === 0 || height === 0) {
      console.error('[DEBUG] Capture video has no dimensions yet');
      return '';
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      console.error('[DEBUG] Could not get 2D canvas context');
      return '';
    }
    ctx.drawImage(video, 0, 0, width, height);

    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1] || '';
    if (!base64) {
      console.error('[DEBUG] Canvas produced an empty PNG');
      return '';
    }

    const result = await window.electron.system.saveScreenshotBuffer(base64);
    if (result.error || !result.filePath) {
      console.error(
        `[DEBUG] Failed to save renderer screenshot: ${result.message}`,
      );
      return '';
    }
    return result.filePath;
  }
}

// Create and export a singleton instance
const screenshotService = new ScreenshotService();

export default screenshotService;
