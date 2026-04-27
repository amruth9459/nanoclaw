import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const REPO_ROOT = resolve(new URL('../..', import.meta.url).pathname);
export const SWEEPER_DIR = join(REPO_ROOT, '.claude', 'sweeper');
export const ITEMS_DIR = join(SWEEPER_DIR, 'items');
export const CLOSED_DIR = join(SWEEPER_DIR, 'closed');
export const PINNED_DIR = join(SWEEPER_DIR, 'pinned');

export type ItemKind = 'task' | 'wt';
export type Decision = 'keep_open' | 'proposed_close';

export interface SweeperItem {
  id: string;
  kind: ItemKind;
  title: string;
  snapshot: string;
  payload: Record<string, unknown>;
}

export interface SweeperReport {
  id: string;
  kind: ItemKind;
  title: string;
  decision: Decision;
  reason: string;
  evidence: string[];
  snapshot: string;
  reviewedAt: string;
  payload: Record<string, unknown>;
}

export function ensureDirs(): void {
  for (const d of [SWEEPER_DIR, ITEMS_DIR, CLOSED_DIR, PINNED_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

export function isPinned(itemId: string): boolean {
  return existsSync(join(PINNED_DIR, itemId));
}

export function snapshotHash(parts: Array<string | number | null | undefined>): string {
  const s = parts.map(p => (p === null || p === undefined ? '' : String(p))).join('|');
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

const REPORT_FRONT = '<!-- sweeper-report -->';

export function writeReport(report: SweeperReport, dir = ITEMS_DIR): string {
  const path = join(dir, `${report.id}.md`);
  const body = renderReport(report);
  writeFileSync(path, body, 'utf8');
  return path;
}

export function renderReport(r: SweeperReport): string {
  const lines: string[] = [
    REPORT_FRONT,
    `# ${r.kind === 'task' ? 'Task' : 'Worktree'} review: ${r.title}`,
    '',
    `- **id:** \`${r.id}\``,
    `- **kind:** ${r.kind}`,
    `- **decision:** ${r.decision}`,
    `- **snapshot:** \`${r.snapshot}\``,
    `- **reviewed_at:** ${r.reviewedAt}`,
    '',
    `## Reason`,
    '',
    r.reason,
    '',
  ];
  if (r.evidence.length) {
    lines.push('## Evidence', '');
    for (const e of r.evidence) lines.push(`- ${e}`);
    lines.push('');
  }
  lines.push('## Payload', '', '```json', JSON.stringify(r.payload, null, 2), '```', '');
  return lines.join('\n');
}

export function readReport(path: string): SweeperReport | null {
  if (!existsSync(path)) return null;
  const txt = readFileSync(path, 'utf8');
  if (!txt.startsWith(REPORT_FRONT)) return null;
  const idMatch = txt.match(/- \*\*id:\*\* `([^`]+)`/);
  const kindMatch = txt.match(/- \*\*kind:\*\* (\w+)/);
  const decMatch = txt.match(/- \*\*decision:\*\* (\w+)/);
  const snapMatch = txt.match(/- \*\*snapshot:\*\* `([^`]+)`/);
  const tsMatch = txt.match(/- \*\*reviewed_at:\*\* (\S+)/);
  const titleMatch = txt.match(/^# .*?: (.+)$/m);
  const reasonMatch = txt.match(/## Reason\n\n([\s\S]*?)\n\n##/);
  const payloadMatch = txt.match(/## Payload\n\n```json\n([\s\S]*?)\n```/);
  if (!idMatch || !kindMatch || !decMatch || !snapMatch || !tsMatch) return null;
  let payload: Record<string, unknown> = {};
  try {
    if (payloadMatch) payload = JSON.parse(payloadMatch[1]);
  } catch {}
  const evidenceMatches = [...txt.matchAll(/^- (.+)$/gm)]
    .map(m => m[1])
    .filter(line => !line.startsWith('**'));
  return {
    id: idMatch[1],
    kind: kindMatch[1] as ItemKind,
    title: titleMatch?.[1] ?? '',
    decision: decMatch[1] as Decision,
    snapshot: snapMatch[1],
    reviewedAt: tsMatch[1],
    reason: reasonMatch?.[1].trim() ?? '',
    evidence: evidenceMatches,
    payload,
  };
}

export function listReports(dir: string): SweeperReport[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => readReport(join(dir, f)))
    .filter((r): r is SweeperReport => r !== null);
}

export function archiveReport(reportId: string): boolean {
  const src = join(ITEMS_DIR, `${reportId}.md`);
  if (!existsSync(src)) return false;
  const dst = join(CLOSED_DIR, `${reportId}.md`);
  renameSync(src, dst);
  return true;
}

export function unarchiveReport(reportId: string): boolean {
  const src = join(CLOSED_DIR, `${reportId}.md`);
  if (!existsSync(src)) return false;
  const dst = join(ITEMS_DIR, `${reportId}.md`);
  renameSync(src, dst);
  return true;
}

export function git(args: string[], cwd: string = REPO_ROOT): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export interface WorktreeInfo {
  path: string;
  name: string;
  branch: string;
  head: string;
  dirty: boolean;
  lastCommitTs: number;
  isMain: boolean;
}

export function listWorktrees(): WorktreeInfo[] {
  const raw = git(['worktree', 'list', '--porcelain']);
  const blocks = raw.split('\n\n').filter(Boolean);
  const main = REPO_ROOT;
  const out: WorktreeInfo[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const path = lines.find(l => l.startsWith('worktree '))?.slice(9) ?? '';
    const head = lines.find(l => l.startsWith('HEAD '))?.slice(5) ?? '';
    const branchLine = lines.find(l => l.startsWith('branch '))?.slice(7) ?? '';
    const branch = branchLine.replace(/^refs\/heads\//, '');
    if (!path) continue;
    const isMain = resolve(path) === resolve(main);
    let dirty = false;
    let lastCommitTs = 0;
    try {
      const status = git(['status', '--porcelain'], path);
      dirty = status.length > 0;
      lastCommitTs = Number(git(['log', '-1', '--format=%ct'], path)) || 0;
    } catch {
      // worktree dir gone or broken — treat as dirty=false, ts=0
    }
    const name = path.split('/').filter(Boolean).pop() ?? path;
    out.push({ path, name, branch, head, dirty, lastCommitTs, isMain });
  }
  return out;
}

export function isMergedToMain(branch: string): boolean {
  try {
    const merged = git(['branch', '--merged', 'main']).split('\n').map(s => s.trim().replace(/^\* /, ''));
    return merged.includes(branch);
  } catch {
    return false;
  }
}

export function branchExists(branch: string): boolean {
  try {
    git(['rev-parse', '--verify', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export function removeWorktree(path: string): void {
  // git worktree remove fails if dirty — caller validates first
  git(['worktree', 'remove', path]);
}

export function deleteBranch(branch: string, force = false): void {
  git(['branch', force ? '-D' : '-d', branch]);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Days since timestamp. Auto-detects ms vs seconds (>1e12 = ms). */
export function daysSince(ts: number): number {
  if (!ts || ts <= 0) return Infinity;
  const seconds = ts > 1e12 ? ts / 1000 : ts;
  return (Date.now() / 1000 - seconds) / 86400;
}

export function deleteFile(path: string): void {
  rmSync(path, { force: true });
}

export function fileMtimeDaysAgo(path: string): number {
  try {
    return (Date.now() - statSync(path).mtimeMs) / 86_400_000;
  } catch {
    return Infinity;
  }
}
