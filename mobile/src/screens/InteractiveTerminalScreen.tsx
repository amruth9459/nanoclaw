/**
 * InteractiveTerminalScreen — persistent tmux terminal via xterm.js in a WebView.
 *
 * Attaches to the tmux session name passed via route params.
 * WebSocket carries bidirectional terminal I/O.
 */
import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Modal, FlatList,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useRoute, RouteProp } from '@react-navigation/native';
import { api, getConnectionConfig } from '../api/client';
import { requireElevation, hasPin, savePin } from '../security/auth';
import type { TerminalStackParamList } from '../navigation/TabNavigator';

const TERMINAL_PRESETS = [
  { label: 'Status', cmd: 'launchctl list | grep nanoclaw\n' },
  { label: 'Logs (tail)', cmd: 'tail -30 ~/nanoclaw/logs/nanoclaw.log\n' },
  { label: 'Disk', cmd: 'df -h /\n' },
  { label: 'Docker ps', cmd: 'docker ps\n' },
  { label: 'Tailscale', cmd: 'tailscale status\n' },
  { label: 'htop', cmd: 'htop\n' },
  { label: 'Git status', cmd: 'cd ~/nanoclaw && git status\n' },
  { label: 'Free memory', cmd: 'vm_stat | head -10\n' },
];

function buildTerminalHtml(wsUrl: string, securityToken: string, sessionName: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js"><\/script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #1e1e2e; }
  #terminal { width: 100%; height: 100%; }
  #status {
    position: fixed; top: 0; left: 0; right: 0; height: 24px; z-index: 10;
    background: #181825; color: #6c7086; font: 11px/24px monospace;
    text-align: center; display: none;
  }
  #status.visible { display: block; }
  #status.connected { color: #a6e3a1; }
  #status.error { color: #f38ba8; }
</style>
</head>
<body>
<div id="status"></div>
<div id="terminal"></div>
<script>
(function() {
  var wsUrl = ${JSON.stringify(wsUrl)};
  var securityToken = ${JSON.stringify(securityToken)};
  var sessionName = ${JSON.stringify(sessionName)};
  var term = new window.Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, monospace',
    theme: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      selectionBackground: '#585b7066',
      black: '#45475a',
      red: '#f38ba8',
      green: '#a6e3a1',
      yellow: '#f9e2af',
      blue: '#89b4fa',
      magenta: '#f5c2e7',
      cyan: '#94e2d5',
      white: '#bac2de',
      brightBlack: '#585b70',
      brightRed: '#f38ba8',
      brightGreen: '#a6e3a1',
      brightYellow: '#f9e2af',
      brightBlue: '#89b4fa',
      brightMagenta: '#f5c2e7',
      brightCyan: '#94e2d5',
      brightWhite: '#a6adc8',
    },
    allowProposedApi: true,
  });

  var fitAddon = new window.FitAddon.FitAddon();
  var webLinksAddon = new window.WebLinksAddon.WebLinksAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);
  term.open(document.getElementById('terminal'));
  fitAddon.fit();

  var statusEl = document.getElementById('status');
  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'visible ' + (cls || '');
    if (cls === 'connected') {
      setTimeout(function() { statusEl.className = ''; }, 2000);
    }
  }

  var ws = null;
  var reconnectTimer = null;
  var started = false;

  function connect() {
    setStatus('Connecting...', '');
    ws = new WebSocket(wsUrl);

    ws.onopen = function() {
      setStatus('Connected — ' + sessionName, 'connected');
      ws.send(JSON.stringify({
        type: 'start_terminal',
        securityToken: securityToken,
        sessionName: sessionName,
        cols: term.cols,
        rows: term.rows,
      }));
      started = true;
    };

    ws.onmessage = function(e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg.event === 'terminal_output' && msg.data && msg.data.data) {
          term.write(msg.data.data);
        } else if (msg.event === 'terminal_exit') {
          setStatus('Session ended', 'error');
          started = false;
        } else if (msg.event === 'terminal_error') {
          setStatus('Error: ' + (msg.data && msg.data.error || 'unknown'), 'error');
        }
      } catch(ex) {}
    };

    ws.onclose = function() {
      setStatus('Disconnected — reconnecting...', 'error');
      started = false;
      reconnectTimer = setTimeout(connect, 3000);
    };

    ws.onerror = function() {
      ws.close();
    };
  }

  term.onData(function(data) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'terminal_input', data: data }));
    }
  });

  term.onResize(function(size) {
    if (ws && ws.readyState === 1 && started) {
      ws.send(JSON.stringify({ type: 'terminal_resize', cols: size.cols, rows: size.rows }));
    }
  });

  window.addEventListener('resize', function() { fitAddon.fit(); });

  window.addEventListener('message', function(e) {
    try {
      var msg = JSON.parse(e.data);
      if (msg.type === 'inject_command' && msg.command && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'terminal_input', data: msg.command }));
      }
    } catch(ex) {}
  });
  document.addEventListener('message', function(e) {
    try {
      var msg = JSON.parse(e.data);
      if (msg.type === 'inject_command' && msg.command && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'terminal_input', data: msg.command }));
      }
    } catch(ex) {}
  });

  connect();
})();
<\/script>
</body>
</html>`;
}

export function InteractiveTerminalScreen() {
  const route = useRoute<RouteProp<TerminalStackParamList, 'InteractiveTerminal'>>();
  const sessionName = route.params?.sessionName ?? 'claw-mobile';
  const webViewRef = useRef<WebView>(null);
  const [securityToken, setSecurityToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsPin, setNeedsPin] = useState(false);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [presetsVisible, setPresetsVisible] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        // Only try requireElevation if PIN is already stored on device
        const pinStored = await hasPin();
        if (pinStored) {
          const token = await requireElevation();
          if (token) {
            setSecurityToken(token);
            setLoading(false);
            return;
          }
        }
        // No PIN stored or elevation failed — show inline PIN entry
        setNeedsPin(true);
      } catch {
        setNeedsPin(true);
      }
      setLoading(false);
    })();
  }, []);

  const submitPin = useCallback(async () => {
    if (!pin.trim()) return;
    setPinError('');
    try {
      const result = await api.securityElevate(pin.trim());
      if (result.ok && result.token) {
        // Save PIN to device for future auto-elevation
        await savePin(pin.trim());
        setSecurityToken(result.token);
        setNeedsPin(false);
      } else {
        setPinError(result.error || 'Invalid PIN');
      }
    } catch (err) {
      setPinError(String(err));
    }
  }, [pin]);

  const injectCommand = useCallback((cmd: string) => {
    setPresetsVisible(false);
    webViewRef.current?.postMessage(JSON.stringify({ type: 'inject_command', command: cmd }));
  }, []);

  if (loading) {
    return (
      <View style={s.center}>
        <Text style={s.loadingText}>Authenticating...</Text>
      </View>
    );
  }

  if (needsPin && !securityToken) {
    return (
      <View style={s.center}>
        <Text style={s.pinTitle}>Enter PIN</Text>
        <Text style={s.pinSub}>Security elevation required for terminal access</Text>
        <TextInput
          style={s.pinInput}
          value={pin}
          onChangeText={setPin}
          placeholder="PIN"
          placeholderTextColor="#585b70"
          secureTextEntry
          keyboardType="number-pad"
          autoFocus
          returnKeyType="go"
          onSubmitEditing={submitPin}
        />
        {pinError ? <Text style={s.pinError}>{pinError}</Text> : null}
        <TouchableOpacity style={s.pinBtn} onPress={submitPin}>
          <Text style={s.pinBtnText}>Unlock</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!securityToken) {
    return (
      <View style={s.center}>
        <Text style={s.errorText}>Authentication required</Text>
        <Text style={s.subText}>Security elevation was denied or PIN not configured.</Text>
      </View>
    );
  }

  const { wsUrl } = getConnectionConfig();
  const html = buildTerminalHtml(wsUrl, securityToken, sessionName);

  return (
    <View style={s.container}>
      <View style={s.toolbar}>
        <View style={s.toolbarLeft}>
          <Text style={s.toolbarTitle}>Terminal</Text>
          <Text style={s.toolbarSub}>tmux: {sessionName}</Text>
        </View>
        <TouchableOpacity style={s.presetsBtn} onPress={() => setPresetsVisible(true)}>
          <Text style={s.presetsBtnText}>Presets</Text>
        </TouchableOpacity>
      </View>

      <WebView
        ref={webViewRef}
        originWhitelist={['*']}
        source={{ html }}
        style={s.webview}
        javaScriptEnabled
        domStorageEnabled
        keyboardDisplayRequiresUserAction={false}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        allowsInlineMediaPlayback
        mixedContentMode="compatibility"
        onError={(e) => console.warn('WebView error', e.nativeEvent)}
      />

      <Modal visible={presetsVisible} animationType="slide" transparent>
        <View style={s.modalOverlay}>
          <View style={s.modalContent}>
            <View style={s.modalHeader}>
              <Text style={s.modalTitle}>Quick Commands</Text>
              <TouchableOpacity onPress={() => setPresetsVisible(false)}>
                <Text style={s.modalClose}>Done</Text>
              </TouchableOpacity>
            </View>
            <FlatList
              data={TERMINAL_PRESETS}
              keyExtractor={(item) => item.label}
              renderItem={({ item }) => (
                <TouchableOpacity style={s.presetItem} onPress={() => injectCommand(item.cmd)}>
                  <Text style={s.presetLabel}>{item.label}</Text>
                  <Text style={s.presetCmd} numberOfLines={1}>{item.cmd.trim()}</Text>
                </TouchableOpacity>
              )}
              contentContainerStyle={{ paddingBottom: 20 }}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1e1e2e' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1e1e2e' },
  loadingText: { color: '#cdd6f4', fontSize: 16 },
  pinTitle: { color: '#cdd6f4', fontSize: 20, fontWeight: '700', marginBottom: 8 },
  pinSub: { color: '#6c7086', fontSize: 13, marginBottom: 24, textAlign: 'center', paddingHorizontal: 40 },
  pinInput: {
    width: 200, backgroundColor: '#313244', borderRadius: 12,
    color: '#cdd6f4', fontSize: 24, fontWeight: '600', textAlign: 'center',
    paddingVertical: 14, letterSpacing: 8, marginBottom: 12,
  },
  pinError: { color: '#f38ba8', fontSize: 13, marginBottom: 12 },
  pinBtn: {
    backgroundColor: '#89b4fa', borderRadius: 10,
    paddingHorizontal: 40, paddingVertical: 12,
  },
  pinBtnText: { color: '#1e1e2e', fontSize: 15, fontWeight: '700' },
  errorText: { color: '#f38ba8', fontSize: 16, fontWeight: '600', marginBottom: 8 },
  subText: { color: '#6c7086', fontSize: 13, textAlign: 'center', paddingHorizontal: 40 },
  toolbar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: '#181825', borderBottomWidth: 1, borderBottomColor: '#313244',
  },
  toolbarLeft: { flexDirection: 'column' },
  toolbarTitle: { color: '#cdd6f4', fontSize: 15, fontWeight: '600' },
  toolbarSub: { color: '#6c7086', fontSize: 11, fontFamily: 'Menlo' },
  presetsBtn: {
    backgroundColor: '#313244', borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 6,
  },
  presetsBtnText: { color: '#cdd6f4', fontSize: 13, fontWeight: '500' },
  webview: { flex: 1, backgroundColor: '#1e1e2e' },
  modalOverlay: {
    flex: 1, justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  modalContent: {
    backgroundColor: '#1e1e2e', borderTopLeftRadius: 16, borderTopRightRadius: 16,
    maxHeight: '60%', paddingTop: 8,
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#313244',
  },
  modalTitle: { color: '#cdd6f4', fontSize: 16, fontWeight: '600' },
  modalClose: { color: '#89b4fa', fontSize: 14, fontWeight: '600' },
  presetItem: {
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#31324433',
  },
  presetLabel: { color: '#cdd6f4', fontSize: 14, fontWeight: '500', marginBottom: 2 },
  presetCmd: { color: '#6c7086', fontSize: 12, fontFamily: 'Menlo' },
});
