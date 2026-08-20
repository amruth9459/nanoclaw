/**
 * FileBrowser — directory browser with breadcrumb navigation
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, FlatList, ScrollView, TouchableOpacity,
  StyleSheet, ActivityIndicator, RefreshControl,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/core';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { api, FileEntry, theme } from '../api/client';
import type { FilesStackParamList } from '../navigation/TabNavigator';

type NavProp = NativeStackNavigationProp<FilesStackParamList, 'FileBrowser'>;
type RouteParams = RouteProp<FilesStackParamList, 'FileBrowser'>;

function formatSize(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function fileIcon(entry: FileEntry): string {
  if (entry.type === 'directory') return '📁';
  if (entry.type === 'symlink') return '🔗';
  const ext = entry.name.split('.').pop()?.toLowerCase() || '';
  const icons: Record<string, string> = {
    ts: '🟦', tsx: '🟦', js: '🟨', jsx: '🟨', json: '📋',
    md: '📝', txt: '📄', py: '🐍', sh: '⚙️', yml: '⚙️', yaml: '⚙️',
    png: '🖼️', jpg: '🖼️', svg: '🖼️', gif: '🖼️',
    log: '📜', env: '🔐', lock: '🔒',
  };
  return icons[ext] || '📄';
}

export function FileBrowserScreen() {
  const nav = useNavigation<NavProp>();
  const route = useRoute<RouteParams>();
  const [currentPath, setCurrentPath] = useState(route.params?.path || '');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (dirPath?: string) => {
    try {
      const result = await api.filesList(dirPath || undefined);
      setCurrentPath(result.path);
      setEntries(result.entries);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    load(route.params?.path).finally(() => setLoading(false));
  }, [load, route.params?.path]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load(currentPath).finally(() => setRefreshing(false));
  }, [load, currentPath]);

  const navigateToDir = useCallback((dirPath: string) => {
    setLoading(true);
    load(dirPath).finally(() => setLoading(false));
  }, [load]);

  const openFile = useCallback((entry: FileEntry) => {
    const fullPath = currentPath + '/' + entry.name;
    if (entry.type === 'directory') {
      navigateToDir(fullPath);
    } else {
      nav.navigate('FileViewer', { path: fullPath, name: entry.name, size: entry.size });
    }
  }, [currentPath, nav, navigateToDir]);

  // Breadcrumb segments
  const segments = currentPath.split('/').filter(Boolean);

  if (loading && entries.length === 0) {
    return <View style={s.center}><ActivityIndicator color={theme.primary} size="large" /></View>;
  }

  return (
    <View style={s.container}>
      {/* Breadcrumb */}
      <ScrollView horizontal style={s.breadcrumb} showsHorizontalScrollIndicator={false}>
        <TouchableOpacity onPress={() => navigateToDir('/')} style={s.breadcrumbSeg}>
          <Text style={s.breadcrumbText}>/</Text>
        </TouchableOpacity>
        {segments.map((seg, i) => {
          const segPath = '/' + segments.slice(0, i + 1).join('/');
          const isLast = i === segments.length - 1;
          return (
            <React.Fragment key={segPath}>
              <Text style={s.breadcrumbSep}>/</Text>
              <TouchableOpacity
                onPress={() => { if (!isLast) navigateToDir(segPath); }}
                style={s.breadcrumbSeg}
              >
                <Text style={[s.breadcrumbText, isLast && s.breadcrumbActive]}>{seg}</Text>
              </TouchableOpacity>
            </React.Fragment>
          );
        })}
      </ScrollView>

      {error ? (
        <View style={s.center}>
          <Text style={s.error}>{error}</Text>
          <TouchableOpacity style={s.retryBtn} onPress={() => navigateToDir(currentPath)}>
            <Text style={s.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => item.name}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} />
          }
          renderItem={({ item }) => (
            <TouchableOpacity style={s.row} onPress={() => openFile(item)} activeOpacity={0.7}>
              <Text style={s.icon}>{fileIcon(item)}</Text>
              <View style={s.rowInfo}>
                <Text style={s.fileName} numberOfLines={1}>{item.name}</Text>
                {item.type === 'file' && (
                  <Text style={s.fileMeta}>{formatSize(item.size)}</Text>
                )}
              </View>
              {item.type === 'directory' && <Text style={s.chevron}>›</Text>}
            </TouchableOpacity>
          )}
          ItemSeparatorComponent={() => <View style={s.sep} />}
          ListEmptyComponent={
            <View style={s.emptyWrap}>
              <Text style={s.emptyText}>Empty directory</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bg, padding: 24 },
  error: { color: theme.error, fontSize: 14, textAlign: 'center', marginBottom: 12 },
  retryBtn: { backgroundColor: theme.bgSecondary, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  retryText: { color: theme.textPrimary, fontSize: 14 },
  breadcrumb: {
    flexDirection: 'row', backgroundColor: theme.bgSecondary,
    borderBottomWidth: 1, borderBottomColor: theme.border,
    paddingHorizontal: 12, paddingVertical: 10,
    maxHeight: 44,
  },
  breadcrumbSeg: { paddingHorizontal: 2 },
  breadcrumbText: { color: theme.primary, fontSize: 13, fontWeight: '500' },
  breadcrumbActive: { color: theme.textPrimary, fontWeight: '700' },
  breadcrumbSep: { color: theme.textTertiary, fontSize: 13, marginHorizontal: 2 },
  row: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16,
    paddingVertical: 12, gap: 10,
  },
  icon: { fontSize: 20, width: 28, textAlign: 'center' },
  rowInfo: { flex: 1, minWidth: 0 },
  fileName: { color: theme.textPrimary, fontSize: 14 },
  fileMeta: { color: theme.textTertiary, fontSize: 11, marginTop: 2 },
  chevron: { color: theme.border, fontSize: 20 },
  sep: { height: 1, backgroundColor: theme.border, marginLeft: 54 },
  emptyWrap: { alignItems: 'center', paddingTop: 40 },
  emptyText: { color: theme.textTertiary, fontSize: 14 },
});
