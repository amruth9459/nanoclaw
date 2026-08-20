/**
 * MoreMenu — hub for Tasks, PLC, Settings, Security
 */
import React from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
} from 'react-native';
import { useNavigation } from '@react-navigation/core';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { theme } from '../api/client';
import type { MoreStackParamList } from '../navigation/TabNavigator';

type NavProp = NativeStackNavigationProp<MoreStackParamList, 'MoreMenu'>;

interface MenuItem {
  key: keyof Omit<MoreStackParamList, 'MoreMenu'>;
  icon: string;
  label: string;
  description: string;
}

const ITEMS: MenuItem[] = [
  { key: 'Tasks', icon: '📋', label: 'Tasks', description: 'Scheduled tasks & kanban board' },
  { key: 'PLC', icon: '🏗️', label: 'PLC', description: 'Site check-ins & crew roster' },
  { key: 'Settings', icon: '⚙️', label: 'Settings', description: 'API config & service health' },
  { key: 'SecuritySettings', icon: '🔐', label: 'Security', description: 'Biometric, PIN & session management' },
];

export function MoreMenuScreen() {
  const nav = useNavigation<NavProp>();

  return (
    <View style={s.container}>
      <FlatList
        data={ITEMS}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={s.row}
            onPress={() => nav.navigate(item.key)}
            activeOpacity={0.7}
          >
            <Text style={s.icon}>{item.icon}</Text>
            <View style={s.info}>
              <Text style={s.label}>{item.label}</Text>
              <Text style={s.description}>{item.description}</Text>
            </View>
            <Text style={s.chevron}>›</Text>
          </TouchableOpacity>
        )}
        ItemSeparatorComponent={() => <View style={s.sep} />}
        contentContainerStyle={s.listContent}
      />

      <View style={s.footer}>
        <Text style={s.footerText}>Claw Mobile v0.3.0</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  listContent: { paddingTop: 8 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 20, paddingVertical: 16,
  },
  icon: { fontSize: 24, width: 32, textAlign: 'center' },
  info: { flex: 1 },
  label: { color: theme.textPrimary, fontSize: 16, fontWeight: '600' },
  description: { color: theme.textSecondary, fontSize: 12, marginTop: 2 },
  chevron: { color: theme.border, fontSize: 22 },
  sep: { height: 1, backgroundColor: theme.border, marginLeft: 66 },
  footer: { alignItems: 'center', paddingBottom: 20 },
  footerText: { color: theme.textTertiary, fontSize: 11 },
});
