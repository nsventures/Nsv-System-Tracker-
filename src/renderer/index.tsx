import { createRoot } from 'react-dom/client';
import App from './App';

// Forward uncaught renderer errors to the main process so they are written to
// the persistent log rather than dying silently in a DevTools console nobody
// has open on an employee's machine.
const reportRendererError = (label: string, detail: unknown) => {
  try {
    window.electron?.ipcRenderer.sendMessage(
      'log-error',
      `${label}: ${detail}`,
    );
  } catch {
    // Never let error reporting throw.
  }
};

window.addEventListener('error', (event) => {
  reportRendererError('window.onerror', event.message || event.error);
});
window.addEventListener('unhandledrejection', (event) => {
  reportRendererError('unhandledrejection', event.reason);
});

const container = document.getElementById('root') as HTMLElement;
const root = createRoot(container);
root.render(<App />);

// calling IPC exposed from preload script
window.electron?.ipcRenderer.once('ipc-example', (arg) => {
  // eslint-disable-next-line no-console
  console.log(arg);
});
window.electron?.ipcRenderer.sendMessage('ipc-example', ['ping']);
