// Type definitions for the employee tracker app

// User type based on login API response
export interface User {
  user_id: number;
  workspace_id: number;
  email: string;
  password: string;
  my_locale: string;
  locale: string;
  device: string;
  role: string;
  role_id: number;
  guard: string;
  workspace_title: string;
  is_admin_or_has_all_data_access: boolean;
  is_leave_editor: boolean;
  is_admin_or_leave_editor: boolean;
  user_name: string;
}

// Auth type for storing authentication information
export interface Auth {
  token: string;
  user: User;
  isAuthenticated: boolean;
}

// Config type based on load-config API response
export interface Config {
  screenshotInterval: number;
  idleTimeThreshold: number;
  breakTimeThreshold: number;
  maxDailyBreakTime: number;
  manualTimeApprover: string[];
  totalBreakTime?: number; // Stores the total break time used (persisted between app restarts)
  lastBreakResetDate?: string; // Stores the ISO date string of the last break reset (YYYY-MM-DD)
  userBreakTimes?: Record<
    number,
    { totalBreakTime: number; lastBreakResetDate: string }
  >;
}

// Activity log type for tracking employee activities
export interface ActivityLog {
  id?: number; // Local ID for offline storage
  user_id: number;
  action:
    | 'clock-in'
    | 'clock-out'
    | 'idle-start'
    | 'idle-stop'
    | 'break-start'
    | 'break-stop'
    | 'manual-processing-start'
    | 'manual-processing-stop';
  timestamp: string;
  reason?: string; // Optional reason for manual-time actions; persisted so it survives offline sync
  synced: boolean; // Flag to track if the log has been synced with the server
  // Durable-queue bookkeeping (see api.ts sync + database.ts):
  attempts?: number; // how many sync attempts this event has had
  lastAttemptAt?: number; // epoch ms of the last attempt, for backoff
  deadLettered?: boolean; // gave up after MAX attempts; retired from the queue but kept for history
  syncError?: string; // last error seen, recorded when dead-lettered
}

// API response types
export interface ApiResponse<T> {
  error: boolean;
  message: string;
  data?: T;
  token?: string;
  code?: string;
  status?: number; // HTTP status, set on rejections so callers can tell terminal (4xx) from retryable (5xx/network)
}

// Login request type
export interface LoginRequest {
  email: string;
  password: string;
}

// Log update request type
export interface LogUpdateRequest {
  user_id: number;
  action: ActivityLog['action'];
  timestamp: string;
  reason?: string; // Optional reason field for manual-stop action
}

// Network status type
export interface NetworkStatus {
  isOnline: boolean;
  lastSyncTime?: string; // Optional timestamp of the last successful sync
}

// Screenshot type for storing and uploading screenshots
export interface Screenshot {
  id?: number; // Local ID for offline storage
  filePath: string; // Path to the screenshot file
  timestamp: string; // When the screenshot was taken
  synced: boolean; // Flag to track if the screenshot has been synced with the server
  // Durable-queue bookkeeping (see api.ts sync + database.ts):
  attempts?: number;
  lastAttemptAt?: number;
  deadLettered?: boolean;
  syncError?: string;
}
