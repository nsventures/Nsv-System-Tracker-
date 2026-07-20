import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  ReactNode,
  useMemo,
} from 'react';
import { applyWhiteLabelTheme } from '../../whiteLabel.config';

// Define theme types
type ThemeType = 'light' | 'dark';

// Define the context type
interface ThemeContextType {
  theme: ThemeType;
  toggleTheme: () => void;
}

// Create the context with a default value
const ThemeContext = createContext<ThemeContextType>({
  theme: 'light',
  toggleTheme: () => {},
});

// Custom hook to use the theme context
export const useTheme = () => useContext(ThemeContext);

// Props for the ThemeProvider component
interface ThemeProviderProps {
  children: ReactNode;
}

// ThemeProvider component
export function ThemeProvider({ children }: ThemeProviderProps) {
  // Try to get the theme from localStorage, default to 'light'
  const [theme, setTheme] = useState<ThemeType>(() => {
    const savedTheme = localStorage.getItem('theme');
    return (savedTheme as ThemeType) || 'light';
  });

  // Effect to update the body class when theme changes
  useEffect(() => {
    // Update body class for CSS styling
    if (theme === 'dark') {
      document.body.classList.add('dark-theme');
    } else {
      document.body.classList.remove('dark-theme');
    }

    // Save theme preference to localStorage
    localStorage.setItem('theme', theme);

    // Apply white label theme colors
    applyWhiteLabelTheme();
  }, [theme]);

  // Apply white label theme on initial load
  useEffect(() => {
    applyWhiteLabelTheme();
  }, []);

  // Toggle between light and dark themes
  const toggleTheme = () => {
    setTheme((prevTheme) => (prevTheme === 'light' ? 'dark' : 'light'));
  };

  // Memoize the context value to prevent unnecessary re-renders
  const value = useMemo(
    () => ({
      theme,
      toggleTheme,
    }),
    [theme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export default ThemeContext;
