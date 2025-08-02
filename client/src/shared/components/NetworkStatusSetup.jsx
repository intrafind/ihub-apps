import { useEffect } from 'react';
import { useNetworkStatus } from '../contexts/NetworkStatusContext';
import { setNetworkStatusContext } from '../../api/client';

/**
 * Component that sets up the network status context for the API client
 * This ensures the API client can use network-aware error handling
 */
const NetworkStatusSetup = ({ children }) => {
  const networkStatus = useNetworkStatus();

  useEffect(() => {
    // Provide the network status context to the API client
    setNetworkStatusContext(networkStatus);
  }, [networkStatus]);

  return children;
};

export default NetworkStatusSetup;