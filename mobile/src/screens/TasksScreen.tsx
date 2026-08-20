/**
 * Tasks — scheduled task list + kanban board
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, FlatList, ScrollView, TouchableOpacity,
  StyleSheet, ActivityIndicator, Alert, RefreshControl,
  Animated, PanResponder, Dimensions,
} from 'react-native';
import { api, Task, KanbanItem, theme } from '../api/client';

const SCREEN_WIDTH = Dimensions.get('window').width;
const SWIPE_THRESHOLD = 60;

const STATUS_COLOR: Record<string, string> = {
  active: theme.success,
  paused: theme.warning,
  completed: theme.textTertiary,
  error: theme.error,
};

const STATUS_BG: Record<string, string> = {
  active: '#f0fdf4',
  paused: '#fffbeb',
  completed: theme.bgSecondary,
  error: '#fef2f2',
};

function formatNextRun(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diff = d.getTime() - now.getTime();
  if (diff < 0) return 'overdue';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ── Swipeable task card ───────────────────────────────────────────────────────

function TaskCard({ task, onToggle, onTrigger }: {
  task: Task;
  onToggle: (t: Task) => void;
  onTrigger: (t: Task) => void;
}) {
  const translateX = useRef(new Animated.Value(0)).current;
  const [revealed, setRevealed] = useState(false);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 8 && Math.abs(g.dy) < 20,
      onPanResponderMove: (_, g) => {
        if (g.dx < 0) translateX.setValue(Math.max(g.dx, -120));
      },
      onPanResponderRelease: (_, g) => {
        if (g.dx < -SWIPE_THRESHOLD) {
          Animated.spring(translateX, { toValue: -110, useNativeDriver: true }).start();
          setRevealed(true);
        } else {
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
          setRevealed(false);
        }
      },
    }),
  ).current;

  const closeSwipe = () => {
    Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
    setRevealed(false);
  };

  return (
    <View style={tc.outer}>
      {/* Swipe action buttons revealed behind card */}
      <View style={tc.actions}>
        <TouchableOpacity
          style={[tc.action, { backgroundColor: task.status === 'paused' ? theme.success : theme.warning }]}
          onPress={() => { closeSwipe(); onToggle(task); }}
        >
          <Text style={tc.actionIcon}>{task.status === 'paused' ? '▶' : '⏸'}</Text>
          <Text style={tc.actionLabel}>{task.status === 'paused' ? 'Resume' : 'Pause'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[tc.action, { backgroundColor: theme.primary }]}
          onPress={() => { closeSwipe(); onTrigger(task); }}
        >
          <Text style={tc.actionIcon}>⚡</Text>
          <Text style={tc.actionLabel}>Run</Text>
        </TouchableOpacity>
      </View>

      <Animated.View
        style={[tc.card, { transform: [{ translateX }] }]}
        {...panResponder.panHandlers}
      >
        <View style={tc.cardTop}>
          <View style={[tc.statusDot, { backgroundColor: STATUS_COLOR[task.status] ?? theme.textTertiary }]} />
          <Text style={tc.scheduleLabel}>{task.scheduleType}</Text>
          <Text style={tc.scheduleVal}>{task.scheduleValue}</Text>
          <View style={{ flex: 1 }} />
          <View style={[tc.badge, { backgroundColor: STATUS_BG[task.status] ?? theme.bgSecondary, borderColor: STATUS_COLOR[task.status] ?? theme.border }]}>
            <Text style={[tc.badgeText, { color: STATUS_COLOR[task.status] ?? theme.textSecondary }]}>
              {task.status}
            </Text>
          </View>
        </View>

        <Text style={tc.prompt} numberOfLines={2}>{task.prompt}</Text>

        <View style={tc.meta}>
          <Text style={tc.metaItem}>📁 {task.groupFolder}</Text>
          {task.nextRun && (
            <Text style={[tc.metaItem, tc.nextRun]}>⏱ {formatNextRun(task.nextRun)}</Text>
          )}
        </View>

        {task.lastResult && (
          <Text style={tc.lastResult} numberOfLines={1}>
            Last: {task.lastResult.slice(0, 80)}
          </Text>
        )}

        {/* Inline action row when not swiped */}
        {!revealed && (
          <View style={tc.inlineActions}>
            <TouchableOpacity
              style={[tc.inlineBtn, { borderColor: STATUS_COLOR[task.status] ?? theme.border }]}
              onPress={() => onToggle(task)}
            >
              <Text style={[tc.inlineBtnTxt, { color: STATUS_COLOR[task.status] ?? theme.textSecondary }]}>
                {task.status === 'paused' ? '▶ Resume' : '⏸ Pause'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[tc.inlineBtn, tc.inlineBtnAccent]}
              onPress={() => onTrigger(task)}
            >
              <Text style={tc.inlineBtnTxtAccent}>⚡ Run now</Text>
            </TouchableOpacity>
          </View>
        )}
      </Animated.View>
    </View>
  );
}

const tc = StyleSheet.create({
  outer: { marginBottom: 10, position: 'relative' },
  actions: {
    position: 'absolute', right: 0, top: 0, bottom: 0,
    flexDirection: 'row', borderRadius: 12, overflow: 'hidden',
  },
  action: {
    width: 55, alignItems: 'center', justifyContent: 'center', gap: 2,
  },
  actionIcon: { color: '#fff', fontSize: 16 },
  actionLabel: { color: '#fff', fontSize: 10, fontWeight: '600' },
  card: {
    backgroundColor: theme.bgInput, borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: theme.border,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  scheduleLabel: { color: theme.textTertiary, fontSize: 11, textTransform: 'uppercase' },
  scheduleVal: { color: theme.textSecondary, fontSize: 12, fontWeight: '500' },
  badge: {
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, borderWidth: 1,
  },
  badgeText: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase' },
  prompt: { color: theme.textPrimary, fontSize: 14, lineHeight: 20, marginBottom: 8 },
  meta: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  metaItem: { color: theme.textTertiary, fontSize: 12 },
  nextRun: { color: theme.primary },
  lastResult: { color: theme.textTertiary, fontSize: 11, marginTop: 6, fontStyle: 'italic' },
  inlineActions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  inlineBtn: {
    flex: 1, paddingVertical: 7, borderRadius: 8,
    borderWidth: 1, borderColor: theme.border, alignItems: 'center',
  },
  inlineBtnAccent: { backgroundColor: theme.primary + '15', borderColor: theme.primary },
  inlineBtnTxt: { fontSize: 12, fontWeight: '600' },
  inlineBtnTxtAccent: { color: theme.primary, fontSize: 12, fontWeight: '600' },
});

// ── Kanban board ──────────────────────────────────────────────────────────────

const KANBAN_COLS: Array<{ key: KanbanItem['status']; label: string; color: string }> = [
  { key: 'todo', label: 'To Do', color: theme.textTertiary },
  { key: 'in_progress', label: 'In Progress', color: theme.warning },
  { key: 'done', label: 'Done', color: theme.success },
];

function KanbanBoard({ items }: { items: KanbanItem[] }) {
  const byStatus = KANBAN_COLS.reduce<Record<string, KanbanItem[]>>((acc, col) => {
    acc[col.key] = items.filter((i) => i.status === col.key);
    return acc;
  }, {});

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={kb.scroll}>
      {KANBAN_COLS.map((col) => (
        <View key={col.key} style={[kb.col, { width: SCREEN_WIDTH * 0.72 }]}>
          <View style={kb.colHeader}>
            <View style={[kb.colDot, { backgroundColor: col.color }]} />
            <Text style={kb.colTitle}>{col.label}</Text>
            <View style={[kb.colCount, { backgroundColor: col.color + '22' }]}>
              <Text style={[kb.colCountText, { color: col.color }]}>{byStatus[col.key].length}</Text>
            </View>
          </View>
          {byStatus[col.key].map((item) => (
            <View key={item.id} style={kb.item}>
              <Text style={kb.itemTitle} numberOfLines={2}>{item.title}</Text>
              <View style={kb.itemMeta}>
                <Text style={kb.itemSource}>{item.source}</Text>
                <Text style={kb.itemProject}>{item.project}</Text>
              </View>
            </View>
          ))}
          {byStatus[col.key].length === 0 && (
            <Text style={kb.empty}>No items</Text>
          )}
        </View>
      ))}
    </ScrollView>
  );
}

const kb = StyleSheet.create({
  scroll: { marginHorizontal: -12 },
  col: {
    backgroundColor: theme.bgSecondary, borderRadius: 12, padding: 12, marginHorizontal: 6,
    borderWidth: 1, borderColor: theme.border,
  },
  colHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  colDot: { width: 8, height: 8, borderRadius: 4 },
  colTitle: { color: theme.textPrimary, fontSize: 13, fontWeight: '700', flex: 1 },
  colCount: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999 },
  colCountText: { fontSize: 11, fontWeight: '700' },
  item: {
    backgroundColor: theme.bgInput, borderRadius: 8, padding: 10,
    marginBottom: 6, borderWidth: 1, borderColor: theme.border,
  },
  itemTitle: { color: theme.textPrimary, fontSize: 13, lineHeight: 18, marginBottom: 6 },
  itemMeta: { flexDirection: 'row', justifyContent: 'space-between' },
  itemSource: { color: theme.textTertiary, fontSize: 11 },
  itemProject: { color: theme.primary, fontSize: 11 },
  empty: { color: theme.textTertiary, fontSize: 12, textAlign: 'center', paddingVertical: 20 },
});

// ── Main screen ───────────────────────────────────────────────────────────────

export function TasksScreen() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [kanban, setKanban] = useState<KanbanItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'scheduled' | 'kanban'>('scheduled');

  const load = useCallback(async () => {
    const [ts, kb] = await Promise.all([
      api.tasks(),
      api.kanban('nanoclaw').catch(() => ({ items: [] as KanbanItem[], project: 'nanoclaw' })),
    ]);
    setTasks(ts);
    setKanban(kb.items);
    setError(null);
  }, []);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load().catch((e: Error) => setError(e.message)).finally(() => setRefreshing(false));
  }, [load]);

  const togglePause = useCallback(async (task: Task) => {
    try {
      if (task.status === 'paused') await api.resumeTask(task.id);
      else await api.pauseTask(task.id);
      await load();
    } catch (e) {
      Alert.alert('Error', String(e));
    }
  }, [load]);

  const trigger = useCallback(async (task: Task) => {
    try {
      await api.triggerTask(task.id);
      Alert.alert('Queued', `"${task.prompt.slice(0, 50)}${task.prompt.length > 50 ? '…' : ''}" queued for immediate execution.`);
    } catch (e) {
      Alert.alert('Error', String(e));
    }
  }, []);

  if (loading) {
    return <View style={ts.center}><ActivityIndicator color={theme.primary} size="large" /></View>;
  }

  if (error) {
    return (
      <View style={ts.center}>
        <Text style={ts.error}>{error}</Text>
        <TouchableOpacity style={ts.retryBtn} onPress={() => { setLoading(true); load().finally(() => setLoading(false)); }}>
          <Text style={ts.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={ts.container}>
      {/* Tab switcher */}
      <View style={ts.tabs}>
        <TouchableOpacity
          style={[ts.tab, activeTab === 'scheduled' && ts.tabActive]}
          onPress={() => setActiveTab('scheduled')}
        >
          <Text style={[ts.tabText, activeTab === 'scheduled' && ts.tabTextActive]}>
            Scheduled ({tasks.length})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[ts.tab, activeTab === 'kanban' && ts.tabActive]}
          onPress={() => setActiveTab('kanban')}
        >
          <Text style={[ts.tabText, activeTab === 'kanban' && ts.tabTextActive]}>
            Kanban ({kanban.length})
          </Text>
        </TouchableOpacity>
      </View>

      {activeTab === 'scheduled' ? (
        <FlatList
          data={tasks}
          keyExtractor={(t) => t.id}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} />
          }
          renderItem={({ item }) => (
            <TaskCard task={item} onToggle={togglePause} onTrigger={trigger} />
          )}
          contentContainerStyle={ts.listContent}
          ListEmptyComponent={
            <View style={ts.emptyWrap}>
              <Text style={ts.emptyTitle}>No scheduled tasks</Text>
              <Text style={ts.emptyHint}>Create tasks via Claw chat</Text>
            </View>
          }
        />
      ) : (
        <ScrollView
          style={ts.scrollView}
          contentContainerStyle={ts.kanbanContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} />
          }
        >
          <KanbanBoard items={kanban} />
        </ScrollView>
      )}
    </View>
  );
}

const ts = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bg, padding: 24 },
  error: { color: theme.error, fontSize: 14, textAlign: 'center', marginBottom: 12 },
  retryBtn: { backgroundColor: theme.bgSecondary, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  retryText: { color: theme.textPrimary, fontSize: 14 },
  tabs: {
    flexDirection: 'row', backgroundColor: theme.bg,
    borderBottomWidth: 1, borderBottomColor: theme.border,
  },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2, borderBottomColor: theme.primary },
  tabText: { color: theme.textTertiary, fontSize: 14, fontWeight: '500' },
  tabTextActive: { color: theme.textPrimary, fontWeight: '600' },
  listContent: { padding: 12 },
  scrollView: { flex: 1 },
  kanbanContent: { padding: 12 },
  emptyWrap: { flex: 1, alignItems: 'center', paddingTop: 60 },
  emptyTitle: { color: theme.textSecondary, fontSize: 16, fontWeight: '600', marginBottom: 6 },
  emptyHint: { color: theme.textTertiary, fontSize: 13 },
});
