/**
 * GSD Git Workflow — Jira-linked branch names, commit messages, and PR templates
 *
 * Enforces traceable Git workflows:
 * - Branch naming: feature/JIRA-123-add-auth
 * - Commit messages: ✨ JIRA-123: add SSO login flow
 * - PR templates with Jira links and structured sections
 */

// ── Constants ────────────────────────────────────────────────────────────────

const JIRA_ID_REGEX = /^[A-Z]+-[0-9]+$/;

const BRANCH_REGEX = /^(feature|bugfix|hotfix)\/[A-Z]+-[0-9]+-[a-z0-9-]+$/;
const RELEASE_BRANCH_REGEX = /^release\/[0-9]+\.[0-9]+\.[0-9]+$/;

/** Official gitmoji catalog subset for commit validation */
const VALID_GITMOJIS = new Set([
  '🚀', '✨', '🐛', '♻️', '📚', '🧪', '💄', '🔧', '📦',
  '🔥', '🎨', '⚡', '🔒', '🩹', '🏗️', '✅', '🚚', '💚',
  '⬆️', '⬇️', '🗑️', '🩺', '🧱', '📝', '🔀', '🏷️', '💡',
]);

/** Subset used in commit message validation regex */
const COMMIT_GITMOJI_REGEX = /^(\u{1F680}|\u{2728}|\u{1F41B}|\u{267B}\u{FE0F}|\u{1F4DA}|\u{1F9EA}|\u{1F484}|\u{1F527}|\u{1F4E6})/u;

const MAX_DESCRIPTION_LENGTH = 40;
const MAX_COMMIT_LENGTH = 72;

// ── Branch Name ──────────────────────────────────────────────────────────────

export function generateBranchName(
  jiraId: string,
  description: string,
  type: 'feature' | 'bugfix' | 'hotfix' = 'feature',
): string {
  if (!JIRA_ID_REGEX.test(jiraId)) {
    throw new Error(`Invalid Jira ID format: "${jiraId}". Expected PROJECT-NUMBER (e.g. PROJ-123)`);
  }

  const sanitized = description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_DESCRIPTION_LENGTH);

  return `${type}/${jiraId}-${sanitized}`;
}

export function validateBranchName(branch: string): { valid: boolean; reason: string } {
  if (BRANCH_REGEX.test(branch)) {
    return { valid: true, reason: 'Valid branch name' };
  }
  if (RELEASE_BRANCH_REGEX.test(branch)) {
    return { valid: true, reason: 'Valid release branch' };
  }

  // Provide specific feedback
  if (!branch.includes('/')) {
    return { valid: false, reason: 'Missing type prefix (feature/, bugfix/, hotfix/, or release/)' };
  }

  const [prefix, rest] = branch.split('/', 2);
  if (!['feature', 'bugfix', 'hotfix', 'release'].includes(prefix)) {
    return { valid: false, reason: `Invalid prefix "${prefix}". Use feature/, bugfix/, hotfix/, or release/` };
  }

  if (prefix === 'release') {
    return { valid: false, reason: 'Release branch must use semver: release/X.Y.Z' };
  }

  if (!rest || !rest.match(/^[A-Z]+-[0-9]+/)) {
    return { valid: false, reason: 'Branch must include Jira ID after prefix (e.g. feature/PROJ-123-desc)' };
  }

  if (rest !== rest.toLowerCase().replace(/^[A-Z]+-[0-9]+/, (m) => m)) {
    return { valid: false, reason: 'Description after Jira ID must be lowercase with hyphens' };
  }

  return { valid: false, reason: 'Branch name does not match expected pattern: type/JIRA-123-description' };
}

// ── Commit Message ───────────────────────────────────────────────────────────

export function generateCommitMessage(
  jiraId: string,
  gitmoji: string,
  description: string,
): string {
  if (!JIRA_ID_REGEX.test(jiraId)) {
    throw new Error(`Invalid Jira ID format: "${jiraId}". Expected PROJECT-NUMBER (e.g. PROJ-123)`);
  }

  if (!VALID_GITMOJIS.has(gitmoji)) {
    throw new Error(`Invalid gitmoji: "${gitmoji}". Use an official gitmoji from https://gitmoji.dev/`);
  }

  const msg = `${gitmoji} ${jiraId}: ${description}`;
  if (msg.length > MAX_COMMIT_LENGTH) {
    const maxDesc = MAX_COMMIT_LENGTH - `${gitmoji} ${jiraId}: `.length;
    return `${gitmoji} ${jiraId}: ${description.slice(0, maxDesc)}`;
  }

  return msg;
}

export function validateCommitMessage(msg: string): { valid: boolean; reason: string } {
  if (!COMMIT_GITMOJI_REGEX.test(msg)) {
    return { valid: false, reason: 'Commit must start with a valid gitmoji (e.g. ✨, 🐛, 🚀)' };
  }

  // Extract the part after the gitmoji
  const afterEmoji = msg.replace(COMMIT_GITMOJI_REGEX, '').trimStart();

  if (!afterEmoji.match(/^[A-Z]+-[0-9]+: .+/)) {
    return { valid: false, reason: 'Must include Jira ID and description after gitmoji (e.g. ✨ PROJ-123: add feature)' };
  }

  if (msg.length > MAX_COMMIT_LENGTH) {
    return { valid: false, reason: `Commit message exceeds ${MAX_COMMIT_LENGTH} characters (${msg.length})` };
  }

  return { valid: true, reason: 'Valid commit message' };
}

// ── PR Template ──────────────────────────────────────────────────────────────

export interface PRTemplateOptions {
  jiraId: string;
  branchName: string;
  summary: string;
  testingNotes: string;
  riskNotes?: string;
}

export function generatePRTemplate(opts: PRTemplateOptions): string {
  const lines = [
    `## What does this PR do?`,
    ``,
    opts.summary,
    ``,
    `## Jira Link`,
    ``,
    `- Task: ${opts.jiraId}`,
    `- Branch: \`${opts.branchName}\``,
    ``,
    `## Change Summary`,
    ``,
    ...opts.summary.split('\n').map(line => line.startsWith('-') ? line : `- ${line}`),
    ``,
    `## Risk and Security Review`,
    ``,
    opts.riskNotes ?? 'No significant risks identified.',
    ``,
    `## Testing`,
    ``,
    opts.testingNotes,
  ];

  return lines.join('\n');
}
