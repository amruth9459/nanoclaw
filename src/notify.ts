import { DESKTOP_NOTIFY_JID, LEXIOS_NOTIFY_JID } from './config.js';

export type NotifyTopic = 'desktop' | 'lexios' | 'deploy' | 'general';

export function getNotifyJid(topic: NotifyTopic, mainJid: string): string {
  switch (topic) {
    case 'desktop': return DESKTOP_NOTIFY_JID || mainJid;
    case 'lexios': return LEXIOS_NOTIFY_JID || mainJid;
    default: return mainJid;
  }
}
