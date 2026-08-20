/**
 * Chat — group list with last message preview
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity,
  StyleSheet, ActivityIndicator, RefreshControl,
} from 'react-native';
import { useNavigation } from '@react-navigation/core';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { api, Group, Message, theme } from '../api/client';
import type { ChatStackParamList } from '../navigation/TabNavigator';

type NavProp = NativeStackNavigationProp<ChatStackParamList, 'Groups'>;

interface GroupWithPreview extends Group {
  lastMessage?: Message;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function ChatScreen() {
  const nav = useNavigation<NavProp>();
  const [groups, setGroups] = useState<GroupWithPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const gs = await api.groups();
    const withPreviews = await Promise.all(
      gs.map(async (g) => {
        try {
          const { messages } = await api.messages(g.jid, 1);
          return { ...g, lastMessage: messages[0] };
        } catch {
          return g as GroupWithPreview;
        }
      }),
    );
    setGroups(withPreviews);
    setError(null);
  }, []);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load().catch((e: Error) => setError(e.message)).finally(() => setRefreshing(false));
  }, [load]);

  if (loading) {
    return <View style={s.center}><ActivityIndicator color={theme.primary} size="large" /></View>;
  }

  if (error) {
    return (
      <View style={s.center}>
        <Text style={s.error}>{error}</Text>
        <TouchableOpacity style={s.retryBtn} onPress={() => {
          setLoading(true);
          load().catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
        }}>
          <Text style={s.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={s.container}>
      <FlatList
        data={groups}
        keyExtractor={(g) => g.jid}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} />
        }
        renderItem={({ item }) => {
          const displayName = item.displayName ?? item.name;
          const preview = item.lastMessage?.content ?? 'Tap to open chat';
          const isBot = item.lastMessage?.is_bot_message === 1;
          const time = item.lastMessage ? formatTime(item.lastMessage.timestamp) : '';

          return (
            <TouchableOpacity
              style={s.row}
              activeOpacity={0.7}
              onPress={() =>
                nav.navigate('ChatDetail', {
                  jid: item.jid,
                  name: displayName,
                  folder: item.folder,
                })
              }
            >
              <View style={s.avatar}>
                <Text style={s.avatarText}>{displayName.slice(0, 1).toUpperCase()}</Text>
              </View>
              <View style={s.info}>
                <View style={s.nameRow}>
                  <Text style={s.name} numberOfLines={1}>{displayName}</Text>
                  {time ? <Text style={s.time}>{time}</Text> : null}
                </View>
                <Text style={[s.preview, isBot && s.previewBot]} numberOfLines={1}>
                  {isBot ? '🤖 ' : ''}{preview.replace(/\n+/g, ' ')}
                </Text>
              </View>
              <Text style={s.chevron}>›</Text>
            </TouchableOpacity>
          );
        }}
        ItemSeparatorComponent={() => <View style={s.sep} />}
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={s.emptyTitle}>No groups yet</Text>
            <Text style={s.emptyHint}>Add groups in NanoClaw settings</Text>
          </View>
        }
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  center: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    backgroundColor: theme.bg, padding: 24,
  },
  error: { color: theme.error, fontSize: 14, textAlign: 'center', marginBottom: 12 },
  retryBtn: { backgroundColor: theme.bgSecondary, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  retryText: { color: theme.textPrimary, fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, gap: 12 },
  avatar: {
    width: 50, height: 50, borderRadius: 25,
    backgroundColor: theme.primary, alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: '#FFFFFF', fontSize: 20, fontWeight: '700' },
  info: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 },
  name: { color: theme.textPrimary, fontSize: 16, fontWeight: '600', flex: 1, marginRight: 8 },
  time: { color: theme.textTertiary, fontSize: 12 },
  preview: { color: theme.textSecondary, fontSize: 13 },
  previewBot: { color: theme.textTertiary },
  chevron: { color: theme.border, fontSize: 22, marginLeft: 4 },
  sep: { height: 1, backgroundColor: theme.border, marginLeft: 78 },
  empty: { flex: 1, alignItems: 'center', paddingTop: 80 },
  emptyTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: '600', marginBottom: 6 },
  emptyHint: { color: theme.textSecondary, fontSize: 14 },
});
