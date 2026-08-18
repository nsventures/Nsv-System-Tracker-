/* global NodeJS */
import { LogUpdateRequest } from '../types';
import * as apiService from './api';
import * as databaseService from './database';
// eslint-disable-next-line import/no-cycle
import screenshotService from './screenshot';
import { whiteLabelConfig } from '../../whiteLabel.config';
import { formatApiTimestamp } from '../utils/timeUtils';
import { deriveClockState } from '../utils/clockState';

// Activity types
export type ActivityAction =
  | 'clock-in'
  | 'clock-out'
  | 'idle-start'
  | 'idle-stop'
  | 'break-start'
  | 'break-stop'
  | 'manual-processing-start'
  | 'manual-processing-stop';

// Class to manage activity tracking
class ActivityService {
  private userId: number | null = null;

  private workspaceId: number | null = null;

  private token: string | null = null;

  // Legacy one-shot idle timeout (renderer events based) — replaced by system idle polling
  private idleTimeout: NodeJS.Timeout | null = null;

  private idlePollInterval: NodeJS.Timeout | null = null;

  private configReloadInterval: NodeJS.Timeout | null = null;

  private idlePollFrequency: number = 5000; // poll every 5s

  // Must match the admin default (5 minutes). The previous 1-minute fallback
  // is why short 00:01 / 00:02 idle bars appeared whenever load-config failed
  // or had not been applied yet — the poller ran on the 1-minute default.
  private idleThreshold: number = 300000;

  // Once idle, require real input (OS idle near zero) before leaving idle.
  // Exiting as soon as idleTime < threshold caused 1–2 minute leftover bars
  // after every 5-minute wait.
  private static readonly IDLE_RESUME_MS = 5000;

  private breakThreshold: number = 300000; // Default 5 minutes

  private maxDailyBreakTime: number = 3600000; // Default 1 hour

  private isIdle: boolean = false;

  private isOnBreak: boolean = false;

  private isOnManualTime: boolean = false;

  private lastActivityTime: number = Date.now();

  private lastSessionActiveWriteAt: number = 0; // throttle for the session heartbeat

  private totalBreakTime: number = 0;

  private breakStartTime: number | null = null;

  private breakWarningTimeout: NodeJS.Timeout | null = null;

  private breakEndTimeout: NodeJS.Timeout | null = null;

  private nextAutoBreakEligibleAt: number = 0; // Prevent immediate re-auto-start after manual stop

  private lastClockInAt: number = 0; // Epoch ms of the most recent clock-in, for the grace window below

  // A user cannot legitimately be force-clocked-out seconds after clocking in.
  // A FORCE_CLOCKOUT arriving inside this window means the server could not see
  // the clock-in that just succeeded, so it is ignored as a server-side fault
  // rather than acted on. A genuine admin clock-out that lands in the window is
  // still caught on the next screenshot cycle, so nothing is permanently missed.
  private static readonly FORCE_CLOCKOUT_GRACE_MS = 90000; // 90s

  // Initialize the service with user data
  public async initialize(userId: number, workspaceId: number, token: string) {
    this.userId = userId;
    this.workspaceId = workspaceId;
    this.token = token;

    // Load configuration
    await this.loadConfig();
    this.startConfigReload();

    // Load persisted break time from config
    await this.loadPersistedBreakTime();

    // Restore break/idle state from database logs before polling starts
    await this.restoreBreakState();
    await this.restoreIdleState();

    // Start idle detection
    this.startIdleDetection();

    // Check for mismatch between session.json and IndexedDB (self-healing clock-out on startup)
    if (typeof window !== 'undefined' && window.electron) {
      try {
        const session = await window.electron.system.getSession();
        const clockedInDb = await this.isUserClockedIn();

        if (session && session.isClockedIn === false && clockedInDb) {
          console.log(
            '[DEBUG] Mismatch detected: session.json says clocked out, but DB says clocked in. Performing self-healing local clock-out...',
          );
          const lastActiveTime =
            session.lastActiveTime ||
            window.electron.system.getCurrentTimestamp();
          const clockOutAt = new Date(lastActiveTime.replace(/\s/, 'T'));

          await this.closeOpenActivitiesBeforeClockOut(clockOutAt);

          const clockOutLog = {
            user_id: this.userId!,
            action: 'clock-out' as const,
            timestamp: lastActiveTime,
            synced: false,
          };

          await databaseService.saveActivityLog(clockOutLog);
          console.log(
            '[DEBUG] Self-healing complete. Local database has been clocked out.',
          );
        }
      } catch (err) {
        console.error('[DEBUG] Error during self-healing check:', err);
      }
    }

    // Add event listeners for user activity
    window.addEventListener('mousemove', this.handleUserActivity);
    window.addEventListener('keydown', this.handleUserActivity);
    window.addEventListener('click', this.handleUserActivity);

    const clockedIn = await this.isUserClockedIn();
    this.updateSessionFile(clockedIn);
    if (clockedIn && this.userId) {
      try {
        const logs = await databaseService.getActivityLogs();
        const { clockInTime } = deriveClockState(logs, this.userId);
        if (clockInTime) this.lastClockInAt = clockInTime.getTime();
      } catch (error) {
        console.error('Error restoring lastClockInAt:', error);
      }
    }
  }

  // Load persisted break time from config
  private async loadPersistedBreakTime() {
    try {
      const today = new Date().toISOString().split('T')[0];
      const calculatedBreakTime = await this.calculateTotalBreakTimeFromLogs();
      console.log(
        `[DEBUG] Calculated break time from logs for today: ${calculatedBreakTime}ms`,
      );

      const config = await databaseService.getConfig();
      if (config) {
        // Try user-specific break times first
        const userBreak = config.userBreakTimes?.[this.userId!];
        if (userBreak) {
          if (userBreak.lastBreakResetDate === today) {
            const persistedTime = userBreak.totalBreakTime || 0;
            this.totalBreakTime = Math.max(persistedTime, calculatedBreakTime);
            console.log(
              `[DEBUG] Loaded merged break time for today from userBreakTimes: ${this.totalBreakTime}ms`,
            );
          } else {
            console.log(
              `[DEBUG] New day detected for user (${today} vs ${userBreak.lastBreakResetDate}). Resetting break time.`,
            );
            this.totalBreakTime = 0;
            await this.saveBreakTime();
          }
        } else if (config.lastBreakResetDate === today) {
          // Fallback to legacy config
          const persistedTime = config.totalBreakTime || 0;
          this.totalBreakTime = Math.max(persistedTime, calculatedBreakTime);
          console.log(
            `[DEBUG] Loaded merged break time for today from legacy config: ${this.totalBreakTime}ms`,
          );
          // Migrate to userBreakTimes
          await this.saveBreakTime();
        } else {
          console.log(
            `[DEBUG] New day detected (${today} vs ${config.lastBreakResetDate}). Resetting break time.`,
          );
          this.totalBreakTime = 0;
          await this.saveBreakTime();
        }
      } else {
        this.totalBreakTime = calculatedBreakTime;
        await this.saveBreakTime();
      }
    } catch (error) {
      console.error('Error loading persisted break time:', error);
    }
  }

  // Calculate total break time today from the local database logs
  public async calculateTotalBreakTimeFromLogs(): Promise<number> {
    if (!this.userId) return 0;
    try {
      const logs = await databaseService.getActivityLogs();
      const todayDateString = new Date().toDateString();

      // Filter for break logs of this user
      const userBreakLogs = logs.filter(
        (log) =>
          (log.action === 'break-start' || log.action === 'break-stop') &&
          log.user_id === this.userId,
      );

      // Sort chronologically
      const sortedLogs = userBreakLogs.sort(
        (a, b) =>
          new Date(a.timestamp.replace(/\s/, 'T')).getTime() -
          new Date(b.timestamp.replace(/\s/, 'T')).getTime(),
      );

      let totalBreakMs = 0;
      for (let i = 0; i < sortedLogs.length; i += 1) {
        const log = sortedLogs[i];
        const logTime = new Date(log.timestamp.replace(/\s/, 'T'));

        if (logTime.toDateString() === todayDateString) {
          if (log.action === 'break-start') {
            if (i + 1 < sortedLogs.length) {
              const nextLog = sortedLogs[i + 1];
              if (nextLog.action === 'break-stop') {
                const stopTime = new Date(nextLog.timestamp.replace(/\s/, 'T'));
                totalBreakMs += stopTime.getTime() - logTime.getTime();
                i += 1; // Skip the break-stop log
              }
            }
          }
        }
      }
      return totalBreakMs;
    } catch (error) {
      console.error('Error calculating break time from logs:', error);
      return 0;
    }
  }

  // Recalculate break time after synchronization
  public async recalculateBreakTime() {
    console.log('[DEBUG] Recalculating break time from logs after sync...');
    const calculatedBreakTime = await this.calculateTotalBreakTimeFromLogs();
    this.totalBreakTime = Math.max(this.totalBreakTime, calculatedBreakTime);
    await this.saveBreakTime();
    console.log(
      `[DEBUG] Break time recalculated and saved: ${this.totalBreakTime}ms`,
    );
  }

  // Restore break state from logs on startup
  private async restoreBreakState() {
    if (!this.userId) return;
    try {
      const logs = await databaseService.getActivityLogs();
      const userBreakLogs = logs
        .filter(
          (log) =>
            (log.action === 'break-start' || log.action === 'break-stop') &&
            log.user_id === this.userId,
        )
        .sort(
          (a, b) =>
            new Date(b.timestamp.replace(/\s/, 'T')).getTime() -
            new Date(a.timestamp.replace(/\s/, 'T')).getTime(),
        );

      if (userBreakLogs.length > 0) {
        const lastLog = userBreakLogs[0];
        const lastLogTime = new Date(lastLog.timestamp.replace(/\s/, 'T'));
        const today = new Date().toDateString();

        if (
          lastLog.action === 'break-start' &&
          lastLogTime.toDateString() === today
        ) {
          console.log(
            '[DEBUG] Restoring active break state from last log on startup',
          );
          this.isOnBreak = true;
          this.breakStartTime = lastLogTime.getTime();
          this.scheduleBreakLimitTimers();
        } else {
          this.isOnBreak = false;
          this.breakStartTime = null;
        }
      }
    } catch (error) {
      console.error('Error restoring break state on startup:', error);
    }
  }

  private parseLogTimestamp(timestamp: string): Date {
    return new Date(timestamp.replace(/\s/, 'T'));
  }

  private async getTodayIdleLogs() {
    if (!this.userId) return [];
    const today = new Date().toDateString();
    const logs = await databaseService.getActivityLogs();
    return logs
      .filter(
        (log) =>
          log.user_id === this.userId &&
          (log.action === 'idle-start' || log.action === 'idle-stop') &&
          this.parseLogTimestamp(log.timestamp).toDateString() === today,
      )
      .sort(
        (a, b) =>
          this.parseLogTimestamp(a.timestamp).getTime() -
          this.parseLogTimestamp(b.timestamp).getTime(),
      );
  }

  private async getTodayBreakLogs() {
    if (!this.userId) return [];
    const today = new Date().toDateString();
    const logs = await databaseService.getActivityLogs();
    return logs
      .filter(
        (log) =>
          log.user_id === this.userId &&
          (log.action === 'break-start' || log.action === 'break-stop') &&
          this.parseLogTimestamp(log.timestamp).toDateString() === today,
      )
      .sort(
        (a, b) =>
          this.parseLogTimestamp(a.timestamp).getTime() -
          this.parseLogTimestamp(b.timestamp).getTime(),
      );
  }

  private hasMatchingStopAfter(
    logs: { action: string }[],
    startIndex: number,
    stopAction: 'idle-stop' | 'break-stop',
  ): boolean {
    for (let i = startIndex + 1; i < logs.length; i += 1) {
      if (logs[i].action === stopAction) return true;
      if (
        logs[i].action === 'idle-start' ||
        logs[i].action === 'break-start'
      ) {
        return false;
      }
    }
    return false;
  }

  private async getSystemIdleMs(): Promise<number> {
    try {
      const idleTimeSec = await (window as any).electron.system.getIdleTime();
      return Number.isFinite(idleTimeSec)
        ? Math.max(0, idleTimeSec * 1000)
        : 0;
    } catch {
      return 0;
    }
  }

  /** Close an idle-start in logs that never received idle-stop (server orphan). */
  private async closeOrphanedIdleFromLogs(
    reason: string,
    at: Date = new Date(),
  ): Promise<boolean> {
    const idleLogs = await this.getTodayIdleLogs();
    for (let i = idleLogs.length - 1; i >= 0; i -= 1) {
      if (idleLogs[i].action !== 'idle-start') continue;
      if (this.hasMatchingStopAfter(idleLogs, i, 'idle-stop')) return false;

      console.log(`[idle] Closing orphaned idle-start (reason=${reason})`);
      this.isIdle = false;
      await this.logActivity('idle-stop', at);
      return true;
    }
    return false;
  }

  /** Close a break-start in logs that never received break-stop (server orphan). */
  private async closeOrphanedBreakFromLogs(
    reason: string,
    at: Date = new Date(),
  ): Promise<boolean> {
    const breakLogs = await this.getTodayBreakLogs();
    for (let i = breakLogs.length - 1; i >= 0; i -= 1) {
      if (breakLogs[i].action !== 'break-start') continue;
      if (this.hasMatchingStopAfter(breakLogs, i, 'break-stop')) return false;

      console.log(`[break] Closing orphaned break-start (reason=${reason})`);
      this.clearBreakTimers();
      await this.logActivity('break-stop', at);
      await this.recalculateBreakTime();
      this.isOnBreak = false;
      this.breakStartTime = null;
      return true;
    }
    return false;
  }

  /** Always close idle/break (memory + log orphans) before clock-out. */
  private async closeOpenActivitiesBeforeClockOut(
    at: Date = new Date(),
  ): Promise<void> {
    if (this.isIdle) {
      this.isIdle = false;
      await this.logActivity('idle-stop', at);
    } else {
      await this.closeOrphanedIdleFromLogs('clock-out', at);
    }

    if (this.isOnBreak) {
      await this.stopBreak(at);
    } else {
      await this.closeOrphanedBreakFromLogs('clock-out', at);
    }
  }

  /** On startup: reconcile in-memory idle with the last idle log row. */
  private async restoreIdleState() {
    if (!this.userId) return;
    try {
      const idleLogs = await this.getTodayIdleLogs();
      if (idleLogs.length === 0) {
        this.isIdle = false;
        return;
      }

      const last = idleLogs[idleLogs.length - 1];
      if (last.action !== 'idle-start') {
        this.isIdle = false;
        return;
      }

      const osIdleMs = await this.getSystemIdleMs();
      if (osIdleMs < ActivityService.IDLE_RESUME_MS) {
        console.log(
          '[idle] Startup: open idle-start but user is active — closing',
        );
        this.isIdle = false;
        await this.logActivity('idle-stop');
      } else {
        console.log('[idle] Startup: restoring in-memory idle state');
        this.isIdle = true;
      }
    } catch (error) {
      console.error('Error restoring idle state on startup:', error);
    }
  }

  /** After sleep/wake: close idle that was opened on suspend if the user is back. */
  public async markAsIdleAfterResume() {
    try {
      const clockedIn = await this.isUserClockedIn();
      if (!clockedIn || this.isOnBreak) return;

      const osIdleMs = await this.getSystemIdleMs();
      if (osIdleMs >= ActivityService.IDLE_RESUME_MS) {
        return;
      }

      if (this.isIdle) {
        this.isIdle = false;
        await this.logActivity('idle-stop');
        return;
      }

      await this.closeOrphanedIdleFromLogs('system-resume');
    } catch (error) {
      console.error('Error handling system resume:', error);
    }
  }

  // Save break time to config
  private async saveBreakTime() {
    try {
      // Never seed a missing config row with a live in-memory threshold that
      // might still be a pre-config-load value — always persist the 5-minute
      // product default (or whatever already came from /load-config).
      const config = (await databaseService.getConfig()) || {
        screenshotInterval: 300000,
        idleTimeThreshold: 300000,
        breakTimeThreshold: this.breakThreshold,
        maxDailyBreakTime: this.maxDailyBreakTime,
        manualTimeApprover: [],
      };
      if (
        !config.idleTimeThreshold ||
        config.idleTimeThreshold === 60000
      ) {
        config.idleTimeThreshold = this.idleThreshold || 300000;
      }

      const today = new Date().toISOString().split('T')[0];
      if (!config.userBreakTimes) {
        config.userBreakTimes = {};
      }
      config.userBreakTimes[this.userId!] = {
        totalBreakTime: this.totalBreakTime,
        lastBreakResetDate: today,
      };

      // Keep legacy fields updated for backward compatibility
      config.totalBreakTime = this.totalBreakTime;
      config.lastBreakResetDate = today;

      await databaseService.saveConfig(config);
      console.log(
        `[DEBUG] Saved break time to config for user ${this.userId}: ${this.totalBreakTime}ms (Date: ${today})`,
      );
    } catch (error) {
      console.error('Error saving break time to config:', error);
    }
  }

  // Admin stores milliseconds (seconds from the form × 1000). Guard against
  // a raw-seconds value leaking through, a missing/zero value, and the
  // legacy 1-minute value that older builds wrote into IndexedDB.
  private applyIdleThreshold(
    raw: unknown,
    source: 'server' | 'local' | 'default' = 'default',
  ) {
    const FALLBACK_MS = 300000; // 5 minutes — never fall back to 1 minute
    const LEGACY_DEFAULT_MS = 60000;
    const MAX_MS = 2 * 60 * 60 * 1000; // 2 hours

    const n = Number(raw);
    let ms = Number.isFinite(n) && n > 0 ? n : FALLBACK_MS;

    // Server/form sometimes sends seconds (e.g. 300) instead of ms.
    if (ms < 60000) {
      ms *= 1000;
    }

    // Older builds defaulted to 60s and cached it locally. Treat that local
    // value as poison — keep the 5-minute floor until the server explicitly
    // sends a threshold (including a deliberate 1-minute admin setting).
    if (source === 'local' && ms === LEGACY_DEFAULT_MS) {
      console.warn(
        '[idle] Ignoring legacy local idleTimeThreshold=60000; using 5-minute default until server config applies',
      );
      ms = FALLBACK_MS;
    }

    if (ms > MAX_MS) {
      ms = FALLBACK_MS;
    }

    this.idleThreshold = ms;
    console.log(
      `[idle] threshold set to ${this.idleThreshold}ms (source=${source})`,
    );
  }

  private startConfigReload() {
    if (this.configReloadInterval) {
      clearInterval(this.configReloadInterval);
    }
    this.configReloadInterval = setInterval(() => {
      this.loadConfig().catch((error) => {
        console.error('Periodic config reload failed:', error);
      });
    }, 15 * 60 * 1000);
  }

  // Load configuration from the server or local storage
  private async loadConfig() {
    try {
      const local = await databaseService.getConfig();
      if (local?.idleTimeThreshold) {
        this.applyIdleThreshold(local.idleTimeThreshold, 'local');
      }
    } catch (error) {
      console.error('Error reading local config:', error);
    }

    if (!this.token || !this.workspaceId) {
      console.error('Cannot load config: missing token or workspace ID');
      return;
    }

    try {
      const response = await apiService.loadConfig(
        this.token,
        this.workspaceId,
      );

      if (!response.error && response.data) {
        this.applyIdleThreshold(response.data.idleTimeThreshold, 'server');
        this.breakThreshold = response.data.breakTimeThreshold;
        this.maxDailyBreakTime = response.data.maxDailyBreakTime || 3600000;
        console.log(
          `Configuration loaded successfully (idle threshold ${this.idleThreshold}ms)`,
        );
      } else {
        console.error(
          `Failed to load configuration: ${response.message} — keeping idle threshold ${this.idleThreshold}ms`,
        );
      }
    } catch (error) {
      console.error(
        `Error loading configuration: ${error} — keeping idle threshold ${this.idleThreshold}ms`,
      );
    }
  }

  // Start idle detection (system idle polling)
  private startIdleDetection() {
    // Clear any existing timeout/interval
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }
    if (this.idlePollInterval) {
      clearInterval(this.idlePollInterval);
      this.idlePollInterval = null;
    }

    // Begin polling system idle time
    this.idlePollInterval = setInterval(async () => {
      try {
        const idleTimeSec = await (window as any).electron.system.getIdleTime();
        let idleTimeMs = Number.isFinite(idleTimeSec)
          ? Math.max(0, idleTimeSec * 1000)
          : 0;

        // Cross-check the OS idle timer against input the tracker window itself
        // saw. If in-app input is more recent than the OS claims, trust it —
        // getSystemIdleTime() over-reports idle on some platforms (Wayland),
        // and this never increases idle, only corrects a false-idle reading.
        const sinceRendererInput = Date.now() - this.lastActivityTime;
        if (Number.isFinite(sinceRendererInput) && sinceRendererInput >= 0) {
          idleTimeMs = Math.min(idleTimeMs, sinceRendererInput);
        }

        const clockedIn = await this.isUserClockedIn();

        // Heartbeat: while clocked in, record the last moment the machine saw
        // input into session.json, so a crash/sleep/shutdown clock-out is
        // stamped there instead of at reboot — which would over-count every
        // dead minute in between (see main.ts handleGracefulShutdown).
        if (clockedIn) {
          this.maybeWriteSessionActiveTime(Date.now() - idleTimeMs);
        }

        // Only track idle when clocked in and not on break
        if (!clockedIn || this.isOnBreak) {
          if (this.isIdle) {
            this.isIdle = false;
            await this.logActivity('idle-stop');
          }
          return;
        }

        // NOTE: the idle auto-clock-out was removed. It fired after 30 minutes
        // idle inside a window hardcoded to 8 PM–6 AM Asia/Kolkata, while the
        // app records time in each machine's own timezone. On any machine
        // outside India that window fell across the working day, so an ordinary
        // idle stretch (lunch, a meeting) silently clocked the user out — and
        // getSystemIdleTime() over-reports idle on some platforms (Wayland),
        // tripping it even while the user was active. Idle is now only logged,
        // never acted on; users clock out themselves or an admin force-clocks.
        if (!this.isIdle && idleTimeMs >= this.idleThreshold) {
          this.isIdle = true;
          // Stamp idle-start at the beginning of this inactivity stretch, not
          // "now". Logging "now" left the threshold wait as Active and then a
          // 1–2 minute Idle leftover when the user returned — which looked
          // like idle firing after 1 minute.
          const startedAt = Math.max(
            Date.now() - idleTimeMs,
            this.lastClockInAt || 0,
          );
          console.log(
            `[idle] idle-start (threshold=${this.idleThreshold}ms, osIdle=${Math.round(idleTimeMs / 1000)}s)`,
          );
          await this.logActivity('idle-start', new Date(startedAt));
        } else if (this.isIdle && idleTimeMs < ActivityService.IDLE_RESUME_MS) {
          this.isIdle = false;
          await this.logActivity('idle-stop');
        }
      } catch (e) {
        console.error('Idle polling error:', e);
      }
    }, this.idlePollFrequency);
  }

  // Mark the user as idle immediately before system goes to sleep
  public async markAsIdleBeforeSleep() {
    try {
      const clockedIn = await this.isUserClockedIn();
      if (clockedIn && !this.isOnBreak && !this.isIdle) {
        console.log('[DEBUG] System going to sleep. Marking user as idle.');
        this.isIdle = true;
        await this.logActivity('idle-start');
      }
    } catch (error) {
      console.error('Error marking as idle before sleep:', error);
    }
  }

  // Handle user activity inside the tracker window.
  // Only refresh lastActivityTime — do NOT emit idle-stop here. Exiting idle
  // through this path skipped the IDLE_RESUME_MS hysteresis and produced the
  // 3–4s yellow bars. The poller exits idle when OS (or renderer) idle drops
  // under IDLE_RESUME_MS, using this timestamp via Math.min above.
  private handleUserActivity = () => {
    this.lastActivityTime = Date.now();
  };

  // Start a break only if currently clocked in
  private async startBreakIfClockedIn() {
    try {
      const clockedIn = await this.isUserClockedIn();
      if (clockedIn && !this.isOnBreak) {
        await this.startBreak();
      }
    } catch (error) {
      console.error(
        'Error checking clock-in state before starting break:',
        error,
      );
    }
  }

  // Check if notifications are supported and request permission if needed
  // eslint-disable-next-line class-methods-use-this
  private checkNotificationPermission(): boolean {
    if (!('Notification' in window)) {
      console.log('This browser does not support desktop notification');
      return false;
    }

    if (Notification.permission === 'granted') {
      return true;
    }

    if (Notification.permission !== 'denied') {
      Notification.requestPermission()
        .then((permission) => {
          return permission === 'granted';
        })
        .catch((error) => {
          console.error('Error requesting notification permission:', error);
          return false;
        });
    }

    return false;
  }

  // Show a notification
  private showNotification(title: string, body: string): void {
    if (this.checkNotificationPermission()) {
      // eslint-disable-next-line no-new
      new Notification(title, {
        body,
        icon: '/assets/icon.png',
      });
    }
  }

  // Start a break
  private async startBreak() {
    if (this.isOnBreak) return;

    this.isOnBreak = true;
    this.breakStartTime = Date.now();
    await this.logActivity('break-start');
    this.scheduleBreakLimitTimers();
  }

  private clearBreakTimers() {
    if (this.breakWarningTimeout) {
      clearTimeout(this.breakWarningTimeout);
      this.breakWarningTimeout = null;
    }
    if (this.breakEndTimeout) {
      clearTimeout(this.breakEndTimeout);
      this.breakEndTimeout = null;
    }
  }

  /** Re-arm or enforce the daily break cap (startup restore + new break). */
  private scheduleBreakLimitTimers() {
    if (!this.isOnBreak || !this.breakStartTime) return;

    this.clearBreakTimers();

    const elapsed = Date.now() - this.breakStartTime;
    const remainingBreakTime =
      this.maxDailyBreakTime - this.totalBreakTime - elapsed;

    if (remainingBreakTime <= 0) {
      this.showNotification(
        'Break Ended',
        'Your break has ended automatically because you have used all your daily break time.',
      );
      void this.stopBreak();
      return;
    }

    if (remainingBreakTime > 30000) {
      this.breakWarningTimeout = setTimeout(() => {
        if (this.isOnBreak) {
          this.showNotification(
            'Break Ending Soon',
            'Your break will end automatically in 30 seconds due to daily break time limit.',
          );
        }
      }, remainingBreakTime - 30000);
    }

    this.breakEndTimeout = setTimeout(() => {
      if (this.isOnBreak) {
        this.showNotification(
          'Break Ended',
          'Your break has ended automatically because you reached your daily break time limit.',
        );
        void this.stopBreak();
      }
    }, remainingBreakTime);
  }

  // Stop a break
  private async stopBreak(at: Date = new Date()) {
    if (!this.isOnBreak || !this.breakStartTime) return;

    this.clearBreakTimers();

    const breakDuration = Math.max(0, at.getTime() - this.breakStartTime);
    this.totalBreakTime += breakDuration;
    this.isOnBreak = false;
    this.breakStartTime = null;

    // Add cooldown to avoid immediate auto break re-start while the user is still idle
    this.nextAutoBreakEligibleAt = Date.now() + 60000; // 60s cooldown

    // Reset idle tracking reference point and restart detection so the next idle window
    // counts from now rather than the original pre-break idle time
    this.lastActivityTime = Date.now();
    this.startIdleDetection();

    // Save updated break time to config
    await this.saveBreakTime();

    await this.logActivity('break-stop', at);

    // Dispatch event to notify UI that break ended
    window.dispatchEvent(new CustomEvent('break-ended'));
  }

  public async logActivity(action: ActivityAction, at: Date = new Date()) {
    if (!this.userId) {
      console.error('Cannot log activity: missing user ID');
      return;
    }

    const timestamp = formatApiTimestamp(at);

    const logData: LogUpdateRequest = {
      user_id: this.userId,
      action,
      timestamp,
      reason: 'default', // Optional reason for manual processing
    };

    try {
      if (this.token && this.workspaceId) {
        const response = await apiService.logUpdate(
          this.token,
          this.workspaceId,
          logData,
        );
        if (response && response.error && response.code === 'FORCE_CLOCKOUT') {
          console.warn('Received FORCE_CLOCKOUT from server during logUpdate');
          await this.handleForceClockout(`log-update:${action}`);
          return;
        }
      } else {
        await databaseService.saveActivityLog({
          ...logData,
          synced: false,
        });
      }
      console.log(`Activity logged: ${action}`);
    } catch (error) {
      console.error('Error logging activity:', error);
    }
  }

  // Clock in
  public async clockIn() {
    if (this.isOnBreak) {
      await this.stopBreak();
    }
    this.lastClockInAt = Date.now();
    await this.logActivity('clock-in');
    this.updateSessionFile(true);

    // Restart the screenshot service
    console.log('[DEBUG] Restarting screenshot service after clock-in');
    await screenshotService.initialize();
    screenshotService.start();
  }

  // Clock out
  public async clockOut() {
    await this.closeOpenActivitiesBeforeClockOut();

    // Removed resetDailyBreakTime() call to persist break time across clock-ins on the same day

    await this.logActivity('clock-out');
    this.updateSessionFile(false);

    // Stop the screenshot service
    console.log('[DEBUG] Stopping screenshot service after clock-out');
    screenshotService.stop();
  }

  // Manually start a break
  public async startBreakManually() {
    if (this.isOnBreak) return;

    // Ensure user is clocked in before starting a break
    const clockedIn = await this.isUserClockedIn();
    if (!clockedIn) {
      this.showNotification(
        'Cannot Start Break',
        'You must clock in before starting a break.',
      );
      return;
    }

    if (this.isIdle) {
      await this.logActivity('idle-stop');
      this.isIdle = false;
    }
    await this.startBreak();
  }

  // Manually stop a break
  public async stopBreakManually() {
    if (!this.isOnBreak) return;
    await this.stopBreak();
  }

  // Manually start manual time tracking
  public async startManualTime() {
    // DIAGNOSTIC: nothing in this codebase should call startManualTime except
    // the dashboard button. Log the call stack so that if manual time appears
    // to start on its own, the captured logs show exactly what invoked it.
    console.log(
      `[DIAG] startManualTime called. Stack:\n${new Error().stack || '(no stack)'}`,
    );

    // Guard against a duplicate start: a second manual-processing-start with no
    // stop in between would open a second overlapping manual window and corrupt
    // the manual-time total. Ignore it if one is already running.
    if (this.isOnManualTime) {
      console.warn(
        '[DEBUG] startManualTime ignored: manual time is already running',
      );
      return;
    }

    // Ensure user is clocked in before starting manual time
    const clockedIn = await this.isUserClockedIn();
    if (!clockedIn) {
      this.showNotification(
        'Cannot Start Manual Time',
        'You must clock in before starting manual time.',
      );
      return;
    }

    // If user is on break, stop the break first
    if (this.isOnBreak) {
      await this.stopBreakManually();
    }

    // If user is idle, stop idle first
    if (this.isIdle) {
      await this.logActivity('idle-stop');
      this.isIdle = false;
    }

    // Log manual time start
    this.isOnManualTime = true;
    await this.logActivity('manual-processing-start');
  }

  // Manually stop manual time tracking with reason
  public async stopManualTime(reason: string) {
    this.isOnManualTime = false;
    const timestamp = formatApiTimestamp();

    const logData: LogUpdateRequest = {
      user_id: this.userId!,
      action: 'manual-processing-stop',
      timestamp,
      reason,
    };

    try {
      if (this.token && this.workspaceId) {
        await apiService.logUpdate(this.token, this.workspaceId, logData);
      } else {
        // If not authenticated, just save locally
        await databaseService.saveActivityLog({
          ...logData,
          synced: false,
        });
      }
      console.log(`Manual time stopped with reason: ${reason}`);
    } catch (error) {
      console.error('Error stopping manual time:', error);
    }
  }

  // Reset daily break time
  public async resetDailyBreakTime() {
    this.totalBreakTime = 0;

    // Save updated break time to config
    await this.saveBreakTime();
  }

  // Get total break time used
  public getTotalBreakTime(): number {
    return this.totalBreakTime;
  }

  // Get remaining break time
  public getRemainingBreakTime(): number {
    return Math.max(0, this.maxDailyBreakTime - this.totalBreakTime);
  }

  // Get max daily break time
  public getMaxDailyBreakTime(): number {
    return this.maxDailyBreakTime;
  }

  // Get current break duration (if on break)
  public getCurrentBreakDuration(): number {
    if (!this.isOnBreak || !this.breakStartTime) {
      return 0;
    }
    return Date.now() - this.breakStartTime;
  }

  // Check if user is on break
  public isUserOnBreak(): boolean {
    return this.isOnBreak;
  }

  // Check if user is clocked in
  public async isUserClockedIn(): Promise<boolean> {
    if (!this.userId) {
      console.log('[DEBUG] isUserClockedIn: No userId available');
      return false;
    }

    try {
      // Derived by the shared helper so the service and the dashboard hook can
      // never disagree about clock state. See utils/clockState.ts.
      const logs = await databaseService.getActivityLogs();
      const { isClockedIn } = deriveClockState(logs, this.userId);
      console.log(
        `[DEBUG] isUserClockedIn: user ${this.userId} is ${
          isClockedIn ? 'clocked in' : 'not clocked in'
        }`,
      );
      return isClockedIn;
    } catch (error) {
      console.error('[DEBUG] Error checking if user is clocked in:', error);
      return false;
    }
  }

  // Handle a force clockout triggered by the server
  public async handleForceClockout(source: string = 'unknown') {
    console.log(
      `[DEBUG] Executing local handleForceClockout (source: ${source})`,
    );

    // Grace window: reject a force-clockout that lands immediately after our
    // own clock-in. That combination is self-contradictory and indicates the
    // server failed to see the clock-in, not that the user was really kicked.
    const sinceClockIn = Date.now() - this.lastClockInAt;
    if (
      this.lastClockInAt > 0 &&
      sinceClockIn < ActivityService.FORCE_CLOCKOUT_GRACE_MS
    ) {
      console.error(
        `[DEBUG] IGNORING FORCE_CLOCKOUT (source: ${source}) — arrived ${Math.round(
          sinceClockIn / 1000,
        )}s after a successful clock-in. The server cannot see our clock-in; ` +
          `this is a server-side fault, not a real clock-out.`,
      );
      return;
    }

    // Idempotency guard. The server keeps returning FORCE_CLOCKOUT for as long
    // as the user is clocked out server-side, so this can be invoked once per
    // sync cycle for the same underlying state. Without this, every cycle would
    // append another clock-out row and re-notify the user indefinitely.
    if (!(await this.isUserClockedIn())) {
      console.log(
        `[DEBUG] handleForceClockout (source: ${source}) skipped: already clocked out locally`,
      );
      // Still make sure tracking is actually stopped before returning.
      screenshotService.stop();
      return;
    }

    // Dump the local clock state that was in effect when the server rejected
    // us. A FORCE_CLOCKOUT arriving moments after our own clock-in means the
    // server could not see that clock-in — compare these timestamps against
    // the server's stored rows to find the mismatch.
    try {
      const recent = (await databaseService.getActivityLogs())
        .filter(
          (log) =>
            log.user_id === this.userId &&
            (log.action === 'clock-in' || log.action === 'clock-out'),
        )
        .slice(-5);
      console.warn(
        `[DEBUG] FORCE_CLOCKOUT received (source: ${source}). Last local clock events:`,
        recent.map((l) => `${l.action}@${l.timestamp} synced=${l.synced}`),
      );
    } catch (dumpError) {
      console.error('[DEBUG] Could not dump clock state:', dumpError);
    }

    // 1. Stop screenshots
    console.log('[DEBUG] Stopping screenshot service');
    screenshotService.stop();

    // 2. Clear timers and intervals (state flags cleared by closeOpenActivities)
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }
    if (this.idlePollInterval) {
      clearInterval(this.idlePollInterval);
      this.idlePollInterval = null;
    }

    // 3. Close idle/break on the server, then clock out locally
    await this.closeOpenActivitiesBeforeClockOut();

    const clockOutLog = {
      user_id: this.userId!,
      action: 'clock-out' as const,
      timestamp: formatApiTimestamp(),
      reason: 'Forcefully clocked out by administrator',
    };

    // Save to local database marked as synced
    await databaseService.saveActivityLog({
      ...clockOutLog,
      synced: true,
    });

    // 4. Show user notification
    this.showNotification(
      'Force Clockout',
      'You have been forcefully clocked out by an administrator.',
    );

    // 6. Dispatch event to notify UI/DashboardPage
    window.dispatchEvent(new CustomEvent('force-clockout'));
    this.updateSessionFile(false);
  }

  private updateSessionFile(isClockedIn: boolean) {
    if (typeof window !== 'undefined' && window.electron) {
      window.electron.ipcRenderer.sendMessage('save-session', {
        token: this.token,
        userId: this.userId,
        workspaceId: this.workspaceId,
        isClockedIn,
        serverUrl: whiteLabelConfig.app.apiBaseUrl,
        timezone: whiteLabelConfig.timezone.default,
      });
    }
  }

  /**
   * Heartbeat the last time the machine actually saw input into session.json,
   * throttled to once every 30s. The main process reads this on shutdown to
   * stamp an OS-quit clock-out at the real last-active moment rather than at
   * reboot time, and to self-heal a crashed session on next launch.
   */
  private maybeWriteSessionActiveTime(lastActiveEpochMs: number) {
    const now = Date.now();
    if (now - this.lastSessionActiveWriteAt < 30000) return;
    this.lastSessionActiveWriteAt = now;

    if (typeof window !== 'undefined' && window.electron) {
      const safeEpoch =
        Number.isFinite(lastActiveEpochMs) && lastActiveEpochMs <= now
          ? lastActiveEpochMs
          : now;
      window.electron.ipcRenderer.sendMessage('save-session', {
        lastActiveTime: formatApiTimestamp(new Date(safeEpoch)),
      });
    }
  }

  // Clean up
  public cleanup() {
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }
    if (this.idlePollInterval) {
      clearInterval(this.idlePollInterval);
      this.idlePollInterval = null;
    }
    if (this.configReloadInterval) {
      clearInterval(this.configReloadInterval);
      this.configReloadInterval = null;
    }
    if (this.breakWarningTimeout) {
      clearTimeout(this.breakWarningTimeout);
      this.breakWarningTimeout = null;
    }
    if (this.breakEndTimeout) {
      clearTimeout(this.breakEndTimeout);
      this.breakEndTimeout = null;
    }
    window.removeEventListener('mousemove', this.handleUserActivity);
    window.removeEventListener('keydown', this.handleUserActivity);
    window.removeEventListener('click', this.handleUserActivity);

    // Reset user state to prevent leakage between user sessions
    this.userId = null;
    this.workspaceId = null;
    this.token = null;
    this.isIdle = false;
    this.isOnBreak = false;
    this.isOnManualTime = false;
    this.totalBreakTime = 0;
    this.breakStartTime = null;
  }
}

// Create and export a singleton instance
const activityService = new ActivityService();

export default activityService;
