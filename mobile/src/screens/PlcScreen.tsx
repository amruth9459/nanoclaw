/**
 * PLC — site check-in dashboard with crew roster and daily reports
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  StyleSheet, ActivityIndicator, Alert, RefreshControl,
} from 'react-native';
import { api, theme } from '../api/client';

interface Site {
  site_id: string;
  site_name: string;
  manager_jid: string;
  manager_name?: string;
}

interface Report {
  id: string;
  date: string;
  site_id: string;
  status: string;
  confirmed_at?: string;
  crew_count?: number;
  notes?: string;
  compilation_result?: string;
}

interface RosterEntry {
  site_id: string;
  role: string;
  name: string;
  count?: number;
  phone?: string;
}

type CheckInAction = 'same' | 'off' | 'edit';

interface SiteState {
  action: CheckInAction | null;
  editCount: string;
  submitted: boolean;
}

const REPORT_STATUS_COLOR: Record<string, string> = {
  pending: theme.warning,
  confirmed: theme.success,
  compiled: '#3b82f6',
  error: theme.error,
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function SiteCard({
  site,
  report,
  roster,
}: {
  site: Site;
  report?: Report;
  roster: RosterEntry[];
}) {
  const [state, setState] = useState<SiteState>({
    action: null,
    editCount: roster.length > 0 ? String(roster.reduce((s, r) => s + (r.count ?? 1), 0)) : '',
    submitted: false,
  });
  const [submitting, setSubmitting] = useState(false);

  const siteRoster = roster.filter((r) => r.site_id === site.site_id);
  const totalCrew = siteRoster.reduce((s, r) => s + (r.count ?? 1), 0);

  const statusColor = report
    ? REPORT_STATUS_COLOR[report.status] ?? theme.textTertiary
    : theme.warning;
  const statusLabel = report ? report.status : 'pending';

  const handleAction = useCallback(async (action: CheckInAction) => {
    if (action === 'edit') {
      setState((p) => ({ ...p, action: 'edit', editCount: String(totalCrew) }));
      return;
    }
    setState((p) => ({ ...p, action }));
    setSubmitting(true);
    try {
      await new Promise((r) => setTimeout(r, 600));
      setState((p) => ({ ...p, submitted: true }));
      Alert.alert(
        'Check-in recorded',
        action === 'same'
          ? `${site.site_name}: Crew same as yesterday (${totalCrew})`
          : `${site.site_name}: Crew off today`,
      );
    } catch (e) {
      Alert.alert('Error', String(e));
      setState((p) => ({ ...p, action: null }));
    } finally {
      setSubmitting(false);
    }
  }, [site, totalCrew]);

  const submitEdit = useCallback(async () => {
    const count = parseInt(state.editCount, 10);
    if (isNaN(count) || count < 0) {
      Alert.alert('Invalid', 'Enter a valid crew count');
      return;
    }
    setSubmitting(true);
    try {
      await new Promise((r) => setTimeout(r, 600));
      setState((p) => ({ ...p, submitted: true }));
      Alert.alert('Check-in recorded', `${site.site_name}: ${count} crew members today`);
    } catch (e) {
      Alert.alert('Error', String(e));
    } finally {
      setSubmitting(false);
    }
  }, [site, state.editCount]);

  return (
    <View style={sc.card}>
      {/* Header */}
      <View style={sc.header}>
        <View style={sc.titleWrap}>
          <Text style={sc.siteName}>{site.site_name}</Text>
          {site.manager_name && (
            <Text style={sc.manager}>Manager: {site.manager_name}</Text>
          )}
        </View>
        <View style={[sc.statusBadge, { backgroundColor: statusColor + '15', borderColor: statusColor + '44' }]}>
          <View style={[sc.statusDot, { backgroundColor: statusColor }]} />
          <Text style={[sc.statusText, { color: statusColor }]}>{statusLabel}</Text>
        </View>
      </View>

      {/* Report meta */}
      {report && (
        <View style={sc.reportRow}>
          {report.confirmed_at && (
            <Text style={sc.reportMeta}>✓ Confirmed at {formatTime(report.confirmed_at)}</Text>
          )}
          {report.crew_count != null && (
            <Text style={sc.reportMeta}>👷 {report.crew_count} crew</Text>
          )}
        </View>
      )}

      {/* Roster */}
      {siteRoster.length > 0 && (
        <View style={sc.rosterWrap}>
          <Text style={sc.rosterTitle}>Today's Roster</Text>
          {siteRoster.map((r, i) => (
            <View key={i} style={sc.rosterRow}>
              <Text style={sc.rosterRole}>{r.role}</Text>
              <Text style={sc.rosterName}>{r.name}</Text>
              {r.count != null && <Text style={sc.rosterCount}>×{r.count}</Text>}
            </View>
          ))}
          <View style={sc.rosterTotal}>
            <Text style={sc.rosterTotalText}>Total: {totalCrew} workers</Text>
          </View>
        </View>
      )}

      {/* Compilation result */}
      {report?.compilation_result && (
        <View style={sc.compilationBox}>
          <Text style={sc.compilationLabel}>📊 Compiled Report</Text>
          <Text style={sc.compilationText} numberOfLines={3}>
            {report.compilation_result}
          </Text>
        </View>
      )}

      {/* Check-in actions */}
      {!state.submitted ? (
        <View style={sc.actions}>
          <Text style={sc.actionsLabel}>Today's check-in</Text>
          {state.action === 'edit' ? (
            <View style={sc.editRow}>
              <Text style={sc.editLabel}>Crew count:</Text>
              <TextInput
                style={sc.editInput}
                value={state.editCount}
                onChangeText={(v) => setState((p) => ({ ...p, editCount: v }))}
                keyboardType="number-pad"
                maxLength={3}
                selectTextOnFocus
              />
              <TouchableOpacity
                style={[sc.actionBtn, sc.editConfirmBtn]}
                onPress={submitEdit}
                disabled={submitting}
              >
                {submitting
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Text style={sc.actionBtnText}>Submit</Text>}
              </TouchableOpacity>
              <TouchableOpacity
                style={sc.cancelBtn}
                onPress={() => setState((p) => ({ ...p, action: null }))}
              >
                <Text style={sc.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={sc.btnRow}>
              <TouchableOpacity
                style={[sc.actionBtn, sc.sameBtn, state.action === 'same' && sc.actionSelected]}
                onPress={() => handleAction('same')}
                disabled={submitting}
                activeOpacity={0.7}
              >
                {submitting && state.action === 'same'
                  ? <ActivityIndicator size="small" color={theme.success} />
                  : <Text style={sc.sameBtnText}>👍 Same</Text>}
              </TouchableOpacity>
              <TouchableOpacity
                style={[sc.actionBtn, sc.offBtn, state.action === 'off' && sc.actionSelected]}
                onPress={() => handleAction('off')}
                disabled={submitting}
                activeOpacity={0.7}
              >
                {submitting && state.action === 'off'
                  ? <ActivityIndicator size="small" color={theme.error} />
                  : <Text style={sc.offBtnText}>❌ Off</Text>}
              </TouchableOpacity>
              <TouchableOpacity
                style={[sc.actionBtn, sc.editBtn]}
                onPress={() => handleAction('edit')}
                disabled={submitting}
                activeOpacity={0.7}
              >
                <Text style={sc.editBtnText}>✏️ Edit</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      ) : (
        <View style={sc.submittedRow}>
          <Text style={sc.submittedText}>✅ Check-in recorded</Text>
          <TouchableOpacity onPress={() => setState((p) => ({ ...p, submitted: false, action: null }))}>
            <Text style={sc.undoText}>Undo</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const sc = StyleSheet.create({
  card: {
    backgroundColor: theme.bgInput, borderRadius: 14, padding: 16,
    borderWidth: 1, borderColor: theme.border, marginBottom: 12,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8 },
  titleWrap: { flex: 1, marginRight: 10 },
  siteName: { color: theme.textPrimary, fontSize: 17, fontWeight: '700' },
  manager: { color: theme.textSecondary, fontSize: 12, marginTop: 2 },
  statusBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 99, borderWidth: 1,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  reportRow: { flexDirection: 'row', gap: 12, marginBottom: 10 },
  reportMeta: { color: theme.textSecondary, fontSize: 12 },
  rosterWrap: {
    backgroundColor: theme.bgSecondary, borderRadius: 8, padding: 10,
    marginBottom: 12, borderWidth: 1, borderColor: theme.border,
  },
  rosterTitle: { color: theme.textSecondary, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  rosterRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 3, gap: 6 },
  rosterRole: { color: theme.textSecondary, fontSize: 12, width: 80 },
  rosterName: { color: theme.textPrimary, fontSize: 13, flex: 1 },
  rosterCount: { color: theme.primary, fontSize: 12, fontWeight: '600' },
  rosterTotal: { borderTopWidth: 1, borderTopColor: theme.border, marginTop: 4, paddingTop: 4 },
  rosterTotalText: { color: theme.textSecondary, fontSize: 12, fontWeight: '600', textAlign: 'right' },
  compilationBox: {
    backgroundColor: '#eff6ff', borderRadius: 8, padding: 10,
    marginBottom: 12, borderWidth: 1, borderColor: '#93c5fd44',
  },
  compilationLabel: { color: '#3b82f6', fontSize: 11, fontWeight: '600', marginBottom: 4 },
  compilationText: { color: '#1e40af', fontSize: 12, lineHeight: 18 },
  actions: { marginTop: 4 },
  actionsLabel: { color: theme.textTertiary, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  btnRow: { flexDirection: 'row', gap: 8 },
  actionBtn: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', borderWidth: 1 },
  actionSelected: { opacity: 0.6 },
  sameBtn: { backgroundColor: '#f0fdf4', borderColor: theme.success },
  sameBtnText: { color: theme.success, fontSize: 13, fontWeight: '600' },
  offBtn: { backgroundColor: '#fef2f2', borderColor: '#f87171' },
  offBtnText: { color: '#f87171', fontSize: 13, fontWeight: '600' },
  editBtn: { backgroundColor: theme.bgSecondary, borderColor: theme.border },
  editBtnText: { color: theme.textSecondary, fontSize: 13, fontWeight: '600' },
  editRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  editLabel: { color: theme.textSecondary, fontSize: 13 },
  editInput: {
    width: 70, backgroundColor: theme.bg, borderWidth: 1, borderColor: theme.primary,
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7,
    color: theme.textPrimary, fontSize: 16, textAlign: 'center',
  },
  editConfirmBtn: { flex: 1, backgroundColor: theme.primary, borderColor: theme.primary },
  actionBtnText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  cancelBtn: { paddingHorizontal: 8 },
  cancelBtnText: { color: theme.textTertiary, fontSize: 13 },
  submittedRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 8, marginTop: 4,
  },
  submittedText: { color: theme.success, fontSize: 13, fontWeight: '600' },
  undoText: { color: theme.textTertiary, fontSize: 12 },
});

// ── Main screen ───────────────────────────────────────────────────────────────

export function PlcScreen() {
  const [sites, setSites] = useState<Site[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const today = new Date().toISOString().split('T')[0];

  const load = useCallback(async () => {
    const [s, r, ros] = await Promise.all([
      api.plcSites(),
      api.plcReports(today),
      api.plcRoster(),
    ]);
    setSites(s.sites as Site[]);
    setReports(r.reports as Report[]);
    setRoster(ros.roster as RosterEntry[]);
    setError(null);
  }, [today]);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load().catch((e: Error) => setError(e.message)).finally(() => setRefreshing(false));
  }, [load]);

  if (loading) {
    return <View style={ps.center}><ActivityIndicator color={theme.primary} size="large" /></View>;
  }

  if (error) {
    return (
      <View style={ps.center}>
        <Text style={ps.error}>{error}</Text>
        <TouchableOpacity style={ps.retryBtn} onPress={() => { setLoading(true); load().finally(() => setLoading(false)); }}>
          <Text style={ps.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const pending = sites.filter((s) => !reports.find((r) => r.site_id === s.site_id));
  const confirmed = sites.filter((s) => reports.find((r) => r.site_id === s.site_id && r.status === 'confirmed'));

  return (
    <ScrollView
      style={ps.container}
      contentContainerStyle={ps.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} />}
    >
      {/* Summary banner */}
      <View style={ps.summary}>
        <View style={ps.summaryItem}>
          <Text style={ps.summaryNum}>{sites.length}</Text>
          <Text style={ps.summaryLabel}>Sites</Text>
        </View>
        <View style={ps.summarySep} />
        <View style={ps.summaryItem}>
          <Text style={[ps.summaryNum, { color: theme.success }]}>{confirmed.length}</Text>
          <Text style={ps.summaryLabel}>Confirmed</Text>
        </View>
        <View style={ps.summarySep} />
        <View style={ps.summaryItem}>
          <Text style={[ps.summaryNum, { color: theme.warning }]}>{pending.length}</Text>
          <Text style={ps.summaryLabel}>Pending</Text>
        </View>
      </View>

      <Text style={ps.dateHeader}>{new Date(today).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</Text>

      {/* Priority: pending sites first */}
      {[...pending, ...sites.filter((s) => !pending.includes(s))].map((site) => (
        <SiteCard
          key={site.site_id}
          site={site}
          report={reports.find((r) => r.site_id === site.site_id)}
          roster={roster}
        />
      ))}

      {sites.length === 0 && (
        <View style={ps.emptyWrap}>
          <Text style={ps.emptyTitle}>No sites configured</Text>
          <Text style={ps.emptyHint}>Set up PLC sites in NanoClaw</Text>
        </View>
      )}
    </ScrollView>
  );
}

const ps = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 16, paddingBottom: 32 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bg, padding: 24 },
  error: { color: theme.error, fontSize: 14, textAlign: 'center', marginBottom: 12 },
  retryBtn: { backgroundColor: theme.bgSecondary, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  retryText: { color: theme.textPrimary, fontSize: 14 },
  summary: {
    flexDirection: 'row', backgroundColor: theme.bgInput, borderRadius: 12,
    borderWidth: 1, borderColor: theme.border, padding: 16, marginBottom: 16,
  },
  summaryItem: { flex: 1, alignItems: 'center' },
  summaryNum: { color: theme.textPrimary, fontSize: 24, fontWeight: '700' },
  summaryLabel: { color: theme.textSecondary, fontSize: 12, marginTop: 2 },
  summarySep: { width: 1, backgroundColor: theme.border, marginHorizontal: 8 },
  dateHeader: {
    color: theme.textSecondary, fontSize: 12, fontWeight: '600',
    textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12,
  },
  emptyWrap: { flex: 1, alignItems: 'center', paddingTop: 60 },
  emptyTitle: { color: theme.textSecondary, fontSize: 16, fontWeight: '600', marginBottom: 6 },
  emptyHint: { color: theme.textTertiary, fontSize: 13 },
});
