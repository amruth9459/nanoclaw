/**
 * Goal Classifier
 * Determines if a user request should be handled by multi-agent teams or single agent
 *
 * Uses AI reasoning models to intelligently classify goals
 */

import { MLXBackendFactory } from './router/index.js';

export interface GoalClassification {
  shouldUseTeams: boolean;
  confidence: 'low' | 'medium' | 'high';
  reasoning: string;
  estimatedComplexity: 'trivial' | 'simple' | 'moderate' | 'complex' | 'expert';
  detectedGoalType?: 'earning' | 'building' | 'research' | 'multi-step' | 'learning';
}

/**
 * Use AI reasoning model to classify whether a goal needs teams
 * Uses Llama 3.3 70B locally for zero-cost classification
 */
export async function classifyGoalWithAI(userMessage: string): Promise<GoalClassification> {
  try {
    // Read API key from env or .env file
    let apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      try {
        const { readEnvFile } = await import('./env.js');
        apiKey = readEnvFile(['ANTHROPIC_API_KEY']).ANTHROPIC_API_KEY;
      } catch { /* no .env */ }
    }
    if (!apiKey) return classifyGoalHeuristic(userMessage);

    const start = Date.now();
    const resp = await Promise.race([
      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 150,
          temperature: 0,
          messages: [{ role: 'user', content: buildClassificationPrompt(userMessage) }],
        }),
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);

    if (!resp.ok) return classifyGoalHeuristic(userMessage);

    const data = await resp.json() as { content: Array<{ text: string }> };
    const text = data.content?.[0]?.text || '';
    const latency = Date.now() - start;

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return classifyGoalHeuristic(userMessage);

    const parsed = JSON.parse(jsonMatch[0]) as Partial<GoalClassification>;
    const result: GoalClassification = {
      shouldUseTeams: parsed.shouldUseTeams ?? false,
      confidence: parsed.confidence ?? 'medium',
      reasoning: parsed.reasoning ?? 'Classified by Haiku',
      estimatedComplexity: parsed.estimatedComplexity ?? 'moderate',
      detectedGoalType: parsed.detectedGoalType,
    };

    console.log(`[GoalClassifier] Haiku (${latency}ms): ${result.estimatedComplexity} — ${result.reasoning?.slice(0, 80)}`);
    return result;
  } catch (error) {
    return classifyGoalHeuristic(userMessage);
  }
}

function buildClassificationPrompt(userMessage: string): string {
  return `Analyze this user request and determine if it requires a multi-agent team or can be handled by a single agent.

User Request: "${userMessage}"

Consider:
1. Complexity - Does it involve multiple distinct phases or specializations?
2. Scope - Is it a single task or a multi-step project?
3. Skills Required - Does it need different types of expertise (research, development, marketing, etc.)?
4. Time Investment - Is this a quick task or a substantial project?
5. Deliverables - Does it produce one thing or multiple outputs?

TEAM INDICATORS:
✓ Earning goals with specific $ amounts (e.g., "earn $5,000")
✓ Building multiple products/MVPs
✓ Multi-phase projects (research → build → deploy)
✓ Requires different specialists (frontend + backend + testing)
✓ Time-bound complex projects
✓ Full-stack or end-to-end implementations

SINGLE AGENT INDICATORS:
✓ Simple questions (What/How/Why)
✓ Quick searches or file operations
✓ Single bug fixes or code reviews
✓ Conversational responses
✓ Reading/analyzing existing content

Respond ONLY with valid JSON (no markdown, no code blocks):
{
  "shouldUseTeams": true,
  "confidence": "high",
  "reasoning": "brief explanation",
  "estimatedComplexity": "expert",
  "detectedGoalType": "earning"
}`;
}

/**
 * Fallback heuristic-based classifier (fast, no API calls)
 */
export function classifyGoalHeuristic(userMessage: string): GoalClassification {
  const msg = userMessage.toLowerCase();

  // High-confidence team indicators
  const highConfidenceTeamPatterns = [
    // Multi-step/multi-product goals
    /build.*and.*(?:deploy|test|launch|market)/i,
    /create.*mvp|minimum viable product/i,
    /(?:build|develop|create).*\d+.*(?:products?|services?|apps?|projects?)/i,

    // Earning/revenue goals with specific amounts
    /(?:earn|make|generate|get).*\$\d{3,}/i,
    /(?:reach|achieve|hit).*\$\d{3,}/i,

    // Complex research/analysis
    /(?:research|analyze|investigate).*(?:and|then).*(?:build|implement|deploy)/i,
    /complete.*(?:analysis|research|study).*(?:and|then)/i,

    // Explicit multi-phase requests
    /(?:first|then|next|after that|finally)/i,
    /(?:phase \d+|step \d+|stage \d+)/i,

    // Multi-deliverable chains (find X, then do Y)
    /(?:find|search|get).*(?:,|then|and).*(?:build|create|write|list|generate)/i,
    // Job search patterns (complex by nature — matching, filtering, producing)
    /(?:find|search|get).*(?:jobs?|roles?|positions?).*(?:match|fit|profile|resume)/i,
    /(?:build|create|write|draft).*(?:cover letter|resume|CV).*(?:for|based on)/i,
  ];

  // Medium-confidence indicators
  const mediumConfidenceTeamPatterns = [
    // Building/development projects
    /(?:build|create|develop|implement).*(?:system|platform|application|product|service)/i,
    /set up.*(?:infrastructure|pipeline|workflow)/i,

    // Goals requiring multiple skills
    /(?:design|build).*(?:and|with).*(?:test|market|deploy)/i,
    /full[- ]?stack/i,
    /end[- ]?to[- ]?end/i,

    // Time-bound projects
    /(?:by|before|within).*(?:\d+.*(?:weeks?|months?|days?)|deadline)/i,

    // Multi-output tasks (create/build/write N things)
    /(?:build|create|write|draft|generate).*(?:top \d+|for (?:each|all|every)|\d+.*(?:letters?|reports?|documents?))/i,
    /(?:find|search|identify).*(?:all|every|top \d+).*(?:jobs?|roles?|positions?|candidates?|companies?)/i,

    // Research + produce deliverable
    /(?:research|analyze|investigate|review).*(?:write|create|build|produce|generate)/i,
    /(?:research|analyze).*(?:detailed|comprehensive|in-depth)/i,

    // Strategic/planning deliverables
    /(?:create|build|write|draft).*(?:business plan|strategy|proposal|pitch deck|financial.*projections?)/i,
  ];

  // Low-confidence (might need teams)
  const lowConfidenceTeamPatterns = [
    // Large scope indicators
    /comprehensive|extensive|complete|full|entire/i,
    /everything|all.*aspects/i,

    // Multiple deliverables
    /(?:including|with|plus).*(?:documentation|tests|deployment)/i,
  ];

  // Exclude patterns (definitely NOT team tasks)
  const singleAgentPatterns = [
    // Simple questions
    /^(?:what|how|when|where|who|why|can you|do you know)/i,
    /\?$/,

    // Simple requests
    /^(?:show|tell|explain|describe|list)/i,
    /^(?:read|check|look at|view)/i,

    // Greetings/small talk
    /^(?:hi|hello|hey|thanks|thank you|ok|okay|yes|no)/i,
  ];

  // Check exclusions first
  if (singleAgentPatterns.some(pattern => pattern.test(msg))) {
    return {
      shouldUseTeams: false,
      confidence: 'high',
      reasoning: 'Simple query or request - single agent sufficient',
      estimatedComplexity: 'trivial',
    };
  }

  // Check high-confidence team patterns
  const highMatch = highConfidenceTeamPatterns.find(pattern => pattern.test(userMessage));
  if (highMatch) {
    const goalType = detectGoalType(userMessage);
    return {
      shouldUseTeams: true,
      confidence: 'high',
      reasoning: `Complex ${goalType} goal requiring multiple specialists`,
      estimatedComplexity: 'expert',
      detectedGoalType: goalType,
    };
  }

  // Check medium-confidence patterns
  const mediumMatch = mediumConfidenceTeamPatterns.find(pattern => pattern.test(userMessage));
  if (mediumMatch) {
    const goalType = detectGoalType(userMessage);
    return {
      shouldUseTeams: true,
      confidence: 'medium',
      reasoning: `Multi-phase ${goalType} task - teams recommended`,
      estimatedComplexity: 'complex',
      detectedGoalType: goalType,
    };
  }

  // Check low-confidence patterns
  const lowMatch = lowConfidenceTeamPatterns.find(pattern => pattern.test(msg));
  if (lowMatch) {
    return {
      shouldUseTeams: true,
      confidence: 'low',
      reasoning: 'Large scope detected - teams may be beneficial',
      estimatedComplexity: 'moderate',
    };
  }

  // Additional heuristics
  const wordCount = userMessage.split(/\s+/).length;
  const hasMultipleSentences = (userMessage.match(/[.!?]/g) || []).length > 2;
  const hasNumbers = /\d+/.test(userMessage);
  const hasCurrency = /\$|USD|dollars?/i.test(userMessage);

  // Long, detailed requests with numbers/currency likely need teams
  if (wordCount > 30 && hasMultipleSentences && (hasNumbers || hasCurrency)) {
    return {
      shouldUseTeams: true,
      confidence: 'medium',
      reasoning: 'Detailed multi-part request with specific targets',
      estimatedComplexity: 'complex',
    };
  }

  // Default: single agent
  return {
    shouldUseTeams: false,
    confidence: 'medium',
    reasoning: 'Standard request - single agent appropriate',
    estimatedComplexity: wordCount > 15 ? 'moderate' : 'simple',
  };
}

function detectGoalType(message: string): 'earning' | 'building' | 'research' | 'multi-step' | 'learning' {
  const msg = message.toLowerCase();

  if (/\$\d+|earn|revenue|profit|income|money/i.test(msg)) {
    return 'earning';
  }
  if (/build|create|develop|implement|deploy/i.test(msg)) {
    return 'building';
  }
  if (/research|analyze|investigate|study|explore/i.test(msg)) {
    return 'research';
  }
  if (/learn|understand|master|study/i.test(msg)) {
    return 'learning';
  }
  return 'multi-step';
}

/**
 * Extract goal details from user message for team spawning
 */
export function extractGoalDetails(userMessage: string): {
  goal: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  targetValue?: number;
  deadline?: string;
} {
  // Extract dollar amounts
  const dollarMatch = userMessage.match(/\$?([\d,]+)/);
  const targetValue = dollarMatch ? parseFloat(dollarMatch[1].replace(/,/g, '')) : undefined;

  // Extract deadlines
  let deadline: string | undefined;
  const datePatterns = [
    /by (\d{4}-\d{2}-\d{2})/i,
    /before (\d{4}-\d{2}-\d{2})/i,
    /deadline[:\s]+(\d{4}-\d{2}-\d{2})/i,
  ];

  for (const pattern of datePatterns) {
    const match = userMessage.match(pattern);
    if (match) {
      deadline = `${match[1]}T00:00:00Z`;
      break;
    }
  }

  // Detect priority
  const msg = userMessage.toLowerCase();
  let priority: 'critical' | 'high' | 'medium' | 'low' = 'high';

  if (/urgent|critical|asap|immediately|emergency/i.test(msg)) {
    priority = 'critical';
  } else if (/important|priority|soon/i.test(msg)) {
    priority = 'high';
  } else if (/when you can|eventually|sometime/i.test(msg)) {
    priority = 'low';
  }

  return {
    goal: userMessage,
    priority,
    targetValue,
    deadline,
  };
}
