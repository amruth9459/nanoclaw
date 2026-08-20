/**
 * SecuritySettings — biometric toggle, PIN setup, session revoke
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Switch,
  StyleSheet, Alert, ScrollView,
} from 'react-native';
import { theme } from '../api/client';
import {
  getBiometricType,
  isBiometricEnabled,
  setBiometricEnabled,
  savePin,
  hasPin,
  revokeSession,
} from '../security/auth';

export function SecuritySettingsScreen() {
  const [biometricType, setBiometricType] = useState('None');
  const [bioEnabled, setBioEnabled] = useState(false);
  const [pinConfigured, setPinConfigured] = useState(false);
  const [showPinSetup, setShowPinSetup] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');

  const loadState = useCallback(async () => {
    const type = await getBiometricType();
    const enabled = await isBiometricEnabled();
    const configured = await hasPin();
    setBiometricType(type);
    setBioEnabled(enabled);
    setPinConfigured(configured);
  }, []);

  useEffect(() => { loadState(); }, [loadState]);

  const toggleBiometric = async (val: boolean) => {
    await setBiometricEnabled(val);
    setBioEnabled(val);
  };

  const submitPin = async () => {
    const pin = pinInput.trim();
    if (pin.length < 4 || pin.length > 6) {
      Alert.alert('Invalid PIN', 'PIN must be 4-6 digits');
      return;
    }
    if (!/^\d+$/.test(pin)) {
      Alert.alert('Invalid PIN', 'PIN must contain only digits');
      return;
    }
    if (pin !== pinConfirm.trim()) {
      Alert.alert('Mismatch', 'PINs do not match');
      return;
    }

    await savePin(pin);
    setPinConfigured(true);
    setShowPinSetup(false);
    setPinInput('');
    setPinConfirm('');
    Alert.alert('PIN Set', 'Your security PIN has been saved.');
  };

  const handleRevoke = () => {
    Alert.alert(
      'Revoke Session',
      'This will clear the cached elevation token. You will need to re-authenticate for protected actions.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: () => {
            revokeSession();
            Alert.alert('Revoked', 'Active session cleared.');
          },
        },
      ],
    );
  };

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      {/* Biometric */}
      <Text style={s.sectionTitle}>Authentication</Text>

      <View style={s.settingRow}>
        <View style={s.settingInfo}>
          <Text style={s.settingLabel}>Biometric ({biometricType})</Text>
          <Text style={s.settingHint}>
            {biometricType === 'None'
              ? 'No biometric hardware available'
              : `Use ${biometricType} for protected actions`}
          </Text>
        </View>
        <Switch
          value={bioEnabled}
          onValueChange={toggleBiometric}
          trackColor={{ false: theme.border, true: theme.primary + '88' }}
          thumbColor={bioEnabled ? theme.primary : '#f4f3f4'}
          disabled={biometricType === 'None'}
        />
      </View>

      {/* PIN */}
      <View style={s.settingRow}>
        <View style={s.settingInfo}>
          <Text style={s.settingLabel}>Security PIN</Text>
          <Text style={s.settingHint}>
            {pinConfigured ? 'PIN configured' : 'No PIN set — required for protected actions'}
          </Text>
        </View>
        <TouchableOpacity
          style={s.configBtn}
          onPress={() => setShowPinSetup(!showPinSetup)}
        >
          <Text style={s.configBtnText}>{pinConfigured ? 'Change' : 'Setup'}</Text>
        </TouchableOpacity>
      </View>

      {showPinSetup && (
        <View style={s.pinSetup}>
          <Text style={s.pinLabel}>Enter PIN (4-6 digits)</Text>
          <TextInput
            style={s.pinInput}
            value={pinInput}
            onChangeText={setPinInput}
            keyboardType="number-pad"
            maxLength={6}
            secureTextEntry
            placeholder="PIN"
            placeholderTextColor={theme.textTertiary}
          />
          <Text style={s.pinLabel}>Confirm PIN</Text>
          <TextInput
            style={s.pinInput}
            value={pinConfirm}
            onChangeText={setPinConfirm}
            keyboardType="number-pad"
            maxLength={6}
            secureTextEntry
            placeholder="Confirm PIN"
            placeholderTextColor={theme.textTertiary}
          />
          <View style={s.pinBtns}>
            <TouchableOpacity style={s.pinCancelBtn} onPress={() => { setShowPinSetup(false); setPinInput(''); setPinConfirm(''); }}>
              <Text style={s.pinCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.pinSaveBtn} onPress={submitPin}>
              <Text style={s.pinSaveText}>Save PIN</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Session */}
      <Text style={s.sectionTitle}>Session</Text>

      <TouchableOpacity style={s.revokeBtn} onPress={handleRevoke}>
        <Text style={s.revokeIcon}>⚠️</Text>
        <View style={s.revokeInfo}>
          <Text style={s.revokeLabel}>Revoke Active Session</Text>
          <Text style={s.revokeHint}>Clear cached elevation token</Text>
        </View>
      </TouchableOpacity>

      {/* Info */}
      <View style={s.infoBox}>
        <Text style={s.infoTitle}>How Security Works</Text>
        <Text style={s.infoText}>
          Running preset commands and browsing files does not require elevation.
          Custom commands and file edits require biometric + PIN verification.
          Elevation tokens last 5 minutes.
        </Text>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 20, paddingBottom: 48 },
  sectionTitle: {
    color: theme.textSecondary, fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 1, marginTop: 20, marginBottom: 10,
  },
  settingRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: theme.bgInput, borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: theme.border, marginBottom: 8,
  },
  settingInfo: { flex: 1, marginRight: 12 },
  settingLabel: { color: theme.textPrimary, fontSize: 15, fontWeight: '600' },
  settingHint: { color: theme.textTertiary, fontSize: 12, marginTop: 2 },
  configBtn: {
    backgroundColor: theme.bgSecondary, borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 7,
    borderWidth: 1, borderColor: theme.border,
  },
  configBtnText: { color: theme.primary, fontSize: 13, fontWeight: '600' },
  pinSetup: {
    backgroundColor: theme.bgInput, borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: theme.primary + '44', marginBottom: 8,
  },
  pinLabel: { color: theme.textSecondary, fontSize: 12, marginBottom: 6, marginTop: 8 },
  pinInput: {
    backgroundColor: theme.bg, borderWidth: 1, borderColor: theme.border,
    borderRadius: 8, padding: 10, color: theme.textPrimary, fontSize: 18,
    textAlign: 'center', letterSpacing: 8,
  },
  pinBtns: { flexDirection: 'row', gap: 10, marginTop: 14 },
  pinCancelBtn: {
    flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: 'center',
    backgroundColor: theme.bgSecondary, borderWidth: 1, borderColor: theme.border,
  },
  pinCancelText: { color: theme.textSecondary, fontSize: 14 },
  pinSaveBtn: {
    flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: 'center',
    backgroundColor: theme.primary,
  },
  pinSaveText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  revokeBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fef2f2', borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: '#fca5a5',
  },
  revokeIcon: { fontSize: 20 },
  revokeInfo: { flex: 1 },
  revokeLabel: { color: theme.error, fontSize: 15, fontWeight: '600' },
  revokeHint: { color: '#b91c1c', fontSize: 12, marginTop: 2 },
  infoBox: {
    backgroundColor: theme.bgSecondary, borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: theme.border, marginTop: 20,
  },
  infoTitle: { color: theme.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 6 },
  infoText: { color: theme.textTertiary, fontSize: 12, lineHeight: 18 },
});
