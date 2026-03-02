/**
 * Fieldy (Field Labs Compass) Webhook Integration for NanoClaw
 *
 * Receives real-time transcripts from Fieldy device via webhook,
 * stores them in database, and provides WhatsApp query interface.
 *
 * Webhook endpoint: POST /webhooks/fieldy
 *
 * Expected payload format (adjust based on actual Fieldy webhook):
 * {
 *   "id": "transcript_12345",
 *   "device_id": "device_abc",
 *   "start_time": "2026-03-02T10:30:00Z",
 *   "end_time": "2026-03-02T10:45:00Z",
 *   "duration": 900,
 *   "transcript": "Full transcript text here...",
 *   "language": "en",
 *   "speakers": [
 *     {"speaker": "Speaker 1", "start": 0, "end": 120},
 *     {"speaker": "Speaker 2", "start": 120, "end": 300}
 *   ]
 * }
 */

import { storeTranscript, getTranscript, searchTranscripts, getTranscriptsByDate, getTranscriptStats } from '../db.js';
import { logger } from '../logger.js';

export interface FieldyWebhookPayload {
  id: string;
  device_id?: string;
  start_time: string;
  end_time: string;
  duration: number; // seconds
  transcript: string;
  language?: string;
  speakers?: Array<{
    speaker: string;
    start: number;
    end: number;
  }>;
  metadata?: Record<string, any>;
}

export class FieldyIntegration {
  /**
   * Handle incoming webhook from Fieldy device
   */
  async handleWebhook(payload: FieldyWebhookPayload): Promise<{ success: boolean; message: string }> {
    try {
      // Validate payload
      if (!payload.id || !payload.transcript || !payload.start_time || !payload.end_time) {
        logger.warn({ payload }, 'Invalid Fieldy webhook payload - missing required fields');
        return { success: false, message: 'Missing required fields: id, transcript, start_time, end_time' };
      }

      // Check if transcript already exists (prevent duplicates)
      const existing = getTranscript(payload.id);
      if (existing) {
        logger.info({ transcriptId: payload.id }, 'Fieldy transcript already exists, skipping');
        return { success: true, message: 'Transcript already stored' };
      }

      // Store transcript in database
      storeTranscript({
        id: payload.id,
        source: 'fieldy',
        deviceId: payload.device_id,
        startTime: payload.start_time,
        endTime: payload.end_time,
        durationSeconds: payload.duration,
        text: payload.transcript,
        speakers: payload.speakers,
        language: payload.language,
        metadata: payload.metadata,
      });

      logger.info(
        {
          transcriptId: payload.id,
          duration: payload.duration,
          textLength: payload.transcript.length,
        },
        'Fieldy transcript stored successfully'
      );

      return { success: true, message: `Transcript ${payload.id} stored successfully` };
    } catch (error) {
      logger.error({ error, payload }, 'Error handling Fieldy webhook');
      return {
        success: false,
        message: `Error storing transcript: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Query transcripts via WhatsApp natural language
   *
   * Examples:
   * - "What did I say today?"
   * - "Find conversations about Lexios"
   * - "Show me yesterday's recordings"
   */
  async handleWhatsAppQuery(query: string): Promise<string> {
    try {
      const lowerQuery = query.toLowerCase();

      // Intent: Today's transcripts
      if (lowerQuery.includes('today')) {
        const today = new Date().toISOString().split('T')[0];
        const transcripts = getTranscriptsByDate(today);

        if (transcripts.length === 0) {
          return 'No Fieldy recordings from today yet.';
        }

        const totalDuration = transcripts.reduce((sum, t) => sum + t.durationSeconds, 0);
        const totalMinutes = Math.round(totalDuration / 60);

        let response = `*Fieldy Recordings - Today*\n\n`;
        response += `📊 ${transcripts.length} recording(s), ${totalMinutes} minutes total\n\n`;

        for (const transcript of transcripts.slice(0, 5)) {
          const startTime = new Date(transcript.startTime);
          const timeStr = startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
          const duration = Math.round(transcript.durationSeconds / 60);
          const preview = transcript.text.substring(0, 150) + (transcript.text.length > 150 ? '...' : '');

          response += `*${timeStr}* (${duration} min)\n${preview}\n\n`;
        }

        if (transcripts.length > 5) {
          response += `_...and ${transcripts.length - 5} more recording(s)_`;
        }

        return response;
      }

      // Intent: Yesterday's transcripts
      if (lowerQuery.includes('yesterday')) {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const dateStr = yesterday.toISOString().split('T')[0];
        const transcripts = getTranscriptsByDate(dateStr);

        if (transcripts.length === 0) {
          return 'No Fieldy recordings from yesterday.';
        }

        const totalDuration = transcripts.reduce((sum, t) => sum + t.durationSeconds, 0);
        const totalMinutes = Math.round(totalDuration / 60);

        let response = `*Fieldy Recordings - Yesterday*\n\n`;
        response += `📊 ${transcripts.length} recording(s), ${totalMinutes} minutes total\n\n`;

        for (const transcript of transcripts.slice(0, 5)) {
          const startTime = new Date(transcript.startTime);
          const timeStr = startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
          const duration = Math.round(transcript.durationSeconds / 60);
          const preview = transcript.text.substring(0, 150) + (transcript.text.length > 150 ? '...' : '');

          response += `*${timeStr}* (${duration} min)\n${preview}\n\n`;
        }

        if (transcripts.length > 5) {
          response += `_...and ${transcripts.length - 5} more recording(s)_`;
        }

        return response;
      }

      // Intent: Search transcripts
      if (lowerQuery.includes('find') || lowerQuery.includes('search') || lowerQuery.includes('about')) {
        // Extract search terms
        const searchMatch = query.match(/(?:find|search|about)\s+(.+?)(?:\s+today|\s+yesterday|$)/i);
        const searchQuery = searchMatch ? searchMatch[1].trim() : query;

        const results = searchTranscripts(searchQuery, 10);

        if (results.length === 0) {
          return `No Fieldy recordings found matching "${searchQuery}".`;
        }

        let response = `*Fieldy Search: "${searchQuery}"*\n\n`;
        response += `Found ${results.length} result(s)\n\n`;

        for (const transcript of results.slice(0, 5)) {
          const startTime = new Date(transcript.startTime);
          const dateStr = startTime.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const timeStr = startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
          const duration = Math.round(transcript.durationSeconds / 60);

          // Find snippet with search terms
          const snippet = this.extractSnippet(transcript.text, searchQuery);

          response += `*${dateStr} at ${timeStr}* (${duration} min)\n${snippet}\n\n`;
        }

        if (results.length > 5) {
          response += `_...and ${results.length - 5} more result(s)_`;
        }

        return response;
      }

      // Intent: Stats
      if (lowerQuery.includes('stats') || lowerQuery.includes('summary') || lowerQuery.includes('total')) {
        const stats = getTranscriptStats();

        let response = `*Fieldy Recording Stats*\n\n`;
        response += `📊 Total recordings: ${stats.total}\n`;
        response += `⏱ Total duration: ${stats.totalDurationHours} hours\n\n`;

        if (stats.bySource.fieldy) {
          response += `Fieldy recordings: ${stats.bySource.fieldy}\n`;
        }

        if (stats.oldestTranscript && stats.newestTranscript) {
          const oldest = new Date(stats.oldestTranscript);
          const newest = new Date(stats.newestTranscript);
          response += `\n📅 Date range:\n`;
          response += `Oldest: ${oldest.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}\n`;
          response += `Newest: ${newest.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
        }

        return response;
      }

      // Default: Generic search
      const results = searchTranscripts(query, 5);

      if (results.length === 0) {
        return `No Fieldy recordings found related to your query. Try "fieldy today" or "fieldy stats".`;
      }

      let response = `*Fieldy Recordings*\n\n`;
      for (const transcript of results) {
        const startTime = new Date(transcript.startTime);
        const dateStr = startTime.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const timeStr = startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        const duration = Math.round(transcript.durationSeconds / 60);
        const preview = transcript.text.substring(0, 150) + (transcript.text.length > 150 ? '...' : '');

        response += `*${dateStr} at ${timeStr}* (${duration} min)\n${preview}\n\n`;
      }

      return response;
    } catch (error) {
      logger.error({ error, query }, 'Error handling Fieldy WhatsApp query');
      return `Sorry, I encountered an error: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  /**
   * Extract snippet around search terms
   */
  private extractSnippet(text: string, query: string, contextChars: number = 150): string {
    const queryLower = query.toLowerCase();
    const textLower = text.toLowerCase();

    const index = textLower.indexOf(queryLower);

    if (index === -1) {
      // No exact match, return beginning
      return text.substring(0, contextChars) + (text.length > contextChars ? '...' : '');
    }

    const start = Math.max(0, index - contextChars / 2);
    const end = Math.min(text.length, index + queryLower.length + contextChars / 2);

    let snippet = text.substring(start, end);

    if (start > 0) snippet = '...' + snippet;
    if (end < text.length) snippet = snippet + '...';

    return snippet;
  }

  /**
   * Verify webhook signature (if Fieldy supports webhook signing)
   */
  verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
    // TODO: Implement signature verification once Fieldy webhook specs are available
    // For now, assume all webhooks are valid
    return true;
  }
}

// Export singleton instance
export const fieldyIntegration = new FieldyIntegration();
