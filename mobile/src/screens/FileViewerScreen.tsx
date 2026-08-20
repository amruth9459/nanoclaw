/**
 * FileViewer — monospace text with line numbers + edit button
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, ActivityIndicator,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/core';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { api, theme } from '../api/client';
import type { FilesStackParamList } from '../navigation/TabNavigator';

type NavProp = NativeStackNavigationProp<FilesStackParamList, 'FileViewer'>;
type RouteParams = RouteProp<FilesStackParamList, 'FileViewer'>;

function formatSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function FileViewerScreen() {
  const nav = useNavigation<NavProp>();
  const { params } = useRoute<RouteParams>();
  const { path: filePath, name, size } = params;

  const [content, setContent] = useState('');
  const [totalLines, setTotalLines] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const PAGE_SIZE = 500;

  const load = useCallback(async (off: number) => {
    try {
      const result = await api.filesRead(filePath, off, PAGE_SIZE);
      setContent(result.content);
      setTotalLines(result.totalLines);
      setOffset(off);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [filePath]);

  useEffect(() => {
    load(0).finally(() => setLoading(false));
  }, [load]);

  const lines = content.split('\n');

  if (loading) {
    return <View style={s.center}><ActivityIndicator color={theme.primary} size="large" /></View>;
  }

  if (error) {
    return (
      <View style={s.center}>
        <Text style={s.error}>{error}</Text>
      </View>
    );
  }

  return (
    <View style={s.container}>
      {/* Header */}
      <View style={s.header}>
        <View style={s.headerInfo}>
          <Text style={s.headerSize}>{formatSize(size)}</Text>
          <Text style={s.headerLines}>{totalLines} lines</Text>
        </View>
        <TouchableOpacity
          style={s.editBtn}
          onPress={() => nav.navigate('FileEditor', { path: filePath, name, content })}
        >
          <Text style={s.editBtnText}>Edit</Text>
        </TouchableOpacity>
      </View>

      {/* Pagination */}
      {totalLines > PAGE_SIZE && (
        <View style={s.pagination}>
          <TouchableOpacity
            style={[s.pageBtn, offset === 0 && s.pageBtnDisabled]}
            disabled={offset === 0}
            onPress={() => load(Math.max(0, offset - PAGE_SIZE))}
          >
            <Text style={s.pageBtnText}>← Prev</Text>
          </TouchableOpacity>
          <Text style={s.pageInfo}>Lines {offset + 1}-{Math.min(offset + PAGE_SIZE, totalLines)}</Text>
          <TouchableOpacity
            style={[s.pageBtn, offset + PAGE_SIZE >= totalLines && s.pageBtnDisabled]}
            disabled={offset + PAGE_SIZE >= totalLines}
            onPress={() => load(offset + PAGE_SIZE)}
          >
            <Text style={s.pageBtnText}>Next →</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Content */}
      <ScrollView style={s.scroll} horizontal>
        <ScrollView>
          <View style={s.codeWrap}>
            {lines.map((line, i) => (
              <View key={i} style={s.codeLine}>
                <Text style={s.lineNum}>{offset + i + 1}</Text>
                <Text style={s.lineText} selectable>{line}</Text>
              </View>
            ))}
          </View>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

const MONO = { fontFamily: 'Menlo' } as const;

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1E1E1E' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1E1E1E' },
  error: { color: theme.error, fontSize: 14 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 10,
    backgroundColor: '#252525', borderBottomWidth: 1, borderBottomColor: '#333',
  },
  headerInfo: { flexDirection: 'row', gap: 12 },
  headerSize: { color: '#888', fontSize: 12 },
  headerLines: { color: '#888', fontSize: 12 },
  editBtn: {
    backgroundColor: theme.primary, borderRadius: 6,
    paddingHorizontal: 14, paddingVertical: 6,
  },
  editBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  pagination: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 6, backgroundColor: '#252525',
    borderBottomWidth: 1, borderBottomColor: '#333',
  },
  pageBtn: { paddingHorizontal: 10, paddingVertical: 4 },
  pageBtnDisabled: { opacity: 0.3 },
  pageBtnText: { color: theme.primary, fontSize: 12, fontWeight: '600' },
  pageInfo: { color: '#666', fontSize: 11 },
  scroll: { flex: 1 },
  codeWrap: { padding: 10 },
  codeLine: { flexDirection: 'row', minHeight: 18 },
  lineNum: {
    color: '#555', fontSize: 11, width: 40, textAlign: 'right',
    marginRight: 12, ...MONO,
  },
  lineText: { color: '#D4D4D4', fontSize: 12, ...MONO, flexShrink: 1 },
});
