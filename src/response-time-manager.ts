/**
 * Response Time Manager (Option 4 - All Approaches)
 *
 * Improves perceived response times from Claw with:
 * 1. Immediate Acknowledgment (quick win)
 * 2. Progress Updates (for long tasks)
 * 3. Streaming Responses (partial results)
 * 4. Task Estimation (set expectations)
 */

export interface TaskEstimate {
  estimatedDurationMs: number;
  estimatedDurationHuman: string; // "~2 minutes"
  complexity: 'simple' | 'moderate' | 'complex' | 'very-complex';
  steps: Array<{
    name: string;
    estimatedMs: number;
  }>;
}

export interface ProgressUpdate {
  currentStep: number;
  totalSteps: number;
  stepName: string;
  percentComplete: number;
  elapsedMs: number;
  estimatedRemainingMs: number;
}

export interface ResponseTimeConfig {
  enableAcknowledgment: boolean; // Send "Got it!" immediately
  enableProgressUpdates: boolean; // Send updates every N seconds
  progressIntervalMs: number; // Default: 60000 (1 minute)
  enableStreaming: boolean; // Send partial results
  enableEstimation: boolean; // Estimate task duration
  minTaskDurationForProgress: number; // Default: 30000ms (30s)
}

/**
 * Response Time Manager
 * Orchestrates all response time improvements
 */
export class ResponseTimeManager {
  private config: Required<ResponseTimeConfig>;
  private activeTask: {
    id: string;
    startedAt: number;
    estimate: TaskEstimate;
    currentStep: number;
    lastUpdateAt: number;
    progressInterval?: NodeJS.Timeout;
  } | null = null;

  constructor(config?: Partial<ResponseTimeConfig>) {
    this.config = {
      enableAcknowledgment: true,
      enableProgressUpdates: true,
      progressIntervalMs: 60000, // 1 minute
      enableStreaming: true,
      enableEstimation: true,
      minTaskDurationForProgress: 30000, // 30 seconds
      ...config,
    };
  }

  /**
   * Start tracking a task
   * Returns acknowledgment message if enabled
   */
  async startTask(
    taskId: string,
    taskDescription: string,
    sendMessage: (msg: string) => Promise<void>
  ): Promise<void> {
    const estimate = this.estimateTask(taskDescription);

    this.activeTask = {
      id: taskId,
      startedAt: Date.now(),
      estimate,
      currentStep: 0,
      lastUpdateAt: Date.now(),
    };

    // Send immediate acknowledgment
    if (this.config.enableAcknowledgment) {
      const ackMessage = this.buildAcknowledgmentMessage(taskDescription, estimate);
      await sendMessage(ackMessage);
    }

    // Start progress updates for long tasks
    if (
      this.config.enableProgressUpdates &&
      estimate.estimatedDurationMs >= this.config.minTaskDurationForProgress
    ) {
      this.startProgressUpdates(sendMessage);
    }
  }

  /**
   * Update task progress
   */
  async updateProgress(
    stepName: string,
    sendMessage?: (msg: string) => Promise<void>
  ): Promise<void> {
    if (!this.activeTask) return;

    this.activeTask.currentStep++;
    this.activeTask.lastUpdateAt = Date.now();

    // Optionally send manual progress update
    if (sendMessage && this.config.enableProgressUpdates) {
      const progress = this.getProgress();
      const message = this.buildProgressMessage(progress);
      await sendMessage(message);
    }
  }

  /**
   * Send partial results (streaming)
   */
  async streamPartialResult(
    partialResult: string,
    sendMessage: (msg: string) => Promise<void>
  ): Promise<void> {
    if (!this.config.enableStreaming) return;

    const message = `📊 *Partial Results:*\n\n${partialResult}\n\n_Still working on the complete analysis..._`;
    await sendMessage(message);
  }

  /**
   * Complete the task
   */
  completeTask(): void {
    if (this.activeTask?.progressInterval) {
      clearInterval(this.activeTask.progressInterval);
    }
    this.activeTask = null;
  }

  /**
   * Estimate task duration from description
   */
  private estimateTask(taskDescription: string): TaskEstimate {
    const description = taskDescription.toLowerCase();

    // Simple heuristics (can be replaced with ML model later)
    const patterns = [
      // Very complex tasks (>5 minutes)
      {
        pattern: /build.*system|implement.*architecture|create.*infrastructure/,
        complexity: 'very-complex' as const,
        baseMs: 300000,
      },
      // Complex tasks (2-5 minutes)
      {
        pattern: /analyze.*codebase|review.*files|comprehensive|multi-step/,
        complexity: 'complex' as const,
        baseMs: 180000,
      },
      // Moderate tasks (30s-2min)
      {
        pattern: /search|find|read.*files|check|review/,
        complexity: 'moderate' as const,
        baseMs: 60000,
      },
      // Simple tasks (<30s)
      {
        pattern: /what|how|explain|tell me|status/,
        complexity: 'simple' as const,
        baseMs: 10000,
      },
    ];

    const match = patterns.find(p => p.pattern.test(description));
    const complexity = match?.complexity || 'moderate';
    const baseMs = match?.baseMs || 60000;

    // Adjust based on keywords
    let estimatedMs = baseMs;

    if (description.includes('all') || description.includes('every')) {
      estimatedMs *= 2;
    }

    if (description.includes('quick') || description.includes('brief')) {
      estimatedMs *= 0.5;
    }

    // Generate steps based on complexity
    const steps = this.generateSteps(complexity, estimatedMs);

    return {
      estimatedDurationMs: estimatedMs,
      estimatedDurationHuman: this.formatDuration(estimatedMs),
      complexity,
      steps,
    };
  }

  /**
   * Generate task steps based on complexity
   */
  private generateSteps(
    complexity: TaskEstimate['complexity'],
    totalMs: number
  ): TaskEstimate['steps'] {
    const stepTemplates = {
      'simple': [
        { name: 'Understanding request', percent: 0.2 },
        { name: 'Executing task', percent: 0.6 },
        { name: 'Formatting response', percent: 0.2 },
      ],
      'moderate': [
        { name: 'Analyzing request', percent: 0.15 },
        { name: 'Searching codebase', percent: 0.3 },
        { name: 'Processing results', percent: 0.35 },
        { name: 'Generating response', percent: 0.2 },
      ],
      'complex': [
        { name: 'Planning approach', percent: 0.1 },
        { name: 'Gathering information', percent: 0.25 },
        { name: 'Analyzing data', percent: 0.3 },
        { name: 'Synthesizing findings', percent: 0.25 },
        { name: 'Formatting results', percent: 0.1 },
      ],
      'very-complex': [
        { name: 'Breaking down requirements', percent: 0.1 },
        { name: 'Exploring codebase', percent: 0.2 },
        { name: 'Designing solution', percent: 0.15 },
        { name: 'Implementing changes', percent: 0.35 },
        { name: 'Testing and validation', percent: 0.15 },
        { name: 'Documentation', percent: 0.05 },
      ],
    };

    const template = stepTemplates[complexity];
    return template.map(step => ({
      name: step.name,
      estimatedMs: Math.round(totalMs * step.percent),
    }));
  }

  /**
   * Build acknowledgment message
   */
  private buildAcknowledgmentMessage(
    taskDescription: string,
    estimate: TaskEstimate
  ): string {
    const emoji = {
      'simple': '⚡',
      'moderate': '🔍',
      'complex': '🛠️',
      'very-complex': '🏗️',
    }[estimate.complexity];

    let message = `${emoji} Got it! `;

    if (this.config.enableEstimation) {
      message += `This will take ${estimate.estimatedDurationHuman}. `;
    }

    message += `I'll notify you when done!`;

    return message;
  }

  /**
   * Build progress message
   */
  private buildProgressMessage(progress: ProgressUpdate): string {
    const percent = Math.round(progress.percentComplete);
    const bar = this.buildProgressBar(percent);

    return `⏳ *Progress Update*

${bar} ${percent}%

*Current step:* ${progress.stepName} (${progress.currentStep}/${progress.totalSteps})
*Elapsed:* ${this.formatDuration(progress.elapsedMs)}
*Estimated remaining:* ${this.formatDuration(progress.estimatedRemainingMs)}`;
  }

  /**
   * Build visual progress bar
   */
  private buildProgressBar(percent: number): string {
    const filled = Math.round(percent / 10);
    const empty = 10 - filled;
    return '▓'.repeat(filled) + '░'.repeat(empty);
  }

  /**
   * Get current progress
   */
  private getProgress(): ProgressUpdate {
    if (!this.activeTask) {
      throw new Error('No active task');
    }

    const elapsedMs = Date.now() - this.activeTask.startedAt;
    const totalSteps = this.activeTask.estimate.steps.length;
    const currentStep = Math.min(this.activeTask.currentStep, totalSteps);

    // Calculate percent based on elapsed time vs estimate
    const estimatedMs = this.activeTask.estimate.estimatedDurationMs;
    const percentByTime = Math.min((elapsedMs / estimatedMs) * 100, 95); // Cap at 95%
    const percentBySteps = (currentStep / totalSteps) * 100;

    // Use average of both methods
    const percentComplete = (percentByTime + percentBySteps) / 2;

    const estimatedRemainingMs = Math.max(
      estimatedMs - elapsedMs,
      5000 // At least 5 seconds remaining
    );

    const stepName = currentStep > 0 && currentStep <= totalSteps
      ? this.activeTask.estimate.steps[currentStep - 1].name
      : 'Starting...';

    return {
      currentStep,
      totalSteps,
      stepName,
      percentComplete,
      elapsedMs,
      estimatedRemainingMs,
    };
  }

  /**
   * Start automatic progress updates
   */
  private startProgressUpdates(sendMessage: (msg: string) => Promise<void>): void {
    if (!this.activeTask) return;

    this.activeTask.progressInterval = setInterval(async () => {
      if (!this.activeTask) {
        return;
      }

      const progress = this.getProgress();
      const message = this.buildProgressMessage(progress);

      try {
        await sendMessage(message);
      } catch (err) {
        console.error('Failed to send progress update:', err);
      }
    }, this.config.progressIntervalMs);
  }

  /**
   * Format duration as human-readable string
   */
  private formatDuration(ms: number): string {
    const seconds = Math.round(ms / 1000);

    if (seconds < 60) {
      return `~${seconds} seconds`;
    }

    const minutes = Math.round(seconds / 60);

    if (minutes < 60) {
      return `~${minutes} minute${minutes === 1 ? '' : 's'}`;
    }

    const hours = Math.round(minutes / 60);
    return `~${hours} hour${hours === 1 ? '' : 's'}`;
  }
}

/**
 * Factory for response time manager
 */
export class ResponseTimeManagerFactory {
  /**
   * Create with all features enabled (Option 4)
   */
  static create(): ResponseTimeManager {
    return new ResponseTimeManager({
      enableAcknowledgment: true,
      enableProgressUpdates: true,
      progressIntervalMs: 60000, // 1 minute
      enableStreaming: true,
      enableEstimation: true,
      minTaskDurationForProgress: 30000, // 30 seconds
    });
  }

  /**
   * Create minimal (acknowledgment only)
   */
  static createMinimal(): ResponseTimeManager {
    return new ResponseTimeManager({
      enableAcknowledgment: true,
      enableProgressUpdates: false,
      enableStreaming: false,
      enableEstimation: false,
    });
  }

  /**
   * Create for long tasks (frequent updates)
   */
  static createVerbose(): ResponseTimeManager {
    return new ResponseTimeManager({
      enableAcknowledgment: true,
      enableProgressUpdates: true,
      progressIntervalMs: 30000, // 30 seconds
      enableStreaming: true,
      enableEstimation: true,
      minTaskDurationForProgress: 15000, // 15 seconds
    });
  }
}
