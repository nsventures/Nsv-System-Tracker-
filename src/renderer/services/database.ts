// @ts-ignore
import { openDB, deleteDB, DBSchema, IDBPDatabase } from 'idb';
import { Config, ActivityLog, Auth, Screenshot } from '../types';

// Define the database schema
interface TaskifyTrackerDB extends DBSchema {
  auth: {
    key: string;
    value: Auth;
  };
  config: {
    key: string;
    value: Config;
  };
  activityLogs: {
    key: number;
    value: ActivityLog & { synced: number }; // Using number (0 or 1) instead of boolean
    indexes: { 'by-synced': number }; // Using number (0 or 1) instead of boolean
  };
  screenshots: {
    key: number;
    value: Screenshot & { synced: number }; // Using number (0 or 1) instead of boolean
    indexes: { 'by-synced': number }; // Using number (0 or 1) instead of boolean
  };
}

// Database name and version
const DB_NAME = 'taskify-tracker-db';
const DB_VERSION = 1;

// Initialize the database
async function initDB(): Promise<IDBPDatabase<TaskifyTrackerDB>> {
  try {
    console.log('Initializing database:', DB_NAME, 'version:', DB_VERSION);
    return await openDB<TaskifyTrackerDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        console.log('Upgrading database to version:', DB_VERSION);
        // Create stores if they don't exist
        if (!db.objectStoreNames.contains('auth')) {
          console.log('Creating auth store');
          db.createObjectStore('auth');
        }

        if (!db.objectStoreNames.contains('config')) {
          console.log('Creating config store');
          db.createObjectStore('config');
        }

        if (!db.objectStoreNames.contains('activityLogs')) {
          console.log('Creating activityLogs store');
          const activityLogsStore = db.createObjectStore('activityLogs', {
            keyPath: 'id',
            autoIncrement: true,
          });
          // Create an index for synced status to easily find unsynced logs
          // Make sure to specify unique: false to allow multiple entries with the same value
          activityLogsStore.createIndex('by-synced', 'synced', {
            unique: false,
          });
        }

        if (!db.objectStoreNames.contains('screenshots')) {
          console.log('Creating screenshots store');
          const screenshotsStore = db.createObjectStore('screenshots', {
            keyPath: 'id',
            autoIncrement: true,
          });
          // Create an index for synced status to easily find unsynced screenshots
          screenshotsStore.createIndex('by-synced', 'synced', {
            unique: false,
          });
        }
        console.log('Database upgrade completed successfully');
      },
    });
  } catch (error) {
    console.error('Failed to initialize database:', error);
    try {
      console.log('Attempting to delete existing database');
      await deleteDB(DB_NAME);
      console.log(
        'Database deleted successfully, will recreate on next access',
      );
    } catch (deleteError) {
      console.error('Failed to delete database:', deleteError);
    }

    throw new Error(
      `Failed to create database: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// Get database instance
let dbPromise: Promise<IDBPDatabase<TaskifyTrackerDB>> | null = null;
let initAttempts = 0;
const MAX_INIT_ATTEMPTS = 3;

async function getDB(): Promise<IDBPDatabase<TaskifyTrackerDB>> {
  if (dbPromise) {
    try {
      return await dbPromise;
    } catch (error) {
      console.error('Existing database promise failed:', error);
      dbPromise = null;
      initAttempts = 0;
    }
  }

  if (initAttempts >= MAX_INIT_ATTEMPTS) {
    console.warn(
      `Failed to initialize database after ${MAX_INIT_ATTEMPTS} attempts, resetting database`,
    );
    try {
      await deleteDB(DB_NAME);
      console.log('Database reset successful, attempting to initialize again');
      initAttempts = 0;
    } catch (resetError) {
      console.error('Failed to reset database:', resetError);
      throw new Error(
        `Unable to initialize or reset database after multiple attempts: ${
          resetError instanceof Error ? resetError.message : String(resetError)
        }`,
      );
    }
  }

  initAttempts += 1;
  console.log(
    `Database initialization attempt ${initAttempts}/${MAX_INIT_ATTEMPTS}`,
  );

  dbPromise = initDB();

  try {
    const db = await dbPromise;
    console.log('Database initialized successfully');
    initAttempts = 0;
    return db;
  } catch (error) {
    console.error(
      `Database initialization attempt ${initAttempts} failed:`,
      error,
    );
    dbPromise = null;
    throw error;
  }
}

// Auth operations
export async function saveAuth(auth: Auth): Promise<void> {
  const db = await getDB();
  await db.put('auth', auth, 'currentUser');
}

export async function getAuth(): Promise<Auth | undefined> {
  const db = await getDB();
  return db.get('auth', 'currentUser');
}

export async function clearAuth(): Promise<void> {
  const db = await getDB();
  await db.delete('auth', 'currentUser');
}

// Config operations
export async function saveConfig(config: Config): Promise<void> {
  const db = await getDB();
  await db.put('config', config, 'currentConfig');
}

export async function getConfig(): Promise<Config | undefined> {
  const db = await getDB();
  return db.get('config', 'currentConfig');
}

// Activity log operations
export async function saveActivityLog(log: ActivityLog): Promise<ActivityLog> {
  const db = await getDB();
  // Convert boolean synced value to number (0 for false, 1 for true)
  // This ensures compatibility with IndexedDB index keys
  const logToSave = {
    ...log,
    synced: log.synced ? 1 : 0,
  };
  // @ts-ignore
  const id = await db.add('activityLogs', logToSave);
  return { ...log, id: id as number };
}

export async function getActivityLogs(): Promise<ActivityLog[]> {
  const db = await getDB();
  const logs = await db.getAll('activityLogs');
  // Convert number-synced values back to boolean for the application
  return logs.map((log) => ({
    // @ts-ignore
    ...log,
    // @ts-ignore
    synced: log.synced === 1,
  }));
}

export async function getUnsyncedActivityLogs(): Promise<ActivityLog[]> {
  const db = await getDB();
  try {
    // Use 0 as the key for the index instead of boolean false
    // IndexedDB doesn't handle boolean values as well as index keys
    const logs = await db.getAllFromIndex('activityLogs', 'by-synced', 0);
    // Convert number-synced values back to boolean for the application

    return logs.map((log) => ({
      // @ts-ignore
      ...log,
      synced: false, // These are all unsynced logs (synced = 0)
    }));
  } catch (error) {
    console.error('Error getting unsynced logs:', error);
    // Fallback: get all logs and filter manually if the index query fails
    const allLogs = await db.getAll('activityLogs');
    // Convert number-synced values back to boolean and filter
    return allLogs
      .map((log) => ({
        // @ts-ignore
        ...log,
        // @ts-ignore
        synced: log.synced === 1,
      }))
      .filter((log) => log.synced === false);
  }
}

export async function markActivityLogAsSynced(id: number): Promise<void> {
  const db = await getDB();
  const log = await db.get('activityLogs', id);
  if (log) {
    // Use number 1 instead of boolean true for consistency with the index
    // @ts-ignore
    log.synced = 1;
    await db.put('activityLogs', log);
  }
}

// Record one more sync attempt against a log and return the running count, so
// the sync loop can back off and eventually dead-letter a stuck event.
export async function bumpActivityLogAttempts(id: number): Promise<number> {
  const db = await getDB();
  const log = await db.get('activityLogs', id);
  if (!log) return 0;
  const attempts = ((log as any).attempts || 0) + 1;
  (log as any).attempts = attempts;
  (log as any).lastAttemptAt = Date.now();
  await db.put('activityLogs', log);
  return attempts;
}

// Retire a log that has failed too many times: exclude it from the queue
// (synced = 1) but keep it, flagged, for history and diagnosis.
export async function deadLetterActivityLog(
  id: number,
  error: string,
): Promise<void> {
  const db = await getDB();
  const log = await db.get('activityLogs', id);
  if (!log) return;
  // @ts-ignore
  log.synced = 1;
  (log as any).deadLettered = true;
  (log as any).syncError = error;
  await db.put('activityLogs', log);
}

export async function deleteActivityLog(id: number): Promise<void> {
  const db = await getDB();
  await db.delete('activityLogs', id);
}

export async function clearActivityLogs(): Promise<void> {
  const db = await getDB();
  await db.clear('activityLogs');
}

// Function to reset the database (delete and recreate)
export async function resetDatabase(): Promise<void> {
  // Close any open connections
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    // @ts-ignore
    dbPromise = undefined;
  }

  // Delete the database
  await deleteDB(DB_NAME);

  // Reinitialize the database
  await getDB();

  console.log('Database has been reset');
}

// Screenshot operations
export async function saveScreenshot(
  screenshot: Screenshot,
): Promise<Screenshot> {
  const db = await getDB();
  // Convert boolean synced value to number (0 for false, 1 for true)
  const screenshotToSave = {
    ...screenshot,
    synced: screenshot.synced ? 1 : 0,
  };
  // @ts-ignore
  const id = await db.add('screenshots', screenshotToSave);
  return { ...screenshot, id: id as number };
}

export async function getScreenshots(): Promise<Screenshot[]> {
  const db = await getDB();
  const screenshots = await db.getAll('screenshots');
  // Convert number-synced values back to boolean for the application
  return screenshots.map((screenshot) => ({
    // @ts-ignore
    ...screenshot,
    // @ts-ignore
    synced: screenshot.synced === 1,
  }));
}

export async function getUnsyncedScreenshots(): Promise<Screenshot[]> {
  const db = await getDB();
  try {
    // Use 0 as the key for the index instead of boolean false
    const screenshots = await db.getAllFromIndex('screenshots', 'by-synced', 0);
    // Convert number-synced values back to boolean for the application
    return screenshots.map((screenshot) => ({
      // @ts-ignore
      ...screenshot,
      synced: false, // These are all unsynced screenshots (synced = 0)
    }));
  } catch (error) {
    console.error('Error getting unsynced screenshots:', error);
    // Fallback: get all screenshots and filter manually if the index query fails
    const allScreenshots = await db.getAll('screenshots');
    // Convert number-synced values back to boolean and filter
    return allScreenshots
      .map((screenshot) => ({
        // @ts-ignore
        ...screenshot,
        // @ts-ignore
        synced: screenshot.synced === 1,
      }))
      .filter((screenshot) => screenshot.synced === false);
  }
}

export async function markScreenshotAsSynced(id: number): Promise<void> {
  const db = await getDB();
  const screenshot = await db.get('screenshots', id);
  if (screenshot) {
    // Use number 1 instead of boolean true for consistency with the index
    // @ts-ignore
    screenshot.synced = 1;
    await db.put('screenshots', screenshot);
  }
}

export async function bumpScreenshotAttempts(id: number): Promise<number> {
  const db = await getDB();
  const screenshot = await db.get('screenshots', id);
  if (!screenshot) return 0;
  const attempts = ((screenshot as any).attempts || 0) + 1;
  (screenshot as any).attempts = attempts;
  (screenshot as any).lastAttemptAt = Date.now();
  await db.put('screenshots', screenshot);
  return attempts;
}

export async function deadLetterScreenshot(
  id: number,
  error: string,
): Promise<void> {
  const db = await getDB();
  const screenshot = await db.get('screenshots', id);
  if (!screenshot) return;
  // @ts-ignore
  screenshot.synced = 1;
  (screenshot as any).deadLettered = true;
  (screenshot as any).syncError = error;
  await db.put('screenshots', screenshot);
}

export async function deleteScreenshot(id: number): Promise<void> {
  const db = await getDB();
  await db.delete('screenshots', id);
}

export async function clearScreenshots(): Promise<void> {
  const db = await getDB();
  await db.clear('screenshots');
}

// Export the database service
const databaseService = {
  saveAuth,
  getAuth,
  clearAuth,
  saveConfig,
  getConfig,
  saveActivityLog,
  getActivityLogs,
  getUnsyncedActivityLogs,
  markActivityLogAsSynced,
  bumpActivityLogAttempts,
  deadLetterActivityLog,
  deleteActivityLog,
  clearActivityLogs,
  saveScreenshot,
  getScreenshots,
  getUnsyncedScreenshots,
  markScreenshotAsSynced,
  bumpScreenshotAttempts,
  deadLetterScreenshot,
  deleteScreenshot,
  clearScreenshots,
  resetDatabase,
};

export default databaseService;
