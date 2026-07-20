import {
  MemoryRouter as Router,
  Routes,
  Route,
  Navigate,
} from 'react-router-dom';
import { JSX, useEffect } from 'react';
import './App.css';
import {
  AuthProvider,
  useAuth,
  NetworkProvider,
  ThemeProvider,
} from './context';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';

function ProtectedRoute({ children }: { children: JSX.Element }) {
  const { auth, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="app-loader-container">
        <div className="app-loader-card">
          <div className="app-loader-spinner">
            <div className="app-loader-circle" />
            <div className="app-loader-circle-inner" />
          </div>
          <div className="app-loader-text">Loading App</div>
          <div className="app-loader-subtext">Initializing services...</div>
        </div>
      </div>
    );
  }

  if (!auth) {
    return <Navigate to="/login" />;
  }

  return children;
}

function AppRoutes() {
  const { auth, isLoading } = useAuth();

  // Redirect based on auth status
  useEffect(() => {
    // Redirect to dashboard if authenticated, to login if not
    if (!isLoading) {
      const currentPath = window.location.hash.substring(1) || '/';
      if (auth && currentPath === '/login') {
        window.location.hash = '#/';
      } else if (!auth && currentPath !== '/login') {
        window.location.hash = '#/login';
      }
    }
  }, [auth, isLoading]);

  return (
    <Routes>
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />
      <Route path="/login" element={<LoginPage />} />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}

export default function App() {
  const isElectron =
    typeof window !== 'undefined' && window.electron !== undefined;

  useEffect(() => {
    if (!isElectron) return () => {};

    const clockOutCleanup = window.electron.ipcRenderer.on(
      'clock-out-and-exit',
      async () => {
        try {
          console.log('Received clock-out-and-exit message from main process');
          const { activityService } = await import('./services/index.js');
          const isUserClockedIn = await activityService.isUserClockedIn();
          if (isUserClockedIn) {
            console.log('User is clocked in, clocking out before exit');
            await activityService.clockOut();
            console.log('User clocked out successfully');
          } else {
            console.log('User is not clocked in, no need to clock out');
          }
        } catch (error) {
          console.error('Error handling clock-out-and-exit:', error);
        } finally {
          window.electron.ipcRenderer.sendMessage('clock-out-complete');
        }
      },
    );

    const suspendBefore715Cleanup = window.electron.ipcRenderer.on(
      'system-suspend-before-715',
      async () => {
        try {
          console.log(
            'Received system-suspend-before-715 message from main process',
          );
          const { activityService } = await import('./services/index.js');
          await activityService.markAsIdleBeforeSleep();
        } catch (error) {
          console.error('Error handling system-suspend-before-715:', error);
        }
      },
    );

    const checkStatusCleanup = window.electron.ipcRenderer.on(
      'check-clock-in-status',
      async () => {
        try {
          console.log(
            'Received check-clock-in-status message from main process',
          );

          // Import activity service
          const { activityService } = await import('./services/index.js');

          const isUserClockedIn = await activityService.isUserClockedIn();
          console.log(`User clocked in status: ${isUserClockedIn}`);

          // Send the result back to the main process
          window.electron.ipcRenderer.sendMessage(
            'clock-in-status-response',
            isUserClockedIn,
          );
        } catch (error) {
          console.error('Error handling check-clock-in-status:', error);
          window.electron.ipcRenderer.sendMessage(
            'clock-in-status-response',
            false,
          );
        }
      },
    );

    // Clean up event listeners.
    return () => {
      clockOutCleanup();
      suspendBefore715Cleanup();
      checkStatusCleanup();
    };
  }, [isElectron]);

  if (!isElectron) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          backgroundColor: '#0f172a',
          color: '#f8fafc',
          fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
          padding: '2rem',
          textAlign: 'center',
          boxSizing: 'border-box',
        }}
      >
        <style
          dangerouslySetInnerHTML={{
            __html: `
          @keyframes pulse {
            0%, 100% { transform: scale(1); opacity: 0.5; }
            50% { transform: scale(1.05); opacity: 0.8; }
          }
          @keyframes glow {
            0%, 100% { box-shadow: 0 0 20px rgba(99, 102, 241, 0.2); }
            50% { box-shadow: 0 0 40px rgba(99, 102, 241, 0.4); }
          }
        `,
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: '20%',
            width: '300px',
            height: '300px',
            background:
              'radial-gradient(circle, rgba(99,102,241,0.15) 0%, rgba(0,0,0,0) 70%)',
            animation: 'pulse 8s infinite ease-in-out',
            zIndex: 0,
          }}
        />
        <div
          style={{
            backgroundColor: 'rgba(30, 41, 59, 0.7)',
            backdropFilter: 'blur(12px)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: '16px',
            padding: '3rem 2rem',
            maxWidth: '540px',
            width: '100%',
            zIndex: 1,
            animation: 'glow 6s infinite ease-in-out',
          }}
        >
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '64px',
              height: '64px',
              borderRadius: '50%',
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.2)',
              color: '#ef4444',
              fontSize: '32px',
              marginBottom: '1.5rem',
            }}
          >
            🖥️
          </div>
          <h1
            style={{
              fontSize: '2rem',
              fontWeight: '800',
              marginBottom: '1rem',
              background: 'linear-gradient(to right, #f43f5e, #fb7185)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              letterSpacing: '-0.025em',
            }}
          >
            Desktop Shell Required
          </h1>
          <p
            style={{
              fontSize: '1.05rem',
              color: '#94a3b8',
              lineHeight: '1.6',
              marginBottom: '2rem',
            }}
          >
            This is a{' '}
            <strong>desktop productivity and time tracking application</strong>.
            It relies on native system APIs and cannot run directly in a
            standard web browser.
          </p>
          <div
            style={{
              textAlign: 'left',
              backgroundColor: '#020617',
              borderRadius: '8px',
              border: '1px solid rgba(255,255,255,0.05)',
              padding: '1.25rem',
              fontFamily: 'Consolas, Monaco, "Andale Mono", monospace',
              fontSize: '0.95rem',
            }}
          >
            <div style={{ color: '#64748b', marginBottom: '0.5rem' }}>
              # To launch the application, run this in your terminal:
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span style={{ color: '#38bdf8' }}>npm start</span>
              <span style={{ color: '#475569', fontSize: '0.8rem' }}>
                ← run command
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ThemeProvider>
      <AuthProvider>
        <NetworkProvider>
          <Router>
            <AppRoutes />
          </Router>
        </NetworkProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
