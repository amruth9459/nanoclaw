/**
 * Safety Pulse - Temporal Layer Defense
 *
 * Re-injects critical safety rules every N turns to prevent context-loss-induced
 * rule forgetting (Summer Yue incident prevention).
 *
 * Inspired by: Pilot pre-flight checklists that repeat every hour
 */

export interface SafetyPulseConfig {
  enabled: boolean;
  intervalTurns: number; // Re-inject every N turns (default: 5)
  rules: string[];
}

export class SafetyPulse {
  private turnCount = 0;
  private config: SafetyPulseConfig;

  constructor(config: Partial<SafetyPulseConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      intervalTurns: config.intervalTurns ?? 5,
      rules: config.rules ?? this.getDefaultRules(),
    };
  }

  private getDefaultRules(): string[] {
    return [
      '⚠️ SAFETY REMINDER (Auto-injected every 5 turns):',
      '',
      '1. STRICT CONSTRAINT: You are a READ-ONLY agent for media files.',
      '   - /workspace/media/ is PHYSICALLY READ-ONLY (OS-enforced)',
      '   - You CANNOT delete, modify, or move files in /workspace/media/',
      '   - Any attempt will fail with permission error',
      '',
      '2. DESTRUCTIVE OPERATIONS require explicit approval:',
      '   - File deletion (outside /workspace/group/)',
      '   - Gmail delete/trash operations',
      '   - External message sending to unregistered contacts',
      '   - Wait for explicit "yes" or "approve" from owner via WhatsApp',
      '',
      '3. HITL GATE is active:',
      '   - Messages to unknown numbers blocked until approved',
      '   - Check HITL queue before assuming silence = approval',
      '',
      '4. Context Window Awareness:',
      '   - If you are processing 1,500+ pages, you WILL undergo compaction',
      '   - These rules are in SYSTEM PROMPT (survives compaction)',
      '   - This pulse reminder ensures temporal persistence',
      '',
      '5. Kill Switch:',
      '   - Owner can send "/stop" via WhatsApp to halt all operations',
      '   - launchctl unload also stops service immediately',
      '',
      '--- End Safety Pulse ---',
    ];
  }

  /**
   * Increment turn counter and return safety reminder if interval reached
   */
  public tick(): string | null {
    if (!this.config.enabled) {
      return null;
    }

    this.turnCount++;

    if (this.turnCount % this.config.intervalTurns === 0) {
      return this.config.rules.join('\n');
    }

    return null;
  }

  /**
   * Force a pulse (manual trigger)
   */
  public forcePulse(): string {
    return this.config.rules.join('\n');
  }

  /**
   * Reset turn counter (e.g., on context reset)
   */
  public reset(): void {
    this.turnCount = 0;
  }

  /**
   * Get current turn count
   */
  public getTurnCount(): number {
    return this.turnCount;
  }
}
