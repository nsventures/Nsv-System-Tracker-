# White Labeling Guide

This document provides instructions on how to white label the Taskify application to customize it for your own brand or client.

## Table of Contents

- [Overview](#overview)
- [White Label Configuration](#white-label-configuration)
- [Customization Options](#customization-options)
  - [Application Information](#application-information)
  - [User Interface Text](#user-interface-text)
  - [Theme Colors](#theme-colors)
  - [Assets](#assets)
- [How to White Label](#how-to-white-label)
  - [Step 1: Update Configuration](#step-1-update-configuration)
  - [Step 2: Replace Assets](#step-2-replace-assets)
  - [Step 3: Build the Application](#step-3-build-the-application)
- [Advanced Customization](#advanced-customization)
- [Troubleshooting](#troubleshooting)

## Overview

White labeling allows you to customize the branding elements of the application, including:

- Application name and product information
- User interface text and labels
- Theme colors and styling
- Icons and logos

The application uses a centralized configuration system that makes it easy to change these elements without modifying the core codebase.

## White Label Configuration

The white label configuration is defined in the file:

```
src/whiteLabel.config.ts
```

This file contains all the configurable elements for white labeling the application. When you build the application, these settings are automatically applied to the appropriate files.

## Customization Options

### Application Information

These settings control the basic information about the application:

| Property | Description |
|----------|-------------|
| `app.name` | The name of the application (used in package.json and electron-builder) |
| `app.productName` | The full product name (used for window title and about dialog) |
| `app.description` | A brief description of the application |
| `app.companyName` | Your company or organization name |
| `app.copyright` | Copyright notice |
| `app.website` | Your website URL |
| `app.supportEmail` | Support email address |
| `app.apiBaseUrl` | API endpoint URL for backend services |

### User Interface Text

These settings control the text displayed in the user interface:

| Property | Description |
|----------|-------------|
| `ui.dashboardTitle` | The title displayed on the dashboard page |
| `ui.loginTitle` | The title displayed on the login page |
| `ui.welcomeMessage` | Welcome message displayed to users |
| `ui.footerText` | Text displayed in the footer |

### Theme Colors

These settings control the color scheme of the application:

| Property | Description |
|----------|-------------|
| `colors.accentColor` | Primary brand color |
| `colors.accentHover` | Darker shade for hover states |
| `colors.accentLight` | Lighter shade for backgrounds |

You can also define custom colors for dark mode:

| Property | Description |
|----------|-------------|
| `darkColors.accentColor` | Primary brand color for dark mode |
| `darkColors.accentHover` | Darker shade for hover states in dark mode |
| `darkColors.accentLight` | Lighter shade for backgrounds in dark mode |

### Assets

These settings define the paths to the assets used in the application:

| Property | Description |
|----------|-------------|
| `assets.appIcon` | Main application icon |
| `assets.appLogo` | Logo used in the UI |
| `assets.favicon` | Favicon for browser |
| `assets.splashImage` | Splash screen image |

## How to White Label

### Step 1: Update Configuration

1. Open the `src/whiteLabel.config.ts` file
2. Modify the configuration values to match your brand
3. Save the file

Example:

```typescript
export const whiteLabelConfig = {
  app: {
    name: 'MyCompany Tracker',
    productName: 'MyCompany Time Tracker',
    description: 'Employee time tracking and productivity monitoring application',
    companyName: 'MyCompany Inc.',
    copyright: `© ${new Date().getFullYear()} MyCompany Inc.`,
    website: 'https://mycompany.com',
    supportEmail: 'support@mycompany.com',
    apiBaseUrl: 'https://api.mycompany.com/timetracker',
  },
  ui: {
    dashboardTitle: 'Time Tracker',
    loginTitle: 'Login to MyCompany Tracker',
    welcomeMessage: 'Welcome to MyCompany Time Tracker',
    footerText: 'Powered by MyCompany',
  },
  colors: {
    accentColor: '#FF5722', // Orange
    accentHover: '#E64A19', // Darker orange
    accentLight: 'rgba(255, 87, 34, 0.15)', // Light orange
  },
  // ...
};
```

### Step 2: Replace Assets

1. Replace the icon files in the `assets` directory with your own:
  - `icon.png` - Main application icon (1024x1024 recommended)
  - `icon.svg` - Vector logo
  - `icon.ico` - Windows icon
  - `icon.icns` - macOS icon

2. Make sure to keep the same filenames or update the paths in the `assets` section of the configuration.

### Step 3: Build the Application

Run the build command to apply your white label configuration:

```bash
npm run build
```

This will:
1. Build the application
2. Apply your white label configuration to the appropriate files
3. Prepare the application for packaging

To package the application for distribution:

```bash
npm run package
```

## Advanced Customization

### Custom CSS

If you need more extensive styling customization, you can modify the CSS variables in `src/renderer/App.css`. The white label configuration automatically updates the accent colors, but you can manually adjust other variables as needed.

### Additional UI Text

If you need to customize text elements that aren't included in the white label configuration, you can add new properties to the `ui` section of the configuration and then use them in the appropriate components.

### Custom Components

For more extensive customization, you can create custom components that replace the default ones. This is beyond the scope of white labeling and would require modifying the codebase.

## Troubleshooting

### White Label Changes Not Applied

If your white label changes aren't being applied:

1. Make sure you've run `npm run build` after making changes to the configuration
2. Check the console for any error messages during the build process
3. Verify that the configuration file is correctly formatted

### Asset Issues

If your custom assets aren't displaying correctly:

1. Ensure the files are in the correct format and dimensions
2. Verify that the paths in the configuration match the actual file locations
3. Clear the build cache and rebuild the application

For additional help, please contact the development team.
