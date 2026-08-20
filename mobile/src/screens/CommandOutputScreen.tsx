/**
 * CommandOutput — full-screen monospace output for a single command
 */
import React from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useRoute } from '@react-navigation/core';
import { RouteProp } from '@react-navigation/native';
import { theme } from '../api/client';
import type { TerminalStackParamList } from '../navigation/TabNavigator';

type RouteParams = RouteProp<TerminalStackParamList, 'CommandOutput'>;

export function CommandOutputScreen() {
  const { params } = useRoute<RouteParams>();
  const { command, output, exitCode, duration, success } = params;

  const copyOutput = async () => {
    try {
      await Clipboard.setStringAsync(output);
    } catch { /* clipboard not available in Expo Go sometimes */ }
  };

  return (
    <View style={s.container}>
      {/* Header info */}
      <View style={s.header}>
        <Text style={s.commandLabel}>$ {command}</Text>
        <View style={s.metaRow}>
          <View style={[s.badge, { backgroundColor: success ? theme.success + '22' : theme.error + '22' }]}>
            <Text style={[s.badgeText, { color: success ? theme.success : theme.error }]}>
              exit {exitCode}
            </Text>
          </View>
          <Text style={s.duration}>{duration}ms</Text>
          <TouchableOpacity style={s.copyBtn} onPress={copyOutput}>
            <Text style={s.copyText}>Copy</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Output */}
      <ScrollView style={s.outputScroll} contentContainerStyle={s.outputContent}>
        <Text style={s.output} selectable>{output || '(no output)'}</Text>
      </ScrollView>
    </View>
  );
}

const MONO = { fontFamily: 'Menlo' } as const;

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1E1E1E' },
  header: {
    padding: 14, borderBottomWidth: 1, borderBottomColor: '#333',
    backgroundColor: '#252525',
  },
  commandLabel: { color: '#10b981', fontSize: 13, ...MONO, marginBottom: 8 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  badgeText: { fontSize: 12, fontWeight: '700' },
  duration: { color: '#888', fontSize: 12, flex: 1 },
  copyBtn: {
    backgroundColor: '#333', borderRadius: 6,
    paddingHorizontal: 12, paddingVertical: 5,
  },
  copyText: { color: '#D4D4D4', fontSize: 12, fontWeight: '600' },
  outputScroll: { flex: 1 },
  outputContent: { padding: 14 },
  output: { color: '#D4D4D4', fontSize: 12, lineHeight: 18, ...MONO },
});
