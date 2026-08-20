import React, { useEffect, useState } from 'react';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import * as SecureStore from 'expo-secure-store';
import { TabNavigator } from './src/navigation/TabNavigator';
import { configure, DEFAULT_BASE_URL, theme } from './src/api/client';

const navTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: theme.bg,
    card: theme.bg,
    border: theme.border,
    primary: theme.primary,
    text: theme.textPrimary,
  },
};

// IPs that are likely stale (local LAN, not Tailscale)
const STALE_IP_RE = /^http:\/\/192\.168\.\d+\.\d+/;

export default function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      let url = await SecureStore.getItemAsync('claw_api_url');
      const token = await SecureStore.getItemAsync('claw_api_token');

      // Fall back to default if no URL stored or stale LAN IP
      if (!url || STALE_IP_RE.test(url)) {
        url = DEFAULT_BASE_URL;
      }

      // Always configure — token can be empty string
      configure(url, token ?? '');
      setReady(true);
    })();
  }, []);

  if (!ready) return null;

  return (
    <>
      <StatusBar style="dark" />
      <NavigationContainer theme={navTheme}>
        <TabNavigator />
      </NavigationContainer>
    </>
  );
}
