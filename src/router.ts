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

// Infrastructure/API errors that the Claude Code CLI or SDK surfaces as the
// agent's OUTPUT TEXT (not an exception) when quota/auth/capacity fails. These
// must never reach a user's WhatsApp group — they're operator concerns, already
// captured in task_run_logs. Anchored at start + length-capped so a genuine
// message that merely *mentions* an error (e.g. a user asking "what does 401
// mean?") is not suppressed.
const INFRA_ERROR_PATTERNS: RegExp[] = [
  /^(claw:\s*)?you'?ve hit your (usage )?limit\b/i,
  /^(claw:\s*)?failed to authenticate\b/i,
  /^(claw:\s*)?api error:?\s*\d{3}\b/i,
  /^(claw:\s*)?(request )?(overloaded|rate.?limit(ed)?)\b/i,
  /^(claw:\s*)?\{?"?type"?:?\s*"?error"?/i,
  /^(claw:\s*)?(your )?(organization|account) does not have access to claude\b/i,
  /^(claw:\s*)?(claude ai )?usage limit reached\b/i,
];

export function isInfraError(text: string): boolean {
  const t = text.trim();
  if (t.length > 300) return false; // real content that mentions an error is longer
  return INFRA_ERROR_PATTERNS.some((re) => re.test(t));
}

// Agents receive a periodic safety-pulse reminder injected into their stream and
// tend to append an acknowledgment block to their final answer, e.g.
//   "Evening report sent for July 9th. Now acknowledging the safety reminder:
//    **Safety constraints acknowledged:** ..."
// The lead-in phrase reliably marks where the boilerplate begins; strip from
// there to the end. Root-cause fix lives in the container safety-pulse text
// ("do not acknowledge in output"); this is the belt for already-running images.
// Match only the unambiguous boilerplate lead-ins the agent uses to echo the
// injected pulse — either "acknowledging the safety reminder" (the pulse is
// literally titled "SAFETY REMINDER") or the "**Safety constraints acknowledged:**"
// block header. Deliberately does NOT match generic phrases like "safety
// constraints are enforced" so a nightly security-review report is never truncated.
const SAFETY_ACK_TAIL =
  /\s*((now )?acknowledg\w+ (the )?safety reminder|\*{0,2}safety constraints? (acknowledged|noted)\b)[\s\S]*$/i;

export function stripSafetyAckTail(text: string): string {
  return text.replace(SAFETY_ACK_TAIL, '').trim();
}

export function formatOutbound(rawText: string): string {
  let text = stripInternalTags(rawText)
    .replace(INVISIBLE_CHARS, '')
    .trim();
  text = stripSafetyAckTail(text);
  if (!text) return '';
  if (isInfraError(text)) return ''; // drop — never surface infra errors to users
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
