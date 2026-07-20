import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  ReactNode,
  useMemo,
} from 'react';
import { NetworkStatus } from '../types';
import networkService from '../services/network';

// Define the context type
interface NetworkContextType {
  networkStatus: NetworkStatus;
  syncData: () => Promise<void>;
}

// Create the context with a default value
const NetworkContext = createContext<NetworkContextType>({
  networkStatus: { isOnline: navigator.onLine },
  syncData: async () => {},
});

// Custom hook to use the network context
export const useNetwork = () => useContext(NetworkContext);

// Props for the NetworkProvider component
interface NetworkProviderProps {
  children: ReactNode;
}

// NetworkProvider component
export const NetworkProvider: React.FC<NetworkProviderProps> = ({
  children,
}) => {
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus>(
    networkService.getStatus(),
  );

  // Listen for network status changes
  useEffect(() => {
    const removeListener = networkService.addListener((status) => {
      setNetworkStatus(status);
    });

    // Clean up listener on unmount
    return () => {
      removeListener();
    };
  }, []);

  // Sync data with the server
  const syncData = async () => {
    await networkService.syncData();
  };

  // Context value
  const value: NetworkContextType = useMemo(
    () => ({
      networkStatus,
      syncData,
    }),
    [networkStatus],
  );

  return (
    <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>
  );
};
