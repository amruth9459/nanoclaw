/**
 * FileEditor — full-screen multiline editor with security elevation on save
 */
import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Alert, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/core';
import { RouteProp } from '@react-navigation/native';
import { api, theme } from '../api/client';
import { requireElevation } from '../security/auth';
import type { FilesStackParamList } from '../navigation/TabNavigator';

type RouteParams = RouteProp<FilesStackParamList, 'FileEditor'>;

export function FileEditorScreen() {
  const nav = useNavigation();
  const { params } = useRoute<RouteParams>();
  const { path: filePath, name, content: initialContent } = params;

  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const hasChanges = content !== initialContent;

  const save = async () => {
    const token = await requireElevation();
    if (!token) return;

    setSaving(true);
    try {
      await api.filesWrite(filePath, content, token);
      Alert.alert('Saved', `${name} saved successfully (backup created as .bak)`);
      nav.goBack();
    } catch (e) {
      Alert.alert('Save Failed', String(e));
    } finally {
      setSaving(false);
    }
  };

  const confirmDiscard = () => {
    if (!hasChanges) { nav.goBack(); return; }
    Alert.alert(
      'Discard Changes?',
      'You have unsaved changes.',
      [
        { text: 'Keep Editing', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => nav.goBack() },
      ],
    );
  };

  return (
    <KeyboardAvoidingView
      style={s.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={100}
    >
      {/* Toolbar */}
      <View style={s.toolbar}>
        <TouchableOpacity onPress={confirmDiscard} style={s.cancelBtn}>
          <Text style={s.cancelText}>Cancel</Text>
        </TouchableOpacity>
        <View style={s.toolbarCenter}>
          <Text style={s.fileName} numberOfLines={1}>{name}</Text>
          {hasChanges && <Text style={s.modified}>Modified</Text>}
        </View>
        <TouchableOpacity
          style={[s.saveBtn, (!hasChanges || saving) && s.saveBtnDisabled]}
          onPress={save}
          disabled={!hasChanges || saving}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={s.saveBtnText}>Save</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Editor */}
      <TextInput
        style={s.editor}
        value={content}
        onChangeText={setContent}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        textAlignVertical="top"
        scrollEnabled
      />
    </KeyboardAvoidingView>
  );
}

const MONO = { fontFamily: 'Menlo' } as const;

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1E1E1E' },
  toolbar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: '#252525', borderBottomWidth: 1, borderBottomColor: '#333',
  },
  cancelBtn: { paddingHorizontal: 8 },
  cancelText: { color: '#888', fontSize: 14 },
  toolbarCenter: { flex: 1, alignItems: 'center' },
  fileName: { color: '#D4D4D4', fontSize: 13, fontWeight: '600' },
  modified: { color: theme.warning, fontSize: 10, marginTop: 2 },
  saveBtn: {
    backgroundColor: theme.primary, borderRadius: 6,
    paddingHorizontal: 16, paddingVertical: 7,
  },
  saveBtnDisabled: { opacity: 0.4 },
  saveBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  editor: {
    flex: 1, color: '#D4D4D4', fontSize: 13, lineHeight: 20, ...MONO,
    padding: 14, backgroundColor: '#1E1E1E',
  },
});
