// @ts-nocheck — Omi deps (axios, @qdrant/js-client-rest) are optional.
// This file is dynamically imported; if deps are missing, the import fails gracefully.
/**
 * Omi Self-Hosted Integration for NanoClaw
 *
 * Provides WhatsApp query interface for Omi conversations:
 * - "What did I discuss today?"
 * - "Extract action items from last week"
 * - "Summarize my meeting with John"
 * - "Find conversations about project X"
 */

import axios from 'axios';
import { QdrantClient } from '@qdrant/js-client-rest';
import * as fs from 'fs';
import * as path from 'path';

interface OmiConfig {
  omiBackendUrl: string;
  qdrantUrl: string;
  universalRouterUrl: string;
  storageBasePath: string;
}

interface Transcript {
  id: string;
  audioFile: string;
  startTime: string;
  endTime: string;
  duration: number;
  text: string;
  speakers?: Array<{
    speaker: string;
    start: number;
    end: number;
  }>;
  language: string;
}

interface SearchResult {
  transcript: Transcript;
  score: number;
  snippet: string;
}

export class OmiIntegration {
  private config: OmiConfig;
  private qdrant: QdrantClient;

  constructor() {
    this.config = {
      omiBackendUrl: process.env.OMI_BACKEND_URL || 'http://localhost:8080',
      qdrantUrl: process.env.QDRANT_URL || 'http://localhost:6333',
      universalRouterUrl: process.env.UNIVERSAL_ROUTER_URL || 'http://localhost:11435',
      storageBasePath: process.env.OMI_STORAGE_PATH || '/Volumes/Omi-Data',
    };

    this.qdrant = new QdrantClient({ url: this.config.qdrantUrl });
  }

  /**
   * Probe Qdrant health endpoint to check if Omi backend is available.
   * Returns true if Qdrant responds, false otherwise.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const resp = await axios.get(`${this.config.qdrantUrl}/healthz`, { timeout: 3000 });
      return resp.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Query conversations by natural language
   *
   * @param query Natural language query (e.g., "what did I discuss about the project today?")
   * @param limit Number of results to return
   * @returns Array of relevant conversation snippets
   */
  async queryConversations(query: string, limit: number = 5): Promise<SearchResult[]> {
    try {
      // Generate embedding for query using local embeddings service
      const embedding = await this.generateEmbedding(query);

      // Search Qdrant for similar conversations
      const searchResults = await this.qdrant.search('omi_transcripts', {
        vector: embedding,
        limit,
        with_payload: true,
      });

      // Fetch full transcripts and format results
      const results: SearchResult[] = [];

      for (const result of searchResults) {
        const transcriptId = result.payload?.transcript_id as string;
        const transcript = await this.getTranscript(transcriptId);

        if (transcript) {
          results.push({
            transcript,
            score: result.score,
            snippet: this.extractSnippet(transcript.text, query),
          });
        }
      }

      return results;
    } catch (error) {
      console.error('Error querying conversations:', error);
      throw error;
    }
  }

  /**
   * Get conversations for a specific date or date range
   *
   * @param startDate ISO date string (YYYY-MM-DD)
   * @param endDate Optional end date for range
   * @returns Array of transcripts
   */
  async getConversationsByDate(startDate: string, endDate?: string): Promise<Transcript[]> {
    try {
      const response = await axios.get(`${this.config.omiBackendUrl}/api/transcripts`, {
        params: {
          start_date: startDate,
          end_date: endDate || startDate,
        },
      });

      return response.data.transcripts;
    } catch (error) {
      console.error('Error fetching conversations by date:', error);
      throw error;
    }
  }

  /**
   * Analyze conversations with AI
   *
   * @param transcripts Array of transcripts to analyze
   * @param analysisType Type of analysis (summary, action_items, decisions, etc.)
   * @returns Structured analysis result
   */
  async analyzeConversations(
    transcripts: Transcript[],
    analysisType: 'summary' | 'action_items' | 'decisions' | 'topics' | 'custom',
    customPrompt?: string
  ): Promise<any> {
    try {
      // Combine transcripts into context
      const context = transcripts
        .map((t) => {
          const timeRange = `${new Date(t.startTime).toLocaleTimeString()} - ${new Date(
            t.endTime
          ).toLocaleTimeString()}`;
          return `[${timeRange}]\n${t.text}\n`;
        })
        .join('\n---\n\n');

      // Build prompt based on analysis type
      let prompt = '';
      switch (analysisType) {
        case 'summary':
          prompt = `Summarize these conversations concisely. Include key topics discussed and main points:\n\n${context}`;
          break;

        case 'action_items':
          prompt = `Extract all action items, tasks, and commitments from these conversations. Format as a bulleted list:\n\n${context}`;
          break;

        case 'decisions':
          prompt = `Identify all decisions made in these conversations. Include who made the decision and what was decided:\n\n${context}`;
          break;

        case 'topics':
          prompt = `List the main topics discussed in these conversations. Group related topics together:\n\n${context}`;
          break;

        case 'custom':
          prompt = `${customPrompt}\n\nConversations:\n${context}`;
          break;
      }

      // Send to Universal Router (local AI)
      const response = await axios.post(`${this.config.universalRouterUrl}/v1/chat/completions`, {
        model: 'qwen-72b', // Local model via Universal Router
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.3, // Lower temperature for factual extraction
      });

      return {
        type: analysisType,
        result: response.data.choices[0].message.content,
        transcriptCount: transcripts.length,
        totalDuration: transcripts.reduce((sum, t) => sum + t.duration, 0),
      };
    } catch (error) {
      console.error('Error analyzing conversations:', error);
      throw error;
    }
  }

  /**
   * Handle natural language query from WhatsApp
   *
   * This is the main entry point for WhatsApp queries like:
   * - "what did I discuss today?"
   * - "extract action items from last week"
   * - "summarize my meeting with John"
   *
   * @param message Natural language query from user
   * @returns Formatted response for WhatsApp
   */
  async handleWhatsAppQuery(message: string): Promise<string> {
    try {
      // Parse query to understand intent
      const intent = this.parseIntent(message);

      let transcripts: Transcript[] = [];
      let response = '';

      switch (intent.type) {
        case 'today':
          transcripts = await this.getConversationsByDate(
            new Date().toISOString().split('T')[0]
          );
          if (transcripts.length === 0) {
            return 'No conversations recorded today yet.';
          }
          break;

        case 'yesterday':
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          transcripts = await this.getConversationsByDate(yesterday.toISOString().split('T')[0]);
          if (transcripts.length === 0) {
            return 'No conversations recorded yesterday.';
          }
          break;

        case 'this_week':
          const weekStart = new Date();
          weekStart.setDate(weekStart.getDate() - weekStart.getDay());
          transcripts = await this.getConversationsByDate(
            weekStart.toISOString().split('T')[0],
            new Date().toISOString().split('T')[0]
          );
          if (transcripts.length === 0) {
            return 'No conversations recorded this week yet.';
          }
          break;

        case 'search':
          const searchResults = await this.queryConversations(intent.searchQuery!, 10);
          transcripts = searchResults.map((r) => r.transcript);
          if (transcripts.length === 0) {
            return `No conversations found matching "${intent.searchQuery}".`;
          }
          break;

        default:
          // Generic search
          const results = await this.queryConversations(message, 5);
          transcripts = results.map((r) => r.transcript);
          if (transcripts.length === 0) {
            return `No conversations found related to your query.`;
          }
      }

      // Determine what kind of analysis is needed
      if (
        message.toLowerCase().includes('action item') ||
        message.toLowerCase().includes('task') ||
        message.toLowerCase().includes('todo')
      ) {
        const analysis = await this.analyzeConversations(transcripts, 'action_items');
        response = `*Action Items*\n\n${analysis.result}\n\n_From ${transcripts.length} conversation(s)_`;
      } else if (
        message.toLowerCase().includes('summar') ||
        message.toLowerCase().includes('overview')
      ) {
        const analysis = await this.analyzeConversations(transcripts, 'summary');
        response = `*Summary*\n\n${analysis.result}\n\n_From ${transcripts.length} conversation(s)_`;
      } else if (
        message.toLowerCase().includes('decision') ||
        message.toLowerCase().includes('decided')
      ) {
        const analysis = await this.analyzeConversations(transcripts, 'decisions');
        response = `*Decisions*\n\n${analysis.result}\n\n_From ${transcripts.length} conversation(s)_`;
      } else {
        // Default: show conversation list with brief summaries
        response = await this.formatConversationList(transcripts);
      }

      return response;
    } catch (error) {
      console.error('Error handling WhatsApp query:', error);
      return `Sorry, I encountered an error processing your query: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`;
    }
  }

  /**
   * Format conversation list for WhatsApp
   */
  private async formatConversationList(transcripts: Transcript[]): Promise<string> {
    let response = `*Found ${transcripts.length} conversation(s)*\n\n`;

    for (const transcript of transcripts.slice(0, 10)) {
      const startTime = new Date(transcript.startTime);
      const endTime = new Date(transcript.endTime);
      const duration = Math.round(transcript.duration / 60);

      const timeStr = startTime.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
      });
      const dateStr = startTime.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      });

      // Get brief summary (first 200 chars)
      const preview = transcript.text.substring(0, 200) + (transcript.text.length > 200 ? '...' : '');

      response += `*${dateStr} at ${timeStr}* (${duration} min)\n${preview}\n\n`;
    }

    if (transcripts.length > 10) {
      response += `_...and ${transcripts.length - 10} more conversation(s)_`;
    }

    return response;
  }

  /**
   * Parse natural language query to understand intent
   */
  private parseIntent(message: string): {
    type: string;
    searchQuery?: string;
    dateRange?: { start: string; end: string };
  } {
    const lower = message.toLowerCase();

    if (lower.includes('today')) {
      return { type: 'today' };
    }

    if (lower.includes('yesterday')) {
      return { type: 'yesterday' };
    }

    if (lower.includes('this week') || lower.includes('last week')) {
      return { type: 'this_week' };
    }

    if (lower.includes('about') || lower.includes('regarding')) {
      // Extract search query
      const match = message.match(/about\s+(.+?)(?:\s+today|\s+yesterday|$)/i);
      if (match) {
        return { type: 'search', searchQuery: match[1].trim() };
      }
    }

    // Default to generic search with full message
    return { type: 'search', searchQuery: message };
  }

  /**
   * Generate embedding for text using local embedding service
   */
  private async generateEmbedding(text: string): Promise<number[]> {
    try {
      const response = await axios.post('http://localhost:9001/embed', {
        texts: [text],
      });

      return response.data.embeddings[0];
    } catch (error) {
      console.error('Error generating embedding:', error);
      throw error;
    }
  }

  /**
   * Fetch transcript by ID
   */
  private async getTranscript(id: string): Promise<Transcript | null> {
    try {
      const response = await axios.get(`${this.config.omiBackendUrl}/api/transcripts/${id}`);
      return response.data;
    } catch (error) {
      console.error(`Error fetching transcript ${id}:`, error);
      return null;
    }
  }

  /**
   * Extract relevant snippet from transcript based on query
   */
  private extractSnippet(text: string, query: string, contextChars: number = 200): string {
    const queryWords = query.toLowerCase().split(/\s+/);
    const textLower = text.toLowerCase();

    // Find best matching position
    let bestPosition = 0;
    let bestScore = 0;

    for (let i = 0; i < textLower.length; i++) {
      let score = 0;
      for (const word of queryWords) {
        const distance = textLower.indexOf(word, i) - i;
        if (distance >= 0 && distance < contextChars) {
          score += 1 / (distance + 1);
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestPosition = i;
      }
    }

    // Extract snippet around best position
    const start = Math.max(0, bestPosition - contextChars / 2);
    const end = Math.min(text.length, bestPosition + contextChars / 2);

    let snippet = text.substring(start, end);

    if (start > 0) snippet = '...' + snippet;
    if (end < text.length) snippet = snippet + '...';

    return snippet;
  }

  /**
   * Get daily summary (for automated daily digest)
   */
  async getDailySummary(date?: string): Promise<string> {
    const targetDate = date || new Date().toISOString().split('T')[0];
    const transcripts = await this.getConversationsByDate(targetDate);

    if (transcripts.length === 0) {
      return `No conversations recorded on ${targetDate}.`;
    }

    const totalDuration = transcripts.reduce((sum, t) => sum + t.duration, 0);
    const hours = Math.floor(totalDuration / 3600);
    const minutes = Math.floor((totalDuration % 3600) / 60);

    const analysis = await this.analyzeConversations(transcripts, 'summary');
    const actions = await this.analyzeConversations(transcripts, 'action_items');
    const decisions = await this.analyzeConversations(transcripts, 'decisions');

    let summary = `*Daily Summary - ${new Date(targetDate).toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    })}*\n\n`;

    summary += `📊 *Stats*\n`;
    summary += `• Conversations: ${transcripts.length}\n`;
    summary += `• Total time: ${hours}h ${minutes}m\n\n`;

    summary += `💬 *Summary*\n${analysis.result}\n\n`;

    if (actions.result.trim()) {
      summary += `✅ *Action Items*\n${actions.result}\n\n`;
    }

    if (decisions.result.trim()) {
      summary += `🎯 *Decisions*\n${decisions.result}\n\n`;
    }

    return summary;
  }

  /**
   * Get weekly summary
   */
  async getWeeklySummary(): Promise<string> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);

    const transcripts = await this.getConversationsByDate(
      startDate.toISOString().split('T')[0],
      endDate.toISOString().split('T')[0]
    );

    if (transcripts.length === 0) {
      return 'No conversations recorded this week.';
    }

    const totalDuration = transcripts.reduce((sum, t) => sum + t.duration, 0);
    const hours = Math.floor(totalDuration / 3600);

    const analysis = await this.analyzeConversations(transcripts, 'topics');

    let summary = `*Weekly Summary*\n\n`;
    summary += `📊 *Stats*\n`;
    summary += `• Conversations: ${transcripts.length}\n`;
    summary += `• Total time: ${hours} hours\n\n`;
    summary += `📌 *Main Topics*\n${analysis.result}\n`;

    return summary;
  }

  /**
   * Get audio file path for a transcript
   * Useful for custom processing or playback
   */
  getAudioFilePath(transcript: Transcript): string {
    return path.join(this.config.storageBasePath, transcript.audioFile);
  }
}

// Export singleton instance
export const omiIntegration = new OmiIntegration();

// Example usage in NanoClaw message handler:
/*
import { omiIntegration } from './integrations/omi-integration';

// In your WhatsApp message handler:
if (message.includes('omi') || message.includes('conversation') || message.includes('discussed')) {
  const response = await omiIntegration.handleWhatsAppQuery(message);
  sendWhatsAppMessage(response);
}

// Daily summary (run at 9 PM via scheduled task):
const dailySummary = await omiIntegration.getDailySummary();
sendWhatsAppMessage(dailySummary);

// Weekly summary (run Sunday evening):
const weeklySummary = await omiIntegration.getWeeklySummary();
sendWhatsAppMessage(weeklySummary);
*/
