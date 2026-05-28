import { Channel, NewMessage } from './types.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map((m) => {
    let content = escapeXml(m.content);

    // If there's media, add metadata about it
    if (m.media_type && m.media_path) {
      const mediaPath = m.media_path.replace(/^.*\/media\//, '/workspace/media/');
      let mediaInfo = `[${m.media_type}: ${mediaPath}]`;
      // For videos, include keyframe paths so the agent can view the video content
      if (m.media_type === 'video') {
        const frames: string[] = [];
        for (let i = 0; i < 4; i++) {
          const frameName = `${mediaPath}.frame${i}.jpg`;
          frames.push(frameName);
        }
        mediaInfo += ` [keyframes: ${frames.join(', ')}]`;
        // Also include audio transcription file if it exists
        mediaInfo += ` [audio transcript: ${mediaPath}.audio.ogg.txt]`;
      }
      content = content ? `${mediaInfo} ${content}` : mediaInfo;
    }

    return `<message id="${escapeXml(m.id)}" sender="${escapeXml(m.sender_name)}" sender_jid="${escapeXml(m.sender)}" time="${m.timestamp}">${content}</message>`;
  });
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

// Zero-width and similar invisible characters. Agents sometimes emit U+200B
// alone as a "silent finish" signal — naive .trim() doesn't strip these, so
// the orchestrator was sending "Claw: ​" (just the prefix + ZWS) as actual
// WhatsApp messages.
const INVISIBLE_CHARS = /[\u200B\u200C\u200D\u2060\uFEFF\u00AD]/g;

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText)
    .replace(INVISIBLE_CHARS, '')
    .trim();
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
