/**
 * LLM-as-Judges System for NanoClaw
 *
 * Provides peer review for outputs before delivery to users.
 * Inspired by Lexios 3-judge system.
 *
 * Use cases:
 * - Code changes: QA review before deployment
 * - Revenue product content: OSHA reports, grant digests (quality check)
 * - Team outputs: Review multi-agent work before delivery
 * - User-facing responses: Check accuracy, completeness, tone
 */

import Anthropic from '@anthropic-ai/sdk';

import { readEnvFile } from './env.js';
import { logUsage } from './db.js';
import { calculateCost } from './economics.js';
import { logger } from './logger.js';
import { RouterFactory } from './router/universal-router.js';
import type { RoutingContext } from './router/types.js';

let _anthropicClient: Anthropic | null = null;
function getAnthropicClient(): Anthropic {
  if (_anthropicClient) return _anthropicClient;
  const env = readEnvFile(['ANTHROPIC_API_KEY']);
  const apiKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY required for judge system');
  _anthropicClient = new Anthropic({ apiKey });
  return _anthropicClient;
}

export interface JudgeRequest {
  id: string;
  content: string;
  contentType: 'code' | 'report' | 'analysis' | 'response' | 'documentation';
  context?: string; // Additional context for judges
  metadata?: Record<string, unknown>;
  requestedAt: number;
}

export interface JudgeVote {
  judgeId: string;
  modelUsed: string;
  verdict: 'approve' | 'reject' | 'needs_revision';
  confidence: number; // 0-1
  reasoning: string;
  issues: Array<{
    severity: 'critical' | 'major' | 'minor';
    category: 'accuracy' | 'completeness' | 'clarity' | 'safety' | 'style';
    description: string;
    suggestion?: string;
  }>;
  reviewedAt: number;
}

export interface JudgeResult {
  requestId: string;
  votes: JudgeVote[];
  consensus: 'approve' | 'reject' | 'needs_revision';
  confidence: number; // Average confidence of judges
  criticalIssues: number;
  majorIssues: number;
  minorIssues: number;
  recommendation: string;
  completedAt: number;
}

export interface JudgeSystemConfig {
  judgeCount: number; // Default: 3 judges (like Lexios)
  requireUnanimous: boolean; // Default: false (majority rule)
  minConfidence: number; // Default: 0.7 (filter low-confidence votes)
  useLocalModels: boolean; // Default: true (cost optimization)
  models?: {
    judge1?: string;
    judge2?: string;
    judge3?: string;
  };
}

/**
 * Judge System
 * Orchestrates peer review by multiple LLM judges
 */
export class JudgeSystem {
  private readonly config: Required<JudgeSystemConfig>;
  private readonly router = RouterFactory.create();

  constructor(config?: Partial<JudgeSystemConfig>) {
    this.config = {
      judgeCount: 3,
      requireUnanimous: false,
      minConfidence: 0.7,
      useLocalModels: true,
      models: {},
      ...config,
    };
  }

  /**
   * Submit content for peer review
   */
  async review(request: JudgeRequest): Promise<JudgeResult> {
    // Spawn judges in parallel
    const judgePromises = Array.from({ length: this.config.judgeCount }, (_, i) =>
      this.spawnJudge(request, i + 1)
    );

    const votes = await Promise.all(judgePromises);

    // Filter low-confidence votes
    const validVotes = votes.filter(v => v.confidence >= this.config.minConfidence);

    if (validVotes.length === 0) {
      throw new Error('All judge votes below minimum confidence threshold');
    }

    // Determine consensus
    const consensus = this.determineConsensus(validVotes);

    // Aggregate issues
    const allIssues = validVotes.flatMap(v => v.issues);
    const criticalIssues = allIssues.filter(i => i.severity === 'critical').length;
    const majorIssues = allIssues.filter(i => i.severity === 'major').length;
    const minorIssues = allIssues.filter(i => i.severity === 'minor').length;

    // Calculate average confidence
    const avgConfidence = validVotes.reduce((sum, v) => sum + v.confidence, 0) / validVotes.length;

    // Generate recommendation
    const recommendation = this.generateRecommendation(consensus, criticalIssues, majorIssues, minorIssues, validVotes);

    return {
      requestId: request.id,
      votes: validVotes,
      consensus,
      confidence: avgConfidence,
      criticalIssues,
      majorIssues,
      minorIssues,
      recommendation,
      completedAt: Date.now(),
    };
  }

  /**
   * Spawn a single judge
   */
  private async spawnJudge(request: JudgeRequest, judgeNumber: number): Promise<JudgeVote> {
    const judgeId = `judge-${judgeNumber}`;

    // Select model for this judge
    const modelId = this.selectModelForJudge(judgeNumber);

    // Build judge prompt
    const prompt = this.buildJudgePrompt(request);

    // Route to appropriate model
    const routingContext: RoutingContext = {
      taskType: 'reasoning',
      userTier: 'internal',
      costBudget: this.config.useLocalModels ? 'zero' : 'limited',
      qualityNeeds: 'best',
      latencyNeeds: 'fast',
      source: 'internal',
    };

    const decision = await this.router.route(routingContext);

    // Execute judge review (placeholder - actual execution would call the model)
    // TODO: Integrate with Universal Router's execute() method
    const vote = await this.executeJudgeReview(judgeId, decision.modelId, prompt, request);

    return vote;
  }

  /**
   * Select model for specific judge
   * Uses different models for diversity (reduce groupthink)
   */
  private selectModelForJudge(judgeNumber: number): string {
    const { models, useLocalModels } = this.config;

    // Check for explicit model assignment
    const explicitModel = models[`judge${judgeNumber}` as keyof typeof models];
    if (explicitModel) {
      return explicitModel;
    }

    // Default models (diverse for better consensus)
    if (useLocalModels) {
      const localModels = [
        'llama-3.3-70b',      // Judge 1: Strong reasoning
        'qwen2.5-72b',         // Judge 2: Alternative perspective
        'llama-3.3-70b',       // Judge 3: Tiebreaker (same as judge 1)
      ];
      return localModels[(judgeNumber - 1) % localModels.length];
    } else {
      const cloudModels = [
        'claude-sonnet-4.6',   // Judge 1: Balanced
        'gpt-4o',              // Judge 2: Different architecture
        'claude-sonnet-4.6',   // Judge 3: Tiebreaker
      ];
      return cloudModels[(judgeNumber - 1) % cloudModels.length];
    }
  }

  /**
   * Build judge prompt based on content type
   */
  private buildJudgePrompt(request: JudgeRequest): string {
    const basePrompt = `You are Judge ${request.id}. Review the following ${request.contentType} for quality and correctness.

${request.context ? `Context: ${request.context}\n\n` : ''}Content to review:
${request.content}

Provide your review in the following JSON format:
{
  "verdict": "approve" | "reject" | "needs_revision",
  "confidence": 0.0-1.0,
  "reasoning": "Your reasoning here",
  "issues": [
    {
      "severity": "critical" | "major" | "minor",
      "category": "accuracy" | "completeness" | "clarity" | "safety" | "style",
      "description": "Issue description",
      "suggestion": "How to fix (optional)"
    }
  ]
}`;

    // Content-type specific instructions
    const typeSpecificPrompts: Record<typeof request.contentType, string> = {
      code: `
Check for:
- Syntax errors and bugs
- Security vulnerabilities (SQL injection, XSS, hardcoded secrets)
- Performance issues
- Code style and readability
- Missing error handling
- Test coverage gaps`,

      report: `
Check for:
- Factual accuracy (no fabricated data or hallucinations)
- Completeness (all required sections present)
- Clarity and readability
- Professional tone
- Proper citations and sources
- Data consistency`,

      analysis: `
Check for:
- Logical reasoning (no fallacies)
- Evidence quality (verified sources)
- Completeness (all aspects covered)
- Clarity of conclusions
- Actionable recommendations
- Bias or assumptions stated clearly`,

      response: `
Check for:
- Accuracy (no false information)
- Completeness (answers the question fully)
- Clarity (easy to understand)
- Tone appropriateness
- Safety (no harmful advice)
- Helpfulness`,

      documentation: `
Check for:
- Accuracy (reflects actual behavior)
- Completeness (all features documented)
- Clarity (easy to follow)
- Examples provided
- Up-to-date information
- Proper formatting`,
    };

    return `${basePrompt}\n${typeSpecificPrompts[request.contentType]}`;
  }

  /**
   * Execute judge review with real model call
   */
  private async executeJudgeReview(
    judgeId: string,
    modelId: string,
    prompt: string,
    _request: JudgeRequest
  ): Promise<JudgeVote> {
    // Use Haiku for fast/cheap judge reviews, Sonnet for critical
    const useModel = this.config.useLocalModels
      ? 'claude-haiku-4-5-20251001'
      : 'claude-sonnet-4-6-20250514';

    try {
      const client = getAnthropicClient();
      const resp = await client.messages.create({
        model: useModel,
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `${prompt}

Respond ONLY with a JSON object in this exact format (no explanation, no code block):
{
  "verdict": "approve" | "reject" | "needs_revision",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation",
  "issues": [
    {
      "severity": "critical" | "major" | "minor",
      "category": "accuracy" | "completeness" | "clarity" | "safety" | "style",
      "description": "what the issue is",
      "suggestion": "how to fix"
    }
  ]
}`,
        }],
      });

      // Track judge review cost
      if (resp.usage) {
        const usage = {
          inputTokens: resp.usage.input_tokens,
          outputTokens: resp.usage.output_tokens,
        };
        const costUsd = calculateCost(usage);
        logUsage('_system', '_judge_review', usage, 0, false, costUsd, 'judge');
      }

      const text = resp.content[0].type === 'text' ? resp.content[0].text : '';

      // Parse the JSON response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn({ judgeId, text: text.slice(0, 200) }, 'Judge returned non-JSON response');
        return this.fallbackVote(judgeId, useModel);
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        judgeId,
        modelUsed: useModel,
        verdict: parsed.verdict || 'approve',
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.7,
        reasoning: parsed.reasoning || 'No reasoning provided',
        issues: Array.isArray(parsed.issues) ? parsed.issues.map((i: Record<string, string>) => ({
          severity: i.severity || 'minor',
          category: i.category || 'completeness',
          description: i.description || '',
          suggestion: i.suggestion,
        })) : [],
        reviewedAt: Date.now(),
      };
    } catch (err) {
      logger.error({ err, judgeId, modelId }, 'Judge model call failed');
      return this.fallbackVote(judgeId, modelId);
    }
  }

  /**
   * Fallback vote when model call fails
   */
  private fallbackVote(judgeId: string, modelUsed: string): JudgeVote {
    return {
      judgeId,
      modelUsed,
      verdict: 'approve',
      confidence: 0.5,
      reasoning: 'Fallback approval — model call failed',
      issues: [],
      reviewedAt: Date.now(),
    };
  }

  /**
   * Determine consensus from votes
   */
  private determineConsensus(votes: JudgeVote[]): 'approve' | 'reject' | 'needs_revision' {
    if (this.config.requireUnanimous) {
      // All judges must agree
      const firstVerdict = votes[0].verdict;
      const unanimous = votes.every(v => v.verdict === firstVerdict);
      return unanimous ? firstVerdict : 'needs_revision';
    } else {
      // Majority rule
      const verdictCounts = votes.reduce((counts, vote) => {
        counts[vote.verdict] = (counts[vote.verdict] || 0) + 1;
        return counts;
      }, {} as Record<string, number>);

      // If any critical issues, lean toward rejection
      const hasCritical = votes.some(v => v.issues.some(i => i.severity === 'critical'));
      if (hasCritical) {
        return 'reject';
      }

      // Otherwise, use majority verdict
      const entries = Object.entries(verdictCounts);
      entries.sort((a, b) => b[1] - a[1]);
      return entries[0][0] as 'approve' | 'reject' | 'needs_revision';
    }
  }

  /**
   * Generate recommendation based on results
   */
  private generateRecommendation(
    consensus: string,
    criticalIssues: number,
    majorIssues: number,
    minorIssues: number,
    votes: JudgeVote[]
  ): string {
    if (criticalIssues > 0) {
      return `❌ REJECT: ${criticalIssues} critical issue(s) found. Must fix before delivery.`;
    }

    if (consensus === 'approve' && majorIssues === 0 && minorIssues === 0) {
      return `✅ APPROVE: All judges approved with no issues found. Ready for delivery.`;
    }

    if (consensus === 'approve' && majorIssues === 0) {
      return `✅ APPROVE: ${minorIssues} minor issue(s) found, but not blocking. Consider addressing for polish.`;
    }

    if (consensus === 'needs_revision') {
      return `⚠️ NEEDS REVISION: ${majorIssues} major issue(s) found. Review feedback and revise before delivery.`;
    }

    if (consensus === 'reject') {
      return `❌ REJECT: Multiple significant issues found. Requires substantial revision.`;
    }

    return `⚠️ MIXED RESULTS: Review judge feedback carefully before proceeding.`;
  }

  /**
   * Quick review for simple content (single judge)
   */
  async quickReview(content: string, contentType: JudgeRequest['contentType']): Promise<JudgeVote> {
    const request: JudgeRequest = {
      id: `quick-${Date.now()}`,
      content,
      contentType,
      requestedAt: Date.now(),
    };

    return this.spawnJudge(request, 1);
  }
}

/**
 * Factory for judge system
 */
export class JudgeSystemFactory {
  /**
   * Create default judge system (3 judges, local models)
   */
  static create(): JudgeSystem {
    return new JudgeSystem({
      judgeCount: 3,
      requireUnanimous: false,
      minConfidence: 0.7,
      useLocalModels: true,
    });
  }

  /**
   * Create high-quality judge system (cloud models)
   */
  static createHighQuality(): JudgeSystem {
    return new JudgeSystem({
      judgeCount: 3,
      requireUnanimous: false,
      minConfidence: 0.8,
      useLocalModels: false,
    });
  }

  /**
   * Create strict judge system (unanimous required)
   */
  static createStrict(): JudgeSystem {
    return new JudgeSystem({
      judgeCount: 3,
      requireUnanimous: true,
      minConfidence: 0.85,
      useLocalModels: false,
    });
  }

  /**
   * Create fast judge system (single judge, local)
   */
  static createFast(): JudgeSystem {
    return new JudgeSystem({
      judgeCount: 1,
      requireUnanimous: true,
      minConfidence: 0.7,
      useLocalModels: true,
    });
  }
}

/**
 * Helper functions
 */

export async function reviewCode(code: string, context?: string): Promise<JudgeResult> {
  const judge = JudgeSystemFactory.create();
  return judge.review({
    id: `code-${Date.now()}`,
    content: code,
    contentType: 'code',
    context,
    requestedAt: Date.now(),
  });
}

export async function reviewReport(report: string, context?: string): Promise<JudgeResult> {
  const judge = JudgeSystemFactory.create();
  return judge.review({
    id: `report-${Date.now()}`,
    content: report,
    contentType: 'report',
    context,
    requestedAt: Date.now(),
  });
}

export async function reviewResponse(response: string, userQuery?: string): Promise<JudgeResult> {
  const judge = JudgeSystemFactory.create();
  return judge.review({
    id: `response-${Date.now()}`,
    content: response,
    contentType: 'response',
    context: userQuery ? `User query: ${userQuery}` : undefined,
    requestedAt: Date.now(),
  });
}
