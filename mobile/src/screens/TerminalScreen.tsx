/**
 * Terminal — tmux session list + preset command grid + free-form input + output history
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, TextInput, FlatList, SectionList, TouchableOpacity,
  StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/core';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { api, ShellPreset, ShellResult, theme } from '../api/client';
import { requireElevation } from '../security/auth';
import type { TerminalStackParamList } from '../navigation/TabNavigator';

type NavProp = NativeStackNavigationProp<TerminalStackParamList, 'Terminal'>;

interface TmuxSession {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
  size: string;
}

interface HistoryEntry {
  id: string;
  command: string;
  output: string;
  success: boolean;
  exitCode: number;
  duration: number;
  timestamp: string;
}

const DANGER_PATTERNS = ['rm -rf', 'sudo', 'dd if=', 'mkfs', '> /etc/'];

export function TerminalScreen() {
  const nav = useNavigation<NavProp>();
  const [presets, setPresets] = useState<ShellPreset[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [sessions, setSessions] = useState<TmuxSession[]>([]);
  const [command, setCommand] = useState('');
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [activeTab, setActiveTab] = useState<'presets' | 'history'>('presets');

  const loadData = useCallback(async () => {
    const [p, h, sess] = await Promise.all([
      api.shellPresets().catch(() => ({ presets: [] as ShellPreset[] })),
      api.shellHistory().catch(() => ({ entries: [] })),
      api.terminalSessions().catch(() => ({ sessions: [] as TmuxSession[] })),
    ]);
    console.log('[Terminal] loaded sessions:', sess.sessions?.length, 'presets:', p.presets?.length);
    setPresets(p.presets || []);
    setHistory((h.entries || []).map((e: any, i: number) => ({ ...e, id: String(i), output: '' })) as HistoryEntry[]);
    setSessions(sess.sessions || []);
  }, []);

  // Refresh session list when screen comes into focus
  useFocusEffect(
    useCallback(() => {
      api.terminalSessions().then((r) => setSessions(r.sessions || [])).catch(() => {});
    }, []),
  );

  useEffect(() => {
    loadData().finally(() => setLoading(false));
  }, [loadData]);

  const runPreset = useCallback(async (preset: ShellPreset) => {
    setRunning(true);
    try {
      const result = await api.shellExecute(preset.key, true);
      nav.navigate('CommandOutput', {
        command: preset.command,
        output: result.output || result.error || '',
        exitCode: result.exitCode,
        duration: result.duration,
        success: result.success,
      });
    } catch (e) {
      Alert.alert('Error', String(e));
    } finally {
      setRunning(false);
    }
  }, [nav]);

  const runCustomCommand = useCallback(async () => {
    const cmd = command.trim();
    if (!cmd) return;

    // Client-side danger check
    const isDangerous = DANGER_PATTERNS.some((p) => cmd.toLowerCase().includes(p));
    if (isDangerous) {
      Alert.alert(
        'Destructive Command',
        `"${cmd}" looks dangerous. Are you sure?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Run Anyway', style: 'destructive', onPress: () => executeCustom(cmd) },
        ],
      );
      return;
    }

    await executeCustom(cmd);
  }, [command, nav]);

  const executeCustom = async (cmd: string) => {
    const token = await requireElevation();
    if (!token) return;

    setRunning(true);
    try {
      const result = await api.shellExecute(cmd, false, undefined, token);
      setCommand('');
      nav.navigate('CommandOutput', {
        command: cmd,
        output: result.output || result.error || '',
        exitCode: result.exitCode,
        duration: result.duration,
        success: result.success,
      });
    } catch (e) {
      Alert.alert('Error', String(e));
    } finally {
      setRunning(false);
    }
  };

  // Group presets by category
  const sections = React.useMemo(() => {
    const groups: Record<string, ShellPreset[]> = {};
    for (const p of presets) {
      (groups[p.category] ??= []).push(p);
    }
    return Object.entries(groups).map(([title, data]) => ({ title, data }));
  }, [presets]);

  if (loading) {
    return <View style={s.center}><ActivityIndicator color={theme.primary} size="large" /></View>;
  }

  return (
    <View style={s.container}>
      {/* tmux session list */}
      <View style={s.sessionsSection}>
        <Text style={s.sessionsHeader}>TMUX SESSIONS ({sessions.length})</Text>
        {sessions.length === 0 && (
          <Text style={{ color: '#6c7086', fontSize: 12, paddingHorizontal: 12, paddingBottom: 8 }}>
            No active sessions — tap + to start one
          </Text>
        )}
        {sessions.map((sess) => (
          <TouchableOpacity
            key={sess.name}
            style={s.sessionCard}
            onPress={() => nav.navigate('InteractiveTerminal', { sessionName: sess.name })}
            activeOpacity={0.7}
          >
            <View style={s.sessionLeft}>
              <View style={[s.sessionDot, sess.attached && s.sessionDotAttached]} />
              <Text style={s.sessionName}>{sess.name}</Text>
            </View>
            <Text style={s.sessionMeta}>
              {sess.windows} win{sess.windows !== 1 ? 's' : ''} {sess.size ? `(${sess.size})` : ''}
            </Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity
          style={s.newSessionBtn}
          onPress={() => nav.navigate('InteractiveTerminal', { sessionName: 'claw-mobile' })}
          activeOpacity={0.7}
        >
          <Text style={s.newSessionPlus}>+</Text>
          <Text style={s.newSessionText}>New Session</Text>
        </TouchableOpacity>
      </View>

      {/* Command input */}
      <View style={s.inputBar}>
        <Text style={s.prompt}>$</Text>
        <TextInput
          style={s.input}
          value={command}
          onChangeText={setCommand}
          placeholder="Enter command..."
          placeholderTextColor={theme.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="send"
          onSubmitEditing={runCustomCommand}
          editable={!running}
        />
        <TouchableOpacity
          style={[s.runBtn, (!command.trim() || running) && s.runBtnDisabled]}
          onPress={runCustomCommand}
          disabled={!command.trim() || running}
        >
          {running ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={s.runBtnText}>Run</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Tab switcher */}
      <View style={s.tabs}>
        <TouchableOpacity
          style={[s.tab, activeTab === 'presets' && s.tabActive]}
          onPress={() => setActiveTab('presets')}
        >
          <Text style={[s.tabText, activeTab === 'presets' && s.tabTextActive]}>
            Presets ({presets.length})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.tab, activeTab === 'history' && s.tabActive]}
          onPress={() => setActiveTab('history')}
        >
          <Text style={[s.tabText, activeTab === 'history' && s.tabTextActive]}>
            History ({history.length})
          </Text>
        </TouchableOpacity>
      </View>

      {activeTab === 'presets' ? (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.key}
          renderSectionHeader={({ section }) => (
            <Text style={s.sectionHeader}>{section.title}</Text>
          )}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={s.presetCard}
              onPress={() => runPreset(item)}
              disabled={running}
              activeOpacity={0.7}
            >
              <Text style={s.presetName}>{item.name}</Text>
              <Text style={s.presetCmd} numberOfLines={1}>{item.command}</Text>
            </TouchableOpacity>
          )}
          contentContainerStyle={s.listContent}
          stickySectionHeadersEnabled={false}
        />
      ) : (
        <FlatList
          data={history}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <View style={s.historyCard}>
              <View style={s.historyTop}>
                <Text style={s.historyCmd} numberOfLines={1}>{item.command}</Text>
                <View style={[s.exitBadge, { backgroundColor: item.success ? theme.success + '22' : theme.error + '22' }]}>
                  <Text style={[s.exitText, { color: item.success ? theme.success : theme.error }]}>
                    {item.exitCode}
                  </Text>
                </View>
              </View>
              <View style={s.historyMeta}>
                <Text style={s.historyTime}>{new Date(item.timestamp).toLocaleTimeString()}</Text>
                <Text style={s.historyDuration}>{item.duration}ms</Text>
              </View>
            </View>
          )}
          contentContainerStyle={s.listContent}
          ListEmptyComponent={
            <View style={s.emptyWrap}>
              <Text style={s.emptyText}>No command history</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const MONO = { fontFamily: 'Menlo' } as const;

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bg },
  sessionsSection: {
    paddingHorizontal: 12, paddingTop: 10, paddingBottom: 4,
    backgroundColor: '#1e1e2e',
  },
  sessionsHeader: {
    color: '#6c7086', fontSize: 11, fontWeight: '700',
    letterSpacing: 1, marginBottom: 8, paddingHorizontal: 4,
  },
  sessionCard: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 11,
    backgroundColor: '#313244', borderRadius: 10, marginBottom: 6,
  },
  sessionLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sessionDot: {
    width: 8, height: 8, borderRadius: 4, backgroundColor: '#585b70',
  },
  sessionDotAttached: { backgroundColor: '#a6e3a1' },
  sessionName: { color: '#cdd6f4', fontSize: 14, fontWeight: '600', fontFamily: 'Menlo' },
  sessionMeta: { color: '#6c7086', fontSize: 12 },
  newSessionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 12, paddingVertical: 11,
    borderRadius: 10, marginBottom: 4,
    borderWidth: 1, borderColor: '#313244', borderStyle: 'dashed',
  },
  newSessionPlus: { color: '#89b4fa', fontSize: 18, fontWeight: '600', fontFamily: 'Menlo' },
  newSessionText: { color: '#89b4fa', fontSize: 14, fontWeight: '500' },
  inputBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: '#1E1E1E', borderBottomWidth: 1, borderBottomColor: '#333',
  },
  prompt: { color: '#10b981', fontSize: 16, fontWeight: '700', ...MONO },
  input: {
    flex: 1, color: '#D4D4D4', fontSize: 14, ...MONO,
    backgroundColor: '#2D2D2D', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8,
  },
  runBtn: {
    backgroundColor: theme.primary, borderRadius: 8,
    paddingHorizontal: 16, paddingVertical: 8,
  },
  runBtnDisabled: { opacity: 0.4 },
  runBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  tabs: {
    flexDirection: 'row', backgroundColor: theme.bg,
    borderBottomWidth: 1, borderBottomColor: theme.border,
  },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2, borderBottomColor: theme.primary },
  tabText: { color: theme.textTertiary, fontSize: 13, fontWeight: '500' },
  tabTextActive: { color: theme.textPrimary, fontWeight: '600' },
  listContent: { padding: 12, paddingBottom: 32 },
  sectionHeader: {
    color: theme.textSecondary, fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 1, marginTop: 12, marginBottom: 6, paddingHorizontal: 4,
  },
  presetCard: {
    backgroundColor: theme.bgInput, borderRadius: 10, padding: 12,
    borderWidth: 1, borderColor: theme.border, marginBottom: 6,
  },
  presetName: { color: theme.textPrimary, fontSize: 14, fontWeight: '600', marginBottom: 3 },
  presetCmd: { color: theme.textTertiary, fontSize: 12, ...MONO },
  historyCard: {
    backgroundColor: theme.bgInput, borderRadius: 10, padding: 12,
    borderWidth: 1, borderColor: theme.border, marginBottom: 6,
  },
  historyTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  historyCmd: { color: theme.textPrimary, fontSize: 13, ...MONO, flex: 1, marginRight: 8 },
  exitBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 99 },
  exitText: { fontSize: 11, fontWeight: '700' },
  historyMeta: { flexDirection: 'row', gap: 12, marginTop: 6 },
  historyTime: { color: theme.textTertiary, fontSize: 11 },
  historyDuration: { color: theme.textTertiary, fontSize: 11 },
  emptyWrap: { alignItems: 'center', paddingTop: 40 },
  emptyText: { color: theme.textTertiary, fontSize: 14 },
});
