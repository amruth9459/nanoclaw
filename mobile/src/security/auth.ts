/**
 * Security elevation — biometric + PIN for destructive actions.
 * Token cached for 5 minutes to avoid re-prompting.
 */
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { Alert } from 'react-native';
import { api } from '../api/client';

const KEY_PIN = 'claw_security_pin';
const KEY_BIOMETRIC_ENABLED = 'claw_biometric_enabled';

let cachedToken: string | null = null;
let tokenExpiry = 0;

/**
 * Get a valid elevated security token, prompting for biometric + PIN if needed.
 * Returns token string or null if user cancels.
 */
export async function requireElevation(): Promise<string | null> {
  // Return cached token if still valid
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  // Check if biometric is available and enabled
  const biometricEnabled = await SecureStore.getItemAsync(KEY_BIOMETRIC_ENABLED);
  if (biometricEnabled === '1') {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();

    if (hasHardware && isEnrolled) {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Authenticate to continue',
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
      });

      if (!result.success) {
        return null; // User cancelled biometric
      }
    }
  }

  // Get stored PIN
  const pin = await SecureStore.getItemAsync(KEY_PIN);
  if (!pin) {
    Alert.alert('PIN Required', 'Set up a security PIN in Settings > Security first.');
    return null;
  }

  // Exchange PIN for elevated token
  try {
    const result = await api.securityElevate(pin);
    if (result.ok && result.token) {
      cachedToken = result.token;
      tokenExpiry = result.expiresAt || (Date.now() + 5 * 60 * 1000);
      return cachedToken;
    } else {
      Alert.alert('Elevation Failed', result.error || 'Invalid PIN');
      return null;
    }
  } catch (err) {
    Alert.alert('Error', String(err));
    return null;
  }
}

/**
 * Check if biometric hardware is available.
 */
export async function getBiometricType(): Promise<string> {
  const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
  if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) return 'Face ID';
  if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) return 'Touch ID';
  if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) return 'Iris';
  return 'None';
}

/**
 * Check if biometric is enabled in settings.
 */
export async function isBiometricEnabled(): Promise<boolean> {
  const val = await SecureStore.getItemAsync(KEY_BIOMETRIC_ENABLED);
  return val === '1';
}

/**
 * Toggle biometric setting.
 */
export async function setBiometricEnabled(enabled: boolean): Promise<void> {
  await SecureStore.setItemAsync(KEY_BIOMETRIC_ENABLED, enabled ? '1' : '0');
}

/**
 * Save the security PIN (stored locally + hash sent to server on elevation).
 */
export async function savePin(pin: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_PIN, pin);
}

/**
 * Check if a PIN is configured.
 */
export async function hasPin(): Promise<boolean> {
  const pin = await SecureStore.getItemAsync(KEY_PIN);
  return Boolean(pin);
}

/**
 * Clear cached elevation token.
 */
export function revokeSession(): void {
  cachedToken = null;
  tokenExpiry = 0;
}
