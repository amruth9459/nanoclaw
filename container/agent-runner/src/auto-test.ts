/**
 * Auto-Test System
 * Detects and runs related tests after file edits.
 *
 * - Triggers after file edits detected (via PreToolUse hook)
 * - Finds related test files (.test, .spec suffix, __tests__ dir)
 * - Detects project type (package.json → npm test, pytest.ini → pytest, etc.)
 * - Runs relevant tests
 * - Returns pass/fail status
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

export interface TestRunner {
  command: string;
  type: 'npm' | 'jest' | 'vitest' | 'pytest' | 'cargo' | 'go' | 'make' | 'unknown';
}

export interface TestResult {
  passed: boolean;
  testFiles: string[];
  runner: TestRunner;
  output: string;
  duration: number;
  error?: string;
}

function log(message: string): void {
  console.error(`[auto-test] ${message}`);
}

/**
 * Detect the test runner for a project based on config files.
 */
export function detectTestRunner(cwd: string): TestRunner {
  // Check package.json for test script
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const testScript = pkg.scripts?.test;

      if (testScript) {
        if (testScript.includes('vitest')) {
          return { command: 'npx vitest run', type: 'vitest' };
        }
        if (testScript.includes('jest')) {
          return { command: 'npx jest', type: 'jest' };
        }
        return { command: 'npm test --', type: 'npm' };
      }
    } catch { /* ignore parse errors */ }

    // Check for test framework in devDependencies
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.vitest) return { command: 'npx vitest run', type: 'vitest' };
      if (deps.jest) return { command: 'npx jest', type: 'jest' };
    } catch { /* ignore */ }
  }

  // Check for pytest
  if (
    fs.existsSync(path.join(cwd, 'pytest.ini')) ||
    fs.existsSync(path.join(cwd, 'pyproject.toml')) ||
    fs.existsSync(path.join(cwd, 'setup.py')) ||
    fs.existsSync(path.join(cwd, 'setup.cfg'))
  ) {
    return { command: 'python -m pytest', type: 'pytest' };
  }

  // Check for Cargo.toml (Rust)
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
    return { command: 'cargo test', type: 'cargo' };
  }

  // Check for go.mod
  if (fs.existsSync(path.join(cwd, 'go.mod'))) {
    return { command: 'go test ./...', type: 'go' };
  }

  // Check for Makefile with test target
  if (fs.existsSync(path.join(cwd, 'Makefile'))) {
    try {
      const makefile = fs.readFileSync(path.join(cwd, 'Makefile'), 'utf-8');
      if (/^test:/m.test(makefile)) {
        return { command: 'make test', type: 'make' };
      }
    } catch { /* ignore */ }
  }

  return { command: '', type: 'unknown' };
}

/**
 * Find test files related to a source file.
 * Searches for: file.test.ts, file.spec.ts, __tests__/file.ts, tests/test_file.py, etc.
 */
export function findRelatedTestFiles(filePath: string, cwd: string): string[] {
  const parsed = path.parse(filePath);
  const baseName = parsed.name;
  const ext = parsed.ext;
  const dir = parsed.dir;

  // Skip if the file itself is a test file
  if (isTestFile(filePath)) return [filePath];

  const candidates: string[] = [];

  // JavaScript/TypeScript test patterns
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext)) {
    candidates.push(
      path.join(dir, `${baseName}.test${ext}`),
      path.join(dir, `${baseName}.spec${ext}`),
      path.join(dir, '__tests__', `${baseName}${ext}`),
      path.join(dir, '__tests__', `${baseName}.test${ext}`),
      path.join(dir, '..', '__tests__', `${baseName}${ext}`),
      path.join(dir, '..', '__tests__', `${baseName}.test${ext}`),
      // Common test directory patterns
      path.join(cwd, 'test', `${baseName}.test${ext}`),
      path.join(cwd, 'tests', `${baseName}.test${ext}`),
      path.join(cwd, 'test', `${baseName}${ext}`),
      path.join(cwd, 'tests', `${baseName}${ext}`),
    );
  }

  // Python test patterns
  if (ext === '.py') {
    candidates.push(
      path.join(dir, `test_${baseName}.py`),
      path.join(dir, `${baseName}_test.py`),
      path.join(dir, 'tests', `test_${baseName}.py`),
      path.join(cwd, 'tests', `test_${baseName}.py`),
      path.join(cwd, 'test', `test_${baseName}.py`),
    );
  }

  // Rust test pattern: tests live in the same file or in tests/ directory
  if (ext === '.rs') {
    candidates.push(
      path.join(cwd, 'tests', `${baseName}.rs`),
    );
  }

  // Go test pattern: same directory, _test.go suffix
  if (ext === '.go') {
    candidates.push(
      path.join(dir, `${baseName}_test.go`),
    );
  }

  // Return only candidates that actually exist
  const existing = candidates
    .map(c => path.resolve(cwd, c))
    .filter(c => fs.existsSync(c));

  return [...new Set(existing)]; // deduplicate
}

/**
 * Check if a file is a test file.
 */
function isTestFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return (
    base.includes('.test.') ||
    base.includes('.spec.') ||
    base.startsWith('test_') ||
    base.endsWith('_test.py') ||
    base.endsWith('_test.go') ||
    filePath.includes('__tests__')
  );
}

/**
 * Run tests for specific files.
 */
export async function runTests(
  testFiles: string[],
  runner: TestRunner,
  cwd: string,
): Promise<TestResult> {
  if (runner.type === 'unknown' || !runner.command) {
    return {
      passed: true,
      testFiles,
      runner,
      output: 'No test runner detected — skipping',
      duration: 0,
    };
  }

  const start = Date.now();

  try {
    // Build command with specific test files
    let cmd: string;
    const relativeFiles = testFiles.map(f => path.relative(cwd, f));

    switch (runner.type) {
      case 'jest':
      case 'vitest':
        cmd = `${runner.command} ${relativeFiles.join(' ')} --no-coverage 2>&1`;
        break;
      case 'npm':
        cmd = `${runner.command} ${relativeFiles.join(' ')} 2>&1`;
        break;
      case 'pytest':
        cmd = `${runner.command} ${relativeFiles.join(' ')} -x 2>&1`;
        break;
      case 'go':
        // Go tests run by package, not file
        const dirs = [...new Set(relativeFiles.map(f => './' + path.dirname(f)))];
        cmd = `go test ${dirs.join(' ')} 2>&1`;
        break;
      case 'cargo':
        cmd = `cargo test 2>&1`;
        break;
      case 'make':
        cmd = `make test 2>&1`;
        break;
      default:
        cmd = `${runner.command} 2>&1`;
    }

    log(`Running: ${cmd}`);
    const output = execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      timeout: 120_000, // 2 minute timeout
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    });

    const duration = Date.now() - start;
    log(`Tests passed (${duration}ms)`);

    return {
      passed: true,
      testFiles,
      runner,
      output: output.slice(-2000), // Keep last 2000 chars
      duration,
    };
  } catch (err) {
    const duration = Date.now() - start;
    const output = err instanceof Error && 'stdout' in err
      ? String((err as any).stdout || '') + String((err as any).stderr || '')
      : String(err);

    log(`Tests failed (${duration}ms): ${output.slice(0, 200)}`);

    return {
      passed: false,
      testFiles,
      runner,
      output: output.slice(-2000),
      duration,
      error: output.slice(0, 500),
    };
  }
}

/**
 * Create a PreToolUse hook for Edit/Write that tracks edited files
 * and runs related tests when edits accumulate.
 *
 * Strategy: tracks edited files. When the agent uses a non-Edit/Write tool
 * (meaning it moved past editing), run tests for all accumulated files.
 */
export function createAutoTestHook(cwd: string): {
  editHook: HookCallback;
  triggerHook: HookCallback;
  getLastResult: () => TestResult | null;
} {
  const pendingFiles = new Set<string>();
  let lastResult: TestResult | null = null;
  let runnerCache: TestRunner | null = null;

  const editHook: HookCallback = async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const filePath = (preInput.tool_input as { file_path?: string })?.file_path;
    if (filePath && !isTestFile(filePath)) {
      pendingFiles.add(filePath);
    }
    return {};
  };

  // This hook runs on non-edit tools. If there are pending edits, run tests.
  const triggerHook: HookCallback = async (_input, _toolUseId, _context) => {
    if (pendingFiles.size === 0) return {};

    // Detect runner once
    if (!runnerCache) {
      runnerCache = detectTestRunner(cwd);
      if (runnerCache.type === 'unknown') {
        log('No test runner detected — auto-test disabled');
        pendingFiles.clear();
        return {};
      }
      log(`Detected test runner: ${runnerCache.type} (${runnerCache.command})`);
    }

    // Find test files for all pending edits
    const allTestFiles = new Set<string>();
    for (const file of pendingFiles) {
      const related = findRelatedTestFiles(file, cwd);
      for (const tf of related) {
        allTestFiles.add(tf);
      }
    }

    if (allTestFiles.size === 0) {
      log(`No test files found for ${pendingFiles.size} edited files — skipping`);
      pendingFiles.clear();
      return {};
    }

    const testFiles = [...allTestFiles];
    log(`Running ${testFiles.length} test file(s) for ${pendingFiles.size} edited file(s)`);
    pendingFiles.clear();

    lastResult = await runTests(testFiles, runnerCache, cwd);

    if (!lastResult.passed) {
      log(`Tests FAILED — agent should be notified`);
    }

    return {};
  };

  return {
    editHook,
    triggerHook,
    getLastResult: () => lastResult,
  };
}
