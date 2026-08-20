/**
 * SystemDashboard — CPU/mem/disk stats, service health, active containers
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, ActivityIndicator, RefreshControl,
} from 'react-native';
import { useNavigation, useIsFocused } from '@react-navigation/core';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { api, SystemStats, ContainerInfo, ServiceHealth, theme } from '../api/client';
import type { SystemStackParamList } from '../navigation/TabNavigator';

type NavProp = NativeStackNavigationProp<SystemStackParamList, 'SystemDashboard'>;

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function statColor(pct: number): string {
  if (pct >= 90) return theme.error;
  if (pct >= 70) return theme.warning;
  return theme.success;
}

function StatCard({ label, value, percent, detail }: {
  label: string; value: string; percent: number; detail?: string;
}) {
  return (
    <View style={sc.card}>
      <Text style={sc.label}>{label}</Text>
      <Text style={[sc.value, { color: statColor(percent) }]}>{percent}%</Text>
      <View style={sc.bar}>
        <View style={[sc.barFill, { width: `${Math.min(percent, 100)}%`, backgroundColor: statColor(percent) }]} />
      </View>
      <Text style={sc.detail}>{value}</Text>
      {detail ? <Text style={sc.detail}>{detail}</Text> : null}
    </View>
  );
}

export function SystemDashboardScreen() {
  const nav = useNavigation<NavProp>();
  const isFocused = useIsFocused();
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [services, setServices] = useState<ServiceHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const [st, ct, sv] = await Promise.all([
      api.systemStats().catch(() => null),
      api.systemContainers().catch(() => ({ containers: [] })),
      api.systemServices().catch(() => ({ services: [] })),
    ]);
    setStats(st);
    setContainers(ct.containers);
    setServices(sv.services);
    setError(null);
  }, []);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, [load]);

  // Auto-refresh every 10s while focused
  useEffect(() => {
    if (isFocused) {
      timerRef.current = setInterval(() => { load().catch(() => {}); }, 10000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isFocused, load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load().catch((e: Error) => setError(e.message)).finally(() => setRefreshing(false));
  }, [load]);

  if (loading) {
    return <View style={s.center}><ActivityIndicator color={theme.primary} size="large" /></View>;
  }

  if (error && !stats) {
    return (
      <View style={s.center}>
        <Text style={s.error}>{error}</Text>
        <TouchableOpacity style={s.retryBtn} onPress={() => { setLoading(true); load().finally(() => setLoading(false)); }}>
          <Text style={s.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView
      style={s.container}
      contentContainerStyle={s.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} />}
    >
      {/* Stats row */}
      {stats && (
        <View style={s.statsRow}>
          <StatCard
            label="CPU"
            value={`${stats.cpu.cores} cores`}
            percent={stats.cpu.usagePercent}
            detail={`Load: ${stats.cpu.loadAvg1.toFixed(2)}`}
          />
          <StatCard
            label="Memory"
            value={`${formatBytes(stats.memory.used)} / ${formatBytes(stats.memory.total)}`}
            percent={stats.memory.usagePercent}
          />
          <StatCard
            label="Disk"
            value={`${stats.disk.used || '?'} / ${stats.disk.total || '?'}`}
            percent={stats.disk.usagePercent}
          />
        </View>
      )}

      {/* Uptime */}
      {stats && (
        <View style={s.uptimeRow}>
          <Text style={s.uptimeLabel}>System Uptime</Text>
          <Text style={s.uptimeValue}>{formatUptime(stats.uptime)}</Text>
        </View>
      )}

      {/* Services */}
      <Text style={s.sectionTitle}>Services</Text>
      {services.map((svc) => (
        <View key={svc.name} style={s.serviceRow}>
          <View style={[s.serviceDot, {
            backgroundColor: svc.status === 'running' ? theme.success : svc.status === 'error' ? theme.error : theme.textTertiary,
          }]} />
          <Text style={s.serviceName}>{svc.name}</Text>
          <Text style={[s.serviceStatus, {
            color: svc.status === 'running' ? theme.success : svc.status === 'error' ? theme.error : theme.textTertiary,
          }]}>{svc.status}</Text>
        </View>
      ))}
      {services.length === 0 && <Text style={s.emptyText}>No services detected</Text>}

      {/* Containers */}
      <Text style={s.sectionTitle}>Containers</Text>
      {containers.map((c) => (
        <TouchableOpacity
          key={c.id || c.name}
          style={s.containerCard}
          onPress={() => nav.navigate('ContainerLogs', { containerName: c.name })}
          activeOpacity={0.7}
        >
          <View style={s.containerTop}>
            <Text style={s.containerName} numberOfLines={1}>{c.name}</Text>
            <Text style={[s.containerStatus, {
              color: c.status.toLowerCase().includes('up') ? theme.success : theme.textTertiary,
            }]}>{c.status}</Text>
          </View>
          <Text style={s.containerImage} numberOfLines={1}>{c.image}</Text>
        </TouchableOpacity>
      ))}
      {containers.length === 0 && <Text style={s.emptyText}>No containers running</Text>}
    </ScrollView>
  );
}

const sc = StyleSheet.create({
  card: {
    flex: 1, backgroundColor: theme.bgInput, borderRadius: 12, padding: 12,
    borderWidth: 1, borderColor: theme.border, alignItems: 'center',
  },
  label: { color: theme.textSecondary, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', marginBottom: 4 },
  value: { fontSize: 24, fontWeight: '800', marginBottom: 6 },
  bar: { width: '100%', height: 4, backgroundColor: theme.bgSecondary, borderRadius: 2, marginBottom: 4 },
  barFill: { height: 4, borderRadius: 2 },
  detail: { color: theme.textTertiary, fontSize: 10, textAlign: 'center' },
});

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 16, paddingBottom: 32 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bg, padding: 24 },
  error: { color: theme.error, fontSize: 14, textAlign: 'center', marginBottom: 12 },
  retryBtn: { backgroundColor: theme.bgSecondary, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  retryText: { color: theme.textPrimary, fontSize: 14 },
  statsRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  uptimeRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: theme.bgInput, borderRadius: 10, padding: 12,
    borderWidth: 1, borderColor: theme.border, marginBottom: 16,
  },
  uptimeLabel: { color: theme.textSecondary, fontSize: 13 },
  uptimeValue: { color: theme.textPrimary, fontSize: 15, fontWeight: '700' },
  sectionTitle: {
    color: theme.textSecondary, fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 1, marginTop: 8, marginBottom: 8,
  },
  serviceRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.border,
  },
  serviceDot: { width: 8, height: 8, borderRadius: 4 },
  serviceName: { color: theme.textPrimary, fontSize: 14, flex: 1 },
  serviceStatus: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase' },
  containerCard: {
    backgroundColor: theme.bgInput, borderRadius: 10, padding: 12,
    borderWidth: 1, borderColor: theme.border, marginBottom: 8,
  },
  containerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  containerName: { color: theme.textPrimary, fontSize: 14, fontWeight: '600', flex: 1, marginRight: 8 },
  containerStatus: { fontSize: 11, fontWeight: '600' },
  containerImage: { color: theme.textTertiary, fontSize: 11 },
  emptyText: { color: theme.textTertiary, fontSize: 13, textAlign: 'center', paddingVertical: 16 },
});
