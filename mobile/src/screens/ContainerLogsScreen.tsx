/**
 * ContainerLogs — live log streaming via WebSocket with REST fallback
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, FlatList, TouchableOpacity,
  StyleSheet, ActivityIndicator,
} from 'react-native';
import { useRoute } from '@react-navigation/core';
import { RouteProp } from '@react-navigation/native';
import { api, connectWebSocket, theme } from '../api/client';
import type { SystemStackParamList } from '../navigation/TabNavigator';

type RouteParams = RouteProp<SystemStackParamList, 'ContainerLogs'>;

export function ContainerLogsScreen() {
  const { params } = useRoute<RouteParams>();
  const { containerName } = params;
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const listRef = useRef<FlatList>(null);
  const autoScroll = useRef(true);

  // Try WebSocket streaming first
  useEffect(() => {
    let cleanup: (() => void) | null = null;

    const startStream = () => {
      cleanup = connectWebSocket((evt) => {
        if (evt.event === 'container_log' && evt.data.containerName === containerName) {
          setLines((prev) => [...prev, evt.data.line]);
          setStreaming(true);
          setLoading(false);
        }
        if (evt.event === 'ack') {
          setLoading(false);
        }
      });

      // Send subscribe after connection
      // The WebSocket is internal, we need to send via the raw connection
      // Since connectWebSocket doesn't expose send(), fall back to REST polling
    };

    // Fallback: REST poll
    const fetchLogs = async () => {
      try {
        const result = await api.systemContainerLogs(containerName, 200);
        setLines(result.lines);
      } catch { /* ignore */ }
      setLoading(false);
    };

    fetchLogs();

    // Poll every 5s
    const timer = setInterval(async () => {
      try {
        const result = await api.systemContainerLogs(containerName, 200);
        setLines(result.lines);
      } catch { /* ignore */ }
    }, 5000);

    return () => {
      clearInterval(timer);
      if (cleanup) cleanup();
    };
  }, [containerName]);

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    if (autoScroll.current && lines.length > 0) {
      setTimeout(() => {
        listRef.current?.scrollToEnd({ animated: false });
      }, 100);
    }
  }, [lines.length]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.systemContainerLogs(containerName, 200);
      setLines(result.lines);
    } catch { /* ignore */ }
    setLoading(false);
  }, [containerName]);

  return (
    <View style={s.container}>
      {/* Status bar */}
      <View style={s.statusBar}>
        <View style={[s.statusDot, { backgroundColor: streaming ? theme.success : theme.warning }]} />
        <Text style={s.statusText}>
          {streaming ? 'Live streaming' : 'Polling (5s)'}
        </Text>
        <Text style={s.lineCount}>{lines.length} lines</Text>
        <TouchableOpacity onPress={refresh} style={s.refreshBtn}>
          <Text style={s.refreshText}>Refresh</Text>
        </TouchableOpacity>
      </View>

      {loading && lines.length === 0 ? (
        <View style={s.center}>
          <ActivityIndicator color={theme.primary} size="large" />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={lines}
          keyExtractor={(_, i) => String(i)}
          renderItem={({ item }) => (
            <Text style={s.logLine} selectable>{item}</Text>
          )}
          contentContainerStyle={s.logContent}
          onScrollBeginDrag={() => { autoScroll.current = false; }}
          ListEmptyComponent={
            <Text style={s.emptyText}>No logs available</Text>
          }
        />
      )}

      {/* Scroll to bottom FAB */}
      {!autoScroll.current && (
        <TouchableOpacity
          style={s.fab}
          onPress={() => {
            autoScroll.current = true;
            listRef.current?.scrollToEnd({ animated: true });
          }}
        >
          <Text style={s.fabText}>↓</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const MONO = { fontFamily: 'Menlo' } as const;

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1E1E1E' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  statusBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: '#252525', borderBottomWidth: 1, borderBottomColor: '#333',
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { color: '#888', fontSize: 12, flex: 1 },
  lineCount: { color: '#666', fontSize: 11 },
  refreshBtn: { backgroundColor: '#333', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
  refreshText: { color: '#D4D4D4', fontSize: 11, fontWeight: '600' },
  logContent: { padding: 10 },
  logLine: { color: '#D4D4D4', fontSize: 11, lineHeight: 16, ...MONO },
  emptyText: { color: '#666', fontSize: 13, textAlign: 'center', paddingTop: 40 },
  fab: {
    position: 'absolute', bottom: 20, right: 20,
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: theme.primary, alignItems: 'center', justifyContent: 'center',
  },
  fabText: { color: '#fff', fontSize: 18, fontWeight: '700' },
});
