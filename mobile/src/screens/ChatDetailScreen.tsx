/**
 * ChatDetailScreen — rich real-time chat with Claw
 * Supports: code blocks, thinking, tool use, quick-reply chips, approval cards
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, FlatList, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, KeyboardAvoidingView,
  Platform, Alert, Pressable, Vibration,
} from 'react-native';
import { useRoute, type RouteProp } from '@react-navigation/core';
import { api, Message, connectWebSocket, WsEvent, theme } from '../api/client';
import type { ChatStackParamList } from '../navigation/TabNavigator';

type RouteP = RouteProp<ChatStackParamList, 'ChatDetail'>;

// ── Content parser ──────────────────────────────────────────────────────────────

type Block =
  | { type: 'text'; text: string }
  | { type: 'code'; lang: string; code: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; content: string };

function parseContent(raw: string): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  let textStart = 0;

  const flush = (end: number) => {
    const t = raw.slice(textStart, end);
    if (t.trim()) blocks.push({ type: 'text', text: t.trim() });
  };

  while (i < raw.length) {
    // Code block: ```lang\ncode\n```
    if (raw.startsWith('```', i)) {
      flush(i);
      const nlIdx = raw.indexOf('\n', i + 3);
      if (nlIdx === -1) { i++; continue; }
      const lang = raw.slice(i + 3, nlIdx).trim();
      const closeIdx = raw.indexOf('\n```', nlIdx);
      if (closeIdx === -1) { i++; continue; }
      blocks.push({ type: 'code', lang, code: raw.slice(nlIdx + 1, closeIdx) });
      i = closeIdx + 4;
      textStart = i;
      continue;
    }

    // Thinking block
    if (raw.startsWith('<thinking>', i)) {
      flush(i);
      const close = raw.indexOf('</thinking>', i + 10);
      if (close === -1) { i++; continue; }
      const inner = raw.slice(i + 10, close).trim();
      if (inner) blocks.push({ type: 'thinking', text: inner });
      i = close + 11;
      textStart = i;
      continue;
    }

    // Tool use block
    if (raw.startsWith('<tool_use>', i)) {
      flush(i);
      const close = raw.indexOf('</tool_use>', i + 10);
      if (close === -1) { i++; continue; }
      blocks.push({ type: 'tool', content: raw.slice(i + 10, close).trim() });
      i = close + 11;
      textStart = i;
      continue;
    }

    i++;
  }
  flush(raw.length);
  return blocks;
}

// Detect quick-reply buttons: numbered/bulleted list at the end of a message
function extractButtons(text: string): string[] | null {
  const lines = text.trimEnd().split('\n');
  const buttons: string[] = [];
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) {
    const m = lines[i].match(/^(?:\d+[.)]\s+|[-*•]\s+)(.+)$/);
    if (m) {
      buttons.unshift(m[1].replace(/\*\*/g, '').trim());
    } else if (buttons.length > 0) {
      break;
    }
  }
  return buttons.length >= 2 && buttons.length <= 6 ? buttons : null;
}

// ── Collapsible card ──────────────────────────────────────────────────────────

function CollapsibleCard({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={cc.wrap}>
      <TouchableOpacity style={cc.header} onPress={() => setOpen(!open)} activeOpacity={0.7}>
        <Text style={cc.label}>{label}</Text>
        <Text style={cc.chevron}>{open ? '▲' : '▼'}</Text>
      </TouchableOpacity>
      {open && <View style={cc.body}>{children}</View>}
    </View>
  );
}

const cc = StyleSheet.create({
  wrap: {
    borderWidth: 1, borderColor: theme.border, borderRadius: 8,
    marginVertical: 4, overflow: 'hidden',
  },
  header: {
    flexDirection: 'row', justifyContent: 'space-between',
    padding: 8, backgroundColor: theme.bgSecondary,
  },
  label: { color: theme.textSecondary, fontSize: 12, fontWeight: '500' },
  chevron: { color: theme.textTertiary, fontSize: 10 },
  body: { padding: 8, backgroundColor: theme.bgSecondary },
});

// ── Message bubble ────────────────────────────────────────────────────────────

function MessageBubble({ msg, onSendReply }: { msg: Message; onSendReply: (text: string) => void }) {
  const isBot = msg.is_bot_message === 1;
  const isMe = msg.is_from_me === 1;
  const blocks = parseContent(msg.content);

  const lastText = [...blocks].reverse().find((b) => b.type === 'text') as
    | { type: 'text'; text: string }
    | undefined;
  const buttons = isBot && lastText ? extractButtons(lastText.text) : null;
  const isApproval =
    isBot &&
    /\b(approve|reject|confirm|deny)\b/i.test(msg.content) &&
    msg.content.length < 800;

  return (
    <View style={[mb.wrapper, isBot || !isMe ? mb.wrapperLeft : mb.wrapperRight]}>
      {/* Sender label for non-me, non-bot */}
      {!isMe && !isBot && (
        <Text style={mb.senderName}>{msg.sender_name}</Text>
      )}

      <Pressable
        style={[
          mb.bubble,
          isBot ? mb.bubbleBot : isMe ? mb.bubbleMe : mb.bubbleOther,
        ]}
        onLongPress={() => {
          Vibration.vibrate(50);
          Alert.alert(
            'Message options',
            msg.content.length > 200 ? msg.content.slice(0, 200) + '…' : msg.content,
            [{ text: 'Dismiss', style: 'cancel' }],
          );
        }}
      >
        {blocks.map((block, idx) => {
          if (block.type === 'thinking') {
            return (
              <CollapsibleCard key={idx} label="💭 Thinking">
                <Text style={mb.thinkingText}>{block.text}</Text>
              </CollapsibleCard>
            );
          }
          if (block.type === 'code') {
            return (
              <View key={idx} style={mb.codeBlock}>
                {block.lang ? (
                  <Text style={mb.codeLang}>{block.lang}</Text>
                ) : null}
                <Text style={mb.codeText} selectable>{block.code}</Text>
              </View>
            );
          }
          if (block.type === 'tool') {
            return (
              <CollapsibleCard key={idx} label="🔧 Tool use">
                <Text style={mb.toolText} selectable>{block.content}</Text>
              </CollapsibleCard>
            );
          }
          // text block
          return (
            <Text key={idx} style={[mb.text, isMe && !isBot ? mb.textMe : mb.textOther]}>
              {block.text}
            </Text>
          );
        })}
      </Pressable>

      {/* Timestamp */}
      <Text style={[mb.ts, isMe && !isBot ? mb.tsRight : mb.tsLeft]}>
        {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        {isMe ? ' ✓' : ''}
      </Text>

      {/* Approval card */}
      {isApproval && (
        <View style={mb.approvalRow}>
          <TouchableOpacity
            style={mb.approveBtn}
            onPress={() => { Vibration.vibrate(30); onSendReply('Approved'); }}
            activeOpacity={0.8}
          >
            <Text style={mb.approveTxt}>✅ Approve</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={mb.rejectBtn}
            onPress={() => { Vibration.vibrate(30); onSendReply('Rejected'); }}
            activeOpacity={0.8}
          >
            <Text style={mb.rejectTxt}>❌ Reject</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Quick-reply chips */}
      {!isApproval && buttons && (
        <View style={mb.chips}>
          {buttons.map((btn, i) => (
            <TouchableOpacity
              key={i}
              style={mb.chip}
              onPress={() => { Vibration.vibrate(20); onSendReply(btn); }}
              activeOpacity={0.7}
            >
              <Text style={mb.chipText}>{btn}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

const mb = StyleSheet.create({
  wrapper: { marginVertical: 3, maxWidth: '85%' },
  wrapperLeft: { alignSelf: 'flex-start', marginLeft: 12 },
  wrapperRight: { alignSelf: 'flex-end', marginRight: 12 },
  senderName: { color: theme.primary, fontSize: 11, fontWeight: '600', marginBottom: 2, marginLeft: 4 },
  bubble: { borderRadius: 18, padding: 10, paddingHorizontal: 14 },
  bubbleBot: {
    backgroundColor: theme.bubbleBot, borderWidth: 1, borderColor: theme.border,
    borderTopLeftRadius: 4,
  },
  bubbleMe: { backgroundColor: theme.bubbleUser, borderTopRightRadius: 4 },
  bubbleOther: { backgroundColor: theme.bgSecondary, borderTopLeftRadius: 4 },
  text: { fontSize: 15, lineHeight: 22 },
  textOther: { color: theme.textPrimary },
  textMe: { color: '#FFFFFF' },
  thinkingText: {
    color: theme.textSecondary, fontSize: 13, fontStyle: 'italic', lineHeight: 19,
  },
  toolText: {
    color: '#7dd3fc', fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', lineHeight: 18,
  },
  codeBlock: {
    backgroundColor: '#1E1E1E', borderRadius: 8, padding: 10, marginVertical: 4,
  },
  codeLang: { color: '#9C958E', fontSize: 10, textTransform: 'uppercase', marginBottom: 6 },
  codeText: {
    color: '#D4D4D4', fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', lineHeight: 19,
  },
  ts: { fontSize: 10, marginTop: 3 },
  tsLeft: { color: theme.textTertiary, marginLeft: 6 },
  tsRight: { color: theme.textTertiary, textAlign: 'right', marginRight: 6 },
  approvalRow: { flexDirection: 'row', gap: 8, marginTop: 8, marginLeft: 4 },
  approveBtn: {
    flex: 1, backgroundColor: '#f0fdf4', borderWidth: 1, borderColor: '#10b981',
    borderRadius: 12, paddingVertical: 10, alignItems: 'center',
  },
  approveTxt: { color: '#10b981', fontSize: 13, fontWeight: '600' },
  rejectBtn: {
    flex: 1, backgroundColor: '#fef2f2', borderWidth: 1, borderColor: '#f87171',
    borderRadius: 12, paddingVertical: 10, alignItems: 'center',
  },
  rejectTxt: { color: '#f87171', fontSize: 13, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8, marginLeft: 4 },
  chip: {
    backgroundColor: theme.bgSecondary, borderWidth: 1, borderColor: theme.primary + '44',
    borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7,
  },
  chipText: { color: theme.primary, fontSize: 13 },
});

// ── Main screen ───────────────────────────────────────────────────────────────

export function ChatDetailScreen() {
  const route = useRoute<RouteP>();
  const { jid } = route.params;

  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [typing, setTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Newest-first for inverted FlatList
  const sortDesc = (msgs: Message[]) =>
    [...msgs].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const load = useCallback(async () => {
    const { messages: msgs, total } = await api.messages(jid, 50);
    setMessages(sortDesc(msgs));
    setHasMore(msgs.length < total);
    setError(null);
  }, [jid]);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message)).finally(() => setLoading(false));

    const disconnect = connectWebSocket((evt: WsEvent) => {
      if (evt.event === 'new_message' && evt.data.jid === jid) {
        const newMsg = evt.data.message;
        setMessages((prev) => {
          if (prev.find((m) => m.id === newMsg.id)) return prev;
          return sortDesc([newMsg, ...prev]);
        });
        setTyping(false);
        if (typingTimer.current) clearTimeout(typingTimer.current);
      }
      if (evt.event === 'container_event' && evt.data.jid === jid) {
        setTyping(true);
        if (typingTimer.current) clearTimeout(typingTimer.current);
        typingTimer.current = setTimeout(() => setTyping(false), 15000);
      }
    });

    return () => {
      disconnect();
      if (typingTimer.current) clearTimeout(typingTimer.current);
    };
  }, [jid, load]);

  // Load older messages — FIX: use timestamp instead of id for pagination
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || messages.length === 0) return;
    setLoadingMore(true);
    const oldest = messages[messages.length - 1];
    try {
      const { messages: older } = await api.messages(jid, 50, oldest.timestamp);
      if (!older.length) {
        setHasMore(false);
        return;
      }
      setMessages((prev) => {
        const ids = new Set(prev.map((m) => m.id));
        return sortDesc([...prev, ...older.filter((m) => !ids.has(m.id))]);
      });
    } finally {
      setLoadingMore(false);
    }
  }, [jid, messages, loadingMore, hasMore]);

  const send = useCallback(async (msgText: string) => {
    const trimmed = msgText.trim();
    if (!trimmed) return;
    setSending(true);
    setText('');
    try {
      await api.sendMessage(jid, trimmed);
      const optimistic: Message = {
        id: `opt_${Date.now()}`,
        chat_jid: jid,
        sender: 'me',
        sender_name: 'Me',
        content: trimmed,
        timestamp: new Date().toISOString(),
        is_from_me: 1,
        is_bot_message: 0,
        media_type: null,
      };
      setMessages((prev) => [optimistic, ...prev]);
    } catch (e) {
      Alert.alert('Send failed', String(e));
      setText(trimmed);
    } finally {
      setSending(false);
    }
  }, [jid]);

  if (loading) {
    return <View style={ds.center}><ActivityIndicator color={theme.primary} size="large" /></View>;
  }

  if (error) {
    return (
      <View style={ds.center}>
        <Text style={{ color: theme.error, fontSize: 14, textAlign: 'center', marginBottom: 12 }}>{error}</Text>
        <TouchableOpacity
          style={{ backgroundColor: theme.bgSecondary, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 }}
          onPress={() => { setLoading(true); setError(null); load().catch((e: Error) => setError(e.message)).finally(() => setLoading(false)); }}
        >
          <Text style={{ color: theme.textPrimary, fontSize: 14 }}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={ds.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={96}
    >
      <FlatList
        data={messages}
        keyExtractor={(m) => m.id}
        inverted
        renderItem={({ item }) => <MessageBubble msg={item} onSendReply={send} />}
        contentContainerStyle={ds.listContent}
        onEndReached={loadMore}
        onEndReachedThreshold={0.3}
        ListHeaderComponent={
          typing ? (
            <View style={ds.typingWrap}>
              <View style={ds.typingBubble}>
                <Text style={ds.typingDot}>●</Text>
                <Text style={ds.typingDot}>●</Text>
                <Text style={ds.typingDot}>●</Text>
              </View>
            </View>
          ) : null
        }
        ListFooterComponent={
          loadingMore ? (
            <ActivityIndicator color={theme.primary} style={ds.loadingMore} />
          ) : !hasMore ? (
            <Text style={ds.beginningText}>— beginning of conversation —</Text>
          ) : null
        }
        ListEmptyComponent={
          <View style={ds.emptyWrap}>
            <Text style={ds.emptyTitle}>No messages yet</Text>
            <Text style={ds.emptyHint}>Send a message to start</Text>
          </View>
        }
      />

      {/* Input bar */}
      <View style={ds.inputBar}>
        <TouchableOpacity
          style={ds.attachBtn}
          onPress={() => Alert.alert('Attachment', 'File/image support coming soon')}
        >
          <Text style={ds.attachIcon}>📎</Text>
        </TouchableOpacity>
        <TextInput
          style={ds.input}
          value={text}
          onChangeText={setText}
          placeholder="Message Claw…"
          placeholderTextColor={theme.textTertiary}
          multiline
          maxLength={4000}
          returnKeyType="default"
        />
        <TouchableOpacity
          style={[ds.sendBtn, (!text.trim() || sending) && ds.sendBtnOff]}
          onPress={() => send(text)}
          disabled={!text.trim() || sending}
          activeOpacity={0.8}
        >
          {sending
            ? <ActivityIndicator size="small" color="#fff" />
            : <Text style={ds.sendIcon}>↑</Text>}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const ds = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bg },
  listContent: { paddingVertical: 8 },
  typingWrap: { alignSelf: 'flex-start', marginLeft: 16, marginBottom: 8 },
  typingBubble: {
    flexDirection: 'row', gap: 4,
    backgroundColor: theme.bubbleBot, borderRadius: 16, borderTopLeftRadius: 4,
    borderWidth: 1, borderColor: theme.border,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  typingDot: { color: theme.primary, fontSize: 14 },
  loadingMore: { marginVertical: 16 },
  beginningText: { color: theme.textTertiary, fontSize: 12, textAlign: 'center', marginVertical: 16 },
  emptyWrap: { flex: 1, alignItems: 'center', paddingTop: 80 },
  emptyTitle: { color: theme.textSecondary, fontSize: 16, fontWeight: '600', marginBottom: 6 },
  emptyHint: { color: theme.textTertiary, fontSize: 13 },
  inputBar: {
    flexDirection: 'row', alignItems: 'flex-end',
    backgroundColor: theme.bg,
    borderTopWidth: 1, borderTopColor: theme.border,
    paddingHorizontal: 12, paddingVertical: 8, gap: 8,
  },
  attachBtn: { paddingBottom: 8 },
  attachIcon: { fontSize: 22 },
  input: {
    flex: 1, backgroundColor: theme.bgInput,
    borderRadius: 22, borderWidth: 1, borderColor: theme.border,
    paddingHorizontal: 16, paddingVertical: 9,
    color: theme.textPrimary, fontSize: 15, maxHeight: 120,
  },
  sendBtn: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: theme.primary, alignItems: 'center', justifyContent: 'center',
  },
  sendBtnOff: { backgroundColor: theme.bgSecondary },
  sendIcon: { color: '#fff', fontSize: 19, fontWeight: '800', marginTop: -1 },
});
