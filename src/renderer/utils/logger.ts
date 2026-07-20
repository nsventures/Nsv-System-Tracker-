/**
 * Logger utility for conditional logging
 * Only logs in development mode to prevent performance issues in production
 */

// Check if we're in development mode
const isDevelopment = process.env.NODE_ENV === 'development';

/**
 * Debug logger that only logs in development mode
 * @param message - The message to log
 * @param args - Additional arguments to log
 */
export const debugLog = (message: string, ...args: any[]): void => {
  if (isDevelopment) {
    console.log(message, ...args);
  }
};

/**
 * Error logger that only logs in development mode
 * @param message - The error message to log
 * @param args - Additional arguments to log
 */
export const errorLog = (message: string, ...args: any[]): void => {
  if (isDevelopment) {
    console.error(message, ...args);
  }
};

export default {
  debugLog,
  errorLog,
};
