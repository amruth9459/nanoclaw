/**
 * Settings — API config, connection status, service health + quick actions
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Alert, ScrollView, RefreshControl,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { api, configure, connectWebSocket, ServiceStatus, DEFAULT_BASE_URL, theme } from '../api/client';

const KEY_URL = 'claw_api_url';
const KEY_TOKEN = 'claw_api_token';

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

interface GroupHealth {
  jid: string;
  name: string;
  folder: string;
  active: boolean;
  activeTask: boolean;
  containerName: string | null;
  startedAt: number | null;
}

export function SettingsScreen() {
  const [url, setUrl] = useState(DEFAULT_BASE_URL);
  const [tok, setTok] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showToken, setShowToken] = useState(false);

  useEffect(() => {
    SecureStore.getItemAsync(KEY_URL).then((v) => { if (v) setUrl(v); });
    SecureStore.getItemAsync(KEY_TOKEN).then((v) => { if (v) setTok(v); });
  }, []);

  // WebSocket connection indicator
  useEffect(() => {
    const disconnect = connectWebSocket((evt) => {
      if (evt.event === 'status_change') {
        setWsConnected(evt.data.connected);
      }
      if (evt.event === 'ack') {
        setWsConnected(true);
      }
    });
    return disconnect;
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const s = await api.status();
      setStatus(s);
      setStatusError(null);
    } catch (e) {
      setStatusError(String(e));
      setStatus(null);
    }
  }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchStatus().finally(() => setRefreshing(false));
  }, [fetchStatus]);

  const save = async () => {
    setSaving(true);
    try {
      await SecureStore.setItemAsync(KEY_URL, url);
      await SecureStore.setItemAsync(KEY_TOKEN, tok);
      configure(url, tok);
      Alert.alert('Saved', 'Settings applied. Test connection to verify.');
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setStatusError(null);
    configure(url, tok);
    try {
      const s = await api.status();
      setStatus(s);
    } catch (e) {
      setStatusError(String(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <ScrollView
      style={ss.container}
      contentContainerStyle={ss.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} />}
    >
      {/* Connection status indicator */}
      <View style={ss.connBanner}>
        <View style={[ss.connDot, { backgroundColor: wsConnected ? theme.success : theme.warning }]} />
        <Text style={ss.connText}>
          {wsConnected ? 'WebSocket connected' : 'WebSocket not connected'}
        </Text>
        {status && (
          <Text style={ss.uptimeText}>Up {formatUptime(status.uptimeMs)}</Text>
        )}
      </View>

      {/* ── API Config ── */}
      <Text style={ss.sectionTitle}>API Configuration</Text>

      <Text style={ss.label}>Server URL</Text>
      <TextInput
        style={ss.input}
        value={url}
        onChangeText={setUrl}
        placeholder={DEFAULT_BASE_URL}
        placeholderTextColor={theme.textTertiary}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />

      <Text style={ss.label}>Bearer Token</Text>
      <View style={ss.tokenRow}>
        <TextInput
          style={[ss.input, ss.tokenInput]}
          value={tok}
          onChangeText={setTok}
          placeholder="NANOCLAW_DASH_TOKEN"
          placeholderTextColor={theme.textTertiary}
          secureTextEntry={!showToken}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity style={ss.eyeBtn} onPress={() => setShowToken(!showToken)}>
          <Text style={ss.eyeIcon}>{showToken ? '🙈' : '👁️'}</Text>
        </TouchableOpacity>
      </View>

      <View style={ss.btnRow}>
        <TouchableOpacity style={[ss.btn, ss.btnSave]} onPress={save} disabled={saving}>
          <Text style={ss.btnSaveText}>{saving ? 'Saving…' : 'Save'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[ss.btn, ss.btnTest]} onPress={testConnection} disabled={testing}>
          <Text style={ss.btnTestText}>{testing ? 'Testing…' : 'Test'}</Text>
        </TouchableOpacity>
      </View>

      {/* ── Service Health ── */}
      {(status || statusError) && (
        <>
          <Text style={ss.sectionTitle}>Service Health</Text>
          {statusError ? (
            <View style={[ss.healthBox, ss.healthBoxError]}>
              <Text style={ss.healthErrorText}>{statusError}</Text>
            </View>
          ) : status ? (
            <View style={ss.healthBox}>
              <View style={ss.healthRow}>
                <HealthStat label="Uptime" value={formatUptime(status.uptimeMs)} />
                <HealthStat label="Containers" value={String(status.activeContainers)} color={theme.success} />
                <HealthStat label="Groups" value={String(status.totalGroups)} color={theme.primary} />
              </View>

              {status.groups.length > 0 && (
                <View style={ss.groupsWrap}>
                  <Text style={ss.groupsTitle}>Active Groups</Text>
                  {status.groups.map((g: GroupHealth) => (
                    <View key={g.jid} style={ss.groupRow}>
                      <View style={[ss.groupDot, {
                        backgroundColor: g.active ? theme.success : g.activeTask ? theme.warning : theme.textTertiary,
                      }]} />
                      <Text style={ss.groupName}>{g.name}</Text>
                      <Text style={ss.groupStatus}>
                        {g.active ? 'active' : g.activeTask ? 'task' : 'idle'}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          ) : null}
        </>
      )}

      {/* ── Quick Actions ── */}
      <Text style={ss.sectionTitle}>Quick Actions</Text>

      <View style={ss.actionsGrid}>
        <ActionTile
          icon="🔄"
          label="Refresh Status"
          onPress={fetchStatus}
        />
        <ActionTile
          icon="🏥"
          label="Health Check"
          onPress={async () => {
            try {
              configure(url, tok);
              await api.status();
              Alert.alert('Healthy', 'All systems operational');
            } catch (e) {
              Alert.alert('Unhealthy', String(e));
            }
          }}
        />
        <ActionTile
          icon="📡"
          label="Test WebSocket"
          onPress={() => {
            if (wsConnected) {
              Alert.alert('Connected', 'WebSocket is active');
            } else {
              Alert.alert('Disconnected', 'WebSocket is not connected. Save settings and reconnect.');
            }
          }}
        />
        <ActionTile
          icon="🔑"
          label="Re-auth"
          onPress={async () => {
            try {
              configure(url, tok);
              const r = await api.auth();
              Alert.alert('Auth OK', `Connected as: ${r.assistantName}`);
            } catch (e) {
              Alert.alert('Auth failed', String(e));
            }
          }}
        />
      </View>

      {/* About */}
      <View style={ss.about}>
        <Text style={ss.aboutText}>Claw Mobile — NanoClaw Personal Assistant</Text>
        <Text style={ss.aboutVersion}>v0.2.0 · Phase 2</Text>
      </View>
    </ScrollView>
  );
}

function HealthStat({ label, value, color = theme.textPrimary }: { label: string; value: string; color?: string }) {
  return (
    <View style={hs.wrap}>
      <Text style={[hs.value, { color }]}>{value}</Text>
      <Text style={hs.label}>{label}</Text>
    </View>
  );
}

const hs = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center' },
  value: { fontSize: 22, fontWeight: '700' },
  label: { color: theme.textSecondary, fontSize: 11, marginTop: 2 },
});

function ActionTile({ icon, label, onPress }: { icon: string; label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={at.tile} onPress={onPress} activeOpacity={0.7}>
      <Text style={at.icon}>{icon}</Text>
      <Text style={at.label}>{label}</Text>
    </TouchableOpacity>
  );
}

const at = StyleSheet.create({
  tile: {
    flex: 1, backgroundColor: theme.bgInput, borderRadius: 12,
    borderWidth: 1, borderColor: theme.border,
    padding: 16, alignItems: 'center', gap: 6,
    minWidth: '45%',
  },
  icon: { fontSize: 24 },
  label: { color: theme.textSecondary, fontSize: 12, fontWeight: '500', textAlign: 'center' },
});

const ss = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 20, paddingBottom: 48, gap: 6 },
  connBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: theme.bgInput, borderRadius: 10,
    borderWidth: 1, borderColor: theme.border,
    paddingHorizontal: 14, paddingVertical: 10, marginBottom: 10,
  },
  connDot: { width: 8, height: 8, borderRadius: 4 },
  connText: { color: theme.textSecondary, fontSize: 13, flex: 1 },
  uptimeText: { color: theme.textTertiary, fontSize: 11 },
  sectionTitle: {
    color: theme.textSecondary, fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 1,
    marginTop: 16, marginBottom: 2,
  },
  label: { color: theme.textSecondary, fontSize: 12, marginTop: 8, marginBottom: 4 },
  input: {
    backgroundColor: theme.bgInput, borderWidth: 1, borderColor: theme.border,
    borderRadius: 10, padding: 12, color: theme.textPrimary, fontSize: 14,
  },
  tokenRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tokenInput: { flex: 1 },
  eyeBtn: { padding: 10 },
  eyeIcon: { fontSize: 18 },
  btnRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  btn: { flex: 1, borderRadius: 10, padding: 13, alignItems: 'center' },
  btnSave: { backgroundColor: theme.primary },
  btnSaveText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  btnTest: { backgroundColor: theme.bgSecondary, borderWidth: 1, borderColor: theme.border },
  btnTestText: { color: theme.textPrimary, fontSize: 14, fontWeight: '600' },
  healthBox: {
    backgroundColor: theme.bgInput, borderRadius: 12,
    borderWidth: 1, borderColor: theme.border, padding: 16,
  },
  healthBoxError: { borderColor: theme.error + '33' },
  healthErrorText: { color: theme.error, fontSize: 13 },
  healthRow: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 12 },
  groupsWrap: { borderTopWidth: 1, borderTopColor: theme.border, paddingTop: 12 },
  groupsTitle: { color: theme.textSecondary, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  groupRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  groupDot: { width: 6, height: 6, borderRadius: 3 },
  groupName: { color: theme.textPrimary, fontSize: 13, flex: 1 },
  groupStatus: { color: theme.textSecondary, fontSize: 11 },
  actionsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  about: { alignItems: 'center', marginTop: 24, gap: 4 },
  aboutText: { color: theme.textTertiary, fontSize: 12 },
  aboutVersion: { color: theme.textTertiary, fontSize: 11 },
});
