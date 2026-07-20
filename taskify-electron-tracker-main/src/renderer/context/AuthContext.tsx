import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  ReactNode,
  useMemo,
  useCallback,
} from 'react';
import { Auth, LoginRequest } from '../types';
import {
  apiService,
  databaseService,
  activityService,
  screenshotService,
  networkService,
} from '../services';
import { UNAUTHORIZED_EVENT } from '../services/api';

// Define the context type
interface AuthContextType {
  auth: Auth | null;
  isLoading: boolean;
  login: (
    credentials: LoginRequest,
  ) => Promise<{ success: boolean; message?: string }>;
  logout: () => Promise<void>;
  resetAuth: () => Promise<void>; // Add reset function
}

// Create the context with a default value
const AuthContext = createContext<AuthContextType>({
  auth: null,
  isLoading: true,
  login: async () => ({ success: false }),
  logout: async () => {},
  resetAuth: async () => {},
});

// Custom hook to use the auth context
export const useAuth = () => useContext(AuthContext);

// Props for the AuthProvider component
interface AuthProviderProps {
  children: ReactNode;
}

// AuthProvider component
export function AuthProvider({ children }: AuthProviderProps) {
  const [auth, setAuth] = useState<Auth | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Reset auth function - resets the database and auth state
  const resetAuth = useCallback(async (): Promise<void> => {
    try {
      // Clean up services
      activityService.cleanup();
      screenshotService.stop();

      // Reset the database
      await databaseService.resetDatabase();

      // Clear auth state
      setAuth(null);

      console.log('Auth and database have been reset');
    } catch (error) {
      console.error('Reset auth error:', error);
    }
  }, []);

  // Check if the user is already authenticated on mount
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const storedAuth = await databaseService.getAuth();
        if (storedAuth && storedAuth.isAuthenticated) {
          setAuth(storedAuth);

          // Initialize activity service with user data
          await activityService.initialize(
            storedAuth.user.user_id,
            storedAuth.user.workspace_id,
            storedAuth.token,
          );

          // Initialize and start screenshot service
          await screenshotService.initialize();
          screenshotService.start();
        }
      } catch (error) {
        console.error('Error checking authentication:', error);
      } finally {
        setIsLoading(false);
      }
    };

    checkAuth();

    // Clean up services on unmount
    return () => {
      activityService.cleanup();
      screenshotService.stop();
    };
  }, []);

  // Listen for unauthorized events (401 responses)
  useEffect(() => {
    const handleUnauthorized = async () => {
      console.log(
        'Unauthorized event received, resetting auth and redirecting to login',
      );
      await resetAuth();
    };

    // Add event listener
    window.addEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);

    // Clean up event listener on unmount
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
    };
  }, [resetAuth]);

  // Login function
  const login = useCallback(
    async (
      credentials: LoginRequest,
    ): Promise<{ success: boolean; message?: string }> => {
      setIsLoading(true);
      try {
        const response = await apiService.login(credentials);

        if (!response.error && response.data && response.token) {
          const newAuth: Auth = {
            token: response.token,
            user: response.data,
            isAuthenticated: true,
          };

          try {
            // Save auth data to database
            await databaseService.saveAuth(newAuth);

            // Set auth state
            setAuth(newAuth);

            // Initialize activity service with user data
            await activityService.initialize(
              response.data.user_id,
              response.data.workspace_id,
              response.token,
            );

            // Initialize and start screenshot service
            await screenshotService.initialize();
            screenshotService.start();

            return { success: true };
          } catch (dbError) {
            // If there's a database error, try to reset the database
            console.error('Database error during login:', dbError);

            // Try to reset the database and retry
            try {
              await resetAuth();

              // Try saving auth data again
              await databaseService.saveAuth(newAuth);
              setAuth(newAuth);

              // Initialize activity service with user data
              await activityService.initialize(
                response.data.user_id,
                response.data.workspace_id,
                response.token,
              );

              // Initialize and start screenshot service
              await screenshotService.initialize();
              screenshotService.start();

              return { success: true };
            } catch (resetError) {
              console.error('Failed to reset and retry login:', resetError);
              return {
                success: false,
                message: 'Database initialization failed.',
              };
            }
          }
        }

        return {
          success: false,
          message:
            response.message || 'Invalid email or password. Please try again.',
        };
      } catch (error) {
        console.error('Login error:', error);
        return {
          success: false,
          message:
            error instanceof Error
              ? error.message
              : 'An error occurred during login.',
        };
      } finally {
        setIsLoading(false);
      }
    },
    [resetAuth],
  );

  // Logout function
  const logout = useCallback(async (): Promise<void> => {
    try {
      // Check if user is clocked in and clock them out if so
      const clockedIn = await activityService.isUserClockedIn();
      if (clockedIn) {
        // eslint-disable-next-line no-console
        console.log('[Auth] User is clocked in during logout. Clocking out...');
        await activityService.clockOut();
      }

      // Sync any unsynced data (including the clock-out event if online) before clearing token
      await networkService.syncData();

      // Clean up services
      activityService.cleanup();
      screenshotService.stop();

      // Clear auth data
      await databaseService.clearAuth();
      setAuth(null);
    } catch (error) {
      console.error('Logout error:', error);
    }
  }, []);

  // Context value
  const value: AuthContextType = useMemo(
    () => ({
      auth,
      isLoading,
      login,
      logout,
      resetAuth,
    }),
    [auth, isLoading, login, logout, resetAuth],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
