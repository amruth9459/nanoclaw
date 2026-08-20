import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Text } from 'react-native';
import { theme } from '../api/client';

import { ChatScreen } from '../screens/ChatScreen';
import { ChatDetailScreen } from '../screens/ChatDetailScreen';
import { TerminalScreen } from '../screens/TerminalScreen';
import { InteractiveTerminalScreen } from '../screens/InteractiveTerminalScreen';
import { CommandOutputScreen } from '../screens/CommandOutputScreen';
import { SystemDashboardScreen } from '../screens/SystemDashboardScreen';
import { ContainerLogsScreen } from '../screens/ContainerLogsScreen';
import { FileBrowserScreen } from '../screens/FileBrowserScreen';
import { FileViewerScreen } from '../screens/FileViewerScreen';
import { FileEditorScreen } from '../screens/FileEditorScreen';
import { MoreMenuScreen } from '../screens/MoreMenuScreen';
import { TasksScreen } from '../screens/TasksScreen';
import { PlcScreen } from '../screens/PlcScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { SecuritySettingsScreen } from '../screens/SecuritySettingsScreen';

// ── Param lists ──────────────────────────────────────────────────────────────

export type ChatStackParamList = {
  Groups: undefined;
  ChatDetail: { jid: string; name: string; folder: string };
};

export type TerminalStackParamList = {
  Terminal: undefined;
  InteractiveTerminal: { sessionName: string };
  CommandOutput: { command: string; output: string; exitCode: number; duration: number; success: boolean };
};

export type SystemStackParamList = {
  SystemDashboard: undefined;
  ContainerLogs: { containerName: string };
};

export type FilesStackParamList = {
  FileBrowser: { path?: string };
  FileViewer: { path: string; name: string; size: number };
  FileEditor: { path: string; name: string; content: string };
};

export type MoreStackParamList = {
  MoreMenu: undefined;
  Tasks: undefined;
  PLC: undefined;
  Settings: undefined;
  SecuritySettings: undefined;
};

// ── Stack navigators ─────────────────────────────────────────────────────────

const ChatStackNav = createNativeStackNavigator<ChatStackParamList>();
const TerminalStackNav = createNativeStackNavigator<TerminalStackParamList>();
const SystemStackNav = createNativeStackNavigator<SystemStackParamList>();
const FilesStackNav = createNativeStackNavigator<FilesStackParamList>();
const MoreStackNav = createNativeStackNavigator<MoreStackParamList>();
const Tab = createBottomTabNavigator();

const stackScreenOptions = {
  headerStyle: { backgroundColor: theme.bg },
  headerTintColor: theme.textPrimary,
  headerBackTitleVisible: false,
  contentStyle: { backgroundColor: theme.bg },
  headerShadowVisible: false,
} as const;

function TabIcon({ icon, focused }: { icon: string; focused: boolean }) {
  return <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.4 }}>{icon}</Text>;
}

// ── Chat ─────────────────────────────────────────────────────────────────────

function ChatNavigator() {
  return (
    <ChatStackNav.Navigator screenOptions={stackScreenOptions}>
      <ChatStackNav.Screen name="Groups" component={ChatScreen} options={{ title: 'Claw' }} />
      <ChatStackNav.Screen
        name="ChatDetail"
        component={ChatDetailScreen}
        options={({ route }) => ({ title: route.params.name })}
      />
    </ChatStackNav.Navigator>
  );
}

// ── Terminal ─────────────────────────────────────────────────────────────────

function TerminalNavigator() {
  return (
    <TerminalStackNav.Navigator screenOptions={stackScreenOptions}>
      <TerminalStackNav.Screen name="Terminal" component={TerminalScreen} />
      <TerminalStackNav.Screen
        name="InteractiveTerminal"
        component={InteractiveTerminalScreen}
        options={{ title: 'Terminal', headerStyle: { backgroundColor: '#181825' }, headerTintColor: '#cdd6f4' }}
      />
      <TerminalStackNav.Screen name="CommandOutput" component={CommandOutputScreen} options={{ title: 'Output' }} />
    </TerminalStackNav.Navigator>
  );
}

// ── System ───────────────────────────────────────────────────────────────────

function SystemNavigator() {
  return (
    <SystemStackNav.Navigator screenOptions={stackScreenOptions}>
      <SystemStackNav.Screen name="SystemDashboard" component={SystemDashboardScreen} options={{ title: 'System' }} />
      <SystemStackNav.Screen
        name="ContainerLogs"
        component={ContainerLogsScreen}
        options={({ route }) => ({ title: `${route.params.containerName} logs` })}
      />
    </SystemStackNav.Navigator>
  );
}

// ── Files ────────────────────────────────────────────────────────────────────

function FilesNavigator() {
  return (
    <FilesStackNav.Navigator screenOptions={stackScreenOptions}>
      <FilesStackNav.Screen name="FileBrowser" component={FileBrowserScreen} options={{ title: 'Files' }} />
      <FilesStackNav.Screen
        name="FileViewer"
        component={FileViewerScreen}
        options={({ route }) => ({ title: route.params.name })}
      />
      <FilesStackNav.Screen
        name="FileEditor"
        component={FileEditorScreen}
        options={({ route }) => ({ title: `Edit: ${route.params.name}` })}
      />
    </FilesStackNav.Navigator>
  );
}

// ── More ─────────────────────────────────────────────────────────────────────

function MoreNavigator() {
  return (
    <MoreStackNav.Navigator screenOptions={stackScreenOptions}>
      <MoreStackNav.Screen name="MoreMenu" component={MoreMenuScreen} options={{ title: 'More' }} />
      <MoreStackNav.Screen name="Tasks" component={TasksScreen} />
      <MoreStackNav.Screen name="PLC" component={PlcScreen} />
      <MoreStackNav.Screen name="Settings" component={SettingsScreen} />
      <MoreStackNav.Screen name="SecuritySettings" component={SecuritySettingsScreen} options={{ title: 'Security' }} />
    </MoreStackNav.Navigator>
  );
}

// ── Tab navigator ─────────────────────────────────────────────────────────────

export function TabNavigator() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: theme.bg },
        headerTintColor: theme.textPrimary,
        headerShadowVisible: false,
        tabBarStyle: {
          backgroundColor: theme.bg,
          borderTopColor: theme.border,
          borderTopWidth: 1,
        },
        tabBarActiveTintColor: theme.primary,
        tabBarInactiveTintColor: theme.textTertiary,
      }}
    >
      <Tab.Screen
        name="Chat"
        component={ChatNavigator}
        options={{
          headerShown: false,
          tabBarIcon: ({ focused }) => <TabIcon icon="💬" focused={focused} />,
        }}
      />
      <Tab.Screen
        name="TerminalTab"
        component={TerminalNavigator}
        options={{
          headerShown: false,
          title: 'Terminal',
          tabBarIcon: ({ focused }) => <TabIcon icon="⌨️" focused={focused} />,
        }}
      />
      <Tab.Screen
        name="SystemTab"
        component={SystemNavigator}
        options={{
          headerShown: false,
          title: 'System',
          tabBarIcon: ({ focused }) => <TabIcon icon="📊" focused={focused} />,
        }}
      />
      <Tab.Screen
        name="FilesTab"
        component={FilesNavigator}
        options={{
          headerShown: false,
          title: 'Files',
          tabBarIcon: ({ focused }) => <TabIcon icon="📁" focused={focused} />,
        }}
      />
      <Tab.Screen
        name="MoreTab"
        component={MoreNavigator}
        options={{
          headerShown: false,
          title: 'More',
          tabBarIcon: ({ focused }) => <TabIcon icon="⋯" focused={focused} />,
        }}
      />
    </Tab.Navigator>
  );
}
