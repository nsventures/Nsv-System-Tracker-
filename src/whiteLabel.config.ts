export const whiteLabelConfig = {
  // Application Information
  app: {
    name: 'NS Ventures Time & Productivity Tracker', // Used in package.json and electron-builder
    productName: 'NS Ventures Time & Productivity Tracker', // Used for window title and about dialog
    description:
      'Employee time tracking and productivity monitoring application',
    companyName: 'Taskify Inc.',
    copyright: `© ${new Date().getFullYear()} Taskify Inc.`,
    website: 'https://nsventures.example.com',
    supportEmail: 'support@nsventures.example.com',
    apiBaseUrl: 'https://app.nsventures.in/api/plugin/timetracker', // API endpoint URL
  },

  // Timezone Configuration
  timezone: {
    default: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dateFormatOptions: {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    } as Intl.DateTimeFormatOptions,
    timeFormatOptions: {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    } as Intl.DateTimeFormatOptions,
    // Format options for displaying date and time together
    dateTimeFormatOptions: {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    } as Intl.DateTimeFormatOptions,
  },

  // User Interface Text
  ui: {
    dashboardTitle: 'NS Ventures Productivity Dashboard',
    loginTitle: 'Login to NS Ventures ',
    welcomeMessage: 'Welcome to NS Ventures Productivity Tracker',
    footerText: 'Powered by NS Ventures',
  },

  // Theme Colors (light theme)
  colors: {
    // Brand Colors
    accentColor: '#1ea4db', // Primary brand color (buttons)
    accentHover: '#05335b', // Darker shade for hover states
    accentLight: '#05335b', // Lighter shade for backgrounds

    // You can add more color overrides here if needed
    // These will be applied to the CSS variables in App.css
  },

  // Dark Theme Colors (optional overrides for dark mode)
  darkColors: {
    accentColor: '#1ea4db',
    accentHover: '#05335b',
    accentLight: '#05335b',
  },

  // Assets
  assets: {
    // Paths are relative to the assets directory
    appIcon: 'nsv.png', // Main application icon
    appLogo: 'nsv-logo-new.webp',
    favicon: 'nsv.png', // Favicon for browser
    splashImage: 'nsv.png', // Splash screen image
  },
};

/**
 * Helper function to apply white label theme colors to CSS variables
 */
export function applyWhiteLabelTheme(): void {
  const root = document.documentElement;
  const isDarkTheme = document.body.classList.contains('dark-theme');

  // Apply the appropriate color set based on current theme
  const colors = isDarkTheme
    ? whiteLabelConfig.darkColors
    : whiteLabelConfig.colors;

  // Apply colors to CSS variables
  if (colors.accentColor) {
    root.style.setProperty('--accent-color', colors.accentColor);
  }
  if (colors.accentHover) {
    root.style.setProperty('--accent-hover', colors.accentHover);
  }
  if (colors.accentLight) {
    root.style.setProperty('--accent-light', colors.accentLight);
  }

  // Update accent gradient if accent colors are defined
  if (colors.accentColor && colors.accentHover) {
    root.style.setProperty(
      '--accent-gradient',
      `linear-gradient(135deg, ${colors.accentColor}, ${colors.accentHover})`,
    );
  }
}

export default whiteLabelConfig;
