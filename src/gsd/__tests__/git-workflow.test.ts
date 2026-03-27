import { describe, it, expect } from 'vitest';
import {
  generateBranchName,
  generateCommitMessage,
  validateBranchName,
  validateCommitMessage,
  generatePRTemplate,
} from '../git-workflow.js';

// ── generateBranchName ──────────────────────────────────────────────────────

describe('generateBranchName', () => {
  it('generates feature branch', () => {
    expect(generateBranchName('PROJ-123', 'add auth', 'feature'))
      .toBe('feature/PROJ-123-add-auth');
  });

  it('generates bugfix branch', () => {
    expect(generateBranchName('PROJ-456', 'fix timeout', 'bugfix'))
      .toBe('bugfix/PROJ-456-fix-timeout');
  });

  it('generates hotfix branch', () => {
    expect(generateBranchName('SEC-789', 'patch security', 'hotfix'))
      .toBe('hotfix/SEC-789-patch-security');
  });

  it('defaults to feature type', () => {
    expect(generateBranchName('PROJ-1', 'something')).toBe('feature/PROJ-1-something');
  });

  it('sanitizes description to lowercase', () => {
    expect(generateBranchName('PROJ-1', 'Add SSO Login'))
      .toBe('feature/PROJ-1-add-sso-login');
  });

  it('removes special characters', () => {
    expect(generateBranchName('PROJ-1', "fix: user's @email"))
      .toBe('feature/PROJ-1-fix-users-email');
  });

  it('truncates long descriptions to 40 chars', () => {
    const longDesc = 'this is an extremely long description that exceeds forty characters limit';
    const branch = generateBranchName('PROJ-1', longDesc);
    const descPart = branch.replace('feature/PROJ-1-', '');
    expect(descPart.length).toBeLessThanOrEqual(40);
  });

  it('collapses multiple hyphens', () => {
    expect(generateBranchName('PROJ-1', 'fix -- double --- hyphens'))
      .toBe('feature/PROJ-1-fix-double-hyphens');
  });

  it('throws on invalid Jira ID', () => {
    expect(() => generateBranchName('invalid', 'desc')).toThrow('Invalid Jira ID format');
  });

  it('throws on lowercase Jira ID', () => {
    expect(() => generateBranchName('proj-123', 'desc')).toThrow('Invalid Jira ID format');
  });

  it('throws on Jira ID without number', () => {
    expect(() => generateBranchName('PROJ-', 'desc')).toThrow('Invalid Jira ID format');
  });
});

// ── validateBranchName ──────────────────────────────────────────────────────

describe('validateBranchName', () => {
  it('accepts valid feature branch', () => {
    const r = validateBranchName('feature/PROJ-123-add-auth');
    expect(r.valid).toBe(true);
  });

  it('accepts valid bugfix branch', () => {
    const r = validateBranchName('bugfix/PROJ-456-fix-timeout');
    expect(r.valid).toBe(true);
  });

  it('accepts valid hotfix branch', () => {
    const r = validateBranchName('hotfix/SEC-789-patch');
    expect(r.valid).toBe(true);
  });

  it('accepts valid release branch', () => {
    const r = validateBranchName('release/1.2.3');
    expect(r.valid).toBe(true);
  });

  it('rejects branch without prefix', () => {
    const r = validateBranchName('PROJ-123-add-auth');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('prefix');
  });

  it('rejects invalid prefix', () => {
    const r = validateBranchName('chore/PROJ-123-add-auth');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('Invalid prefix');
  });

  it('rejects branch without Jira ID', () => {
    const r = validateBranchName('feature/add-auth');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('Jira ID');
  });

  it('rejects invalid release version', () => {
    const r = validateBranchName('release/v1.2');
    expect(r.valid).toBe(false);
  });

  it('rejects uppercase description', () => {
    const r = validateBranchName('feature/PROJ-123-Add-Auth');
    expect(r.valid).toBe(false);
  });
});

// ── generateCommitMessage ───────────────────────────────────────────────────

describe('generateCommitMessage', () => {
  it('generates valid commit message', () => {
    expect(generateCommitMessage('PROJ-123', '✨', 'add SSO login flow'))
      .toBe('✨ PROJ-123: add SSO login flow');
  });

  it('generates with bug emoji', () => {
    expect(generateCommitMessage('BUG-456', '🐛', 'fix timeout in auth'))
      .toBe('🐛 BUG-456: fix timeout in auth');
  });

  it('truncates long descriptions to fit 72 chars', () => {
    const longDesc = 'a'.repeat(100);
    const msg = generateCommitMessage('PROJ-1', '✨', longDesc);
    expect(msg.length).toBeLessThanOrEqual(72);
  });

  it('throws on invalid Jira ID', () => {
    expect(() => generateCommitMessage('bad', '✨', 'desc')).toThrow('Invalid Jira ID');
  });

  it('throws on invalid gitmoji', () => {
    expect(() => generateCommitMessage('PROJ-1', '😀', 'desc')).toThrow('Invalid gitmoji');
  });

  it('accepts all documented gitmojis', () => {
    const gitmojis = ['🚀', '✨', '🐛', '♻️', '📚', '🧪', '💄', '🔧', '📦'];
    for (const g of gitmojis) {
      expect(() => generateCommitMessage('PROJ-1', g, 'test')).not.toThrow();
    }
  });
});

// ── validateCommitMessage ───────────────────────────────────────────────────

describe('validateCommitMessage', () => {
  it('accepts valid commit message', () => {
    const r = validateCommitMessage('✨ PROJ-123: add SSO login flow');
    expect(r.valid).toBe(true);
  });

  it('accepts bug fix message', () => {
    const r = validateCommitMessage('🐛 BUG-456: fix null pointer in auth');
    expect(r.valid).toBe(true);
  });

  it('accepts rocket emoji', () => {
    const r = validateCommitMessage('🚀 PROJ-1: deploy v2');
    expect(r.valid).toBe(true);
  });

  it('rejects message without gitmoji', () => {
    const r = validateCommitMessage('PROJ-123: add feature');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('gitmoji');
  });

  it('rejects message without Jira ID', () => {
    const r = validateCommitMessage('✨ add feature');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('Jira ID');
  });

  it('rejects overly long message', () => {
    const r = validateCommitMessage(`✨ PROJ-1: ${'a'.repeat(80)}`);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('72');
  });
});

// ── generatePRTemplate ──────────────────────────────────────────────────────

describe('generatePRTemplate', () => {
  it('generates full PR template', () => {
    const template = generatePRTemplate({
      jiraId: 'PROJ-123',
      branchName: 'feature/PROJ-123-add-auth',
      summary: 'Add SSO authentication',
      testingNotes: 'Run auth test suite',
    });

    expect(template).toContain('## What does this PR do?');
    expect(template).toContain('PROJ-123');
    expect(template).toContain('feature/PROJ-123-add-auth');
    expect(template).toContain('Add SSO authentication');
    expect(template).toContain('## Testing');
    expect(template).toContain('Run auth test suite');
    expect(template).toContain('## Risk and Security Review');
    expect(template).toContain('No significant risks identified');
  });

  it('includes custom risk notes', () => {
    const template = generatePRTemplate({
      jiraId: 'PROJ-1',
      branchName: 'feature/PROJ-1-auth',
      summary: 'Add auth',
      testingNotes: 'Test it',
      riskNotes: 'Modifies auth flow — test carefully',
    });

    expect(template).toContain('Modifies auth flow');
    expect(template).not.toContain('No significant risks');
  });

  it('includes Jira link section', () => {
    const template = generatePRTemplate({
      jiraId: 'SEC-789',
      branchName: 'hotfix/SEC-789-patch',
      summary: 'Security patch',
      testingNotes: 'Pen test required',
    });

    expect(template).toContain('## Jira Link');
    expect(template).toContain('Task: SEC-789');
    expect(template).toContain('Branch: `hotfix/SEC-789-patch`');
  });

  it('includes change summary section', () => {
    const template = generatePRTemplate({
      jiraId: 'PROJ-1',
      branchName: 'feature/PROJ-1-x',
      summary: '- Added login page\n- Added OAuth flow',
      testingNotes: 'Manual test',
    });

    expect(template).toContain('## Change Summary');
    expect(template).toContain('- Added login page');
    expect(template).toContain('- Added OAuth flow');
  });
});
