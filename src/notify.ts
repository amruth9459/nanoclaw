import { DESKTOP_NOTIFY_JID } from './config.js';
import { getIntegrations } from './integration-loader.js';

export type NotifyTopic = string;

export function getNotifyJid(topic: NotifyTopic, mainJid: string): string {
  // Core topics
  if (topic === 'desktop') return DESKTOP_NOTIFY_JID || mainJid;

  // Integration-provided topics
  for (const integration of getIntegrations()) {
    if (integration.notifyTopics?.[topic]) {
      return integration.notifyTopics[topic];
    }
  }

  return mainJid;
}
