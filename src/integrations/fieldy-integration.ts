/**
 * Fieldy Webhook Integration for NanoClaw
 *
 * Receives real-time transcripts from Fieldy device via webhook,
 * stores them in database, and provides WhatsApp query interface.
 *
 * Webhook endpoint: POST /webhooks/fieldy
 *
 * Actual Fieldy payload format:
 * {
 *   "date": "2025-03-01T16:35:00.100907+00:00",
 *   "transcription": "Hi, my name is Adam.",
 *   "transcriptions": [
 *     {"text": "Hi, my name is Adam.", "speaker": "A", "start": 0.04, "end": 4.4, "duration": 4.36}
 *   ]
 * }
 */

import crypto from 'crypto';
import { storeTranscript, getTranscript, searchTranscripts, getTranscriptsByDate, getTranscriptStats } from '../db.js';
import { logger } from '../logger.js';

/** Raw payload from Fieldy device */
export interface FieldyWebhookPayload {
  date: string;
  transcription: string;
  transcriptions?: Array<{
    text: string;
    speaker: string;
    start: number;
    end: number;
    duration: number;
  }>;
}

export class FieldyIntegration {
  /**
   * Handle incoming webhook from Fieldy device
   */
  async handleWebhook(payload: FieldyWebhookPayload): Promise<{ success: boolean; message: string }> {
    try {
      // Validate required fields
      if (!payload.date || !payload.transcription) {
        logger.warn({ payload }, 'Invalid Fieldy webhook payload - missing required fields');
        return { success: false, message: 'Missing required fields: date, transcription' };
      }

      // Generate deterministic ID from date + transcript hash (Fieldy doesn't send an ID)
      const id = 'fieldy_' + crypto.createHash('sha256')
        .update(payload.date + payload.transcription)
        .digest('hex')
        .substring(0, 16);

      // Check for duplicates
      const existing = getTranscript(id);
      if (existing) {
        logger.info({ transcriptId: id }, 'Fieldy transcript already exists, skipping');
        return { success: true, message: 'Transcript already stored' };
      }

      // Compute total duration from speaker segments, or 0 if no segments
      const segments = payload.transcriptions || [];
      const totalDuration = segments.length > 0
        ? Math.ceil(Math.max(...segments.map(s => s.end)) - Math.min(...segments.map(s => s.start)))
        : 0;

      // Map speaker segments to our format
      const speakers = segments.map(s => ({
        speaker: `Speaker ${s.speaker}`,
        start: s.start,
        end: s.end,
      }));

      // Compute end_time from date + duration
      const startTime = payload.date;
      const endDate = new Date(payload.date);
      endDate.setSeconds(endDate.getSeconds() + totalDuration);
      const endTime = endDate.toISOString();

      storeTranscript({
        id,
        source: 'fieldy',
        startTime,
        endTime,
        durationSeconds: totalDuration,
        text: payload.transcription,
        speakers: speakers.length > 0 ? speakers : undefined,
        metadata: segments.length > 0 ? { rawTranscriptions: segments } : undefined,
      });

      logger.info(
        { transcriptId: id, duration: totalDuration, textLength: payload.transcription.length },
        'Fieldy transcript stored successfully'
      );

      return { success: true, message: `Transcript ${id} stored successfully` };
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
   * - "Find conversations about project X"
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
        response += `${transcripts.length} recording(s), ${totalMinutes} minutes total\n\n`;

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
        response += `${transcripts.length} recording(s), ${totalMinutes} minutes total\n\n`;

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
        response += `Total recordings: ${stats.total}\n`;
        response += `Total duration: ${stats.totalDurationHours} hours\n\n`;

        if (stats.bySource.fieldy) {
          response += `Fieldy recordings: ${stats.bySource.fieldy}\n`;
        }

        if (stats.oldestTranscript && stats.newestTranscript) {
          const oldest = new Date(stats.oldestTranscript);
          const newest = new Date(stats.newestTranscript);
          response += `\nDate range:\n`;
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

  /** Extract snippet around search terms */
  private extractSnippet(text: string, query: string, contextChars: number = 150): string {
    const queryLower = query.toLowerCase();
    const textLower = text.toLowerCase();

    const index = textLower.indexOf(queryLower);

    if (index === -1) {
      return text.substring(0, contextChars) + (text.length > contextChars ? '...' : '');
    }

    const start = Math.max(0, index - contextChars / 2);
    const end = Math.min(text.length, index + queryLower.length + contextChars / 2);

    let snippet = text.substring(start, end);

    if (start > 0) snippet = '...' + snippet;
    if (end < text.length) snippet = snippet + '...';

    return snippet;
  }
}

// Export singleton instance
export const fieldyIntegration = new FieldyIntegration();
