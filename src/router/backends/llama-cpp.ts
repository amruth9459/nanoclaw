/**
 * llama.cpp Backend
 *
 * Manages a local `llama-server` process for $0 inference from on-disk GGUF
 * models (Q4_K_M by default). Unlike {@link ./mlx-backend.ts MLXBackend}, which
 * assumes an already-running OpenAI-compatible server (Ollama / mlx_lm.server),
 * this backend owns the **process lifecycle**: lazy spawn on first use, health
 * checks, auto-restart, and graceful shutdown on process exit.
 *
 * The HTTP surface llama-server exposes is OpenAI-compatible
 * (`POST /v1/chat/completions`, `GET /health`), so the inference path mirrors
 * MLXBackend and the two are interchangeable behind the router.
 *
 * Design notes:
 * - `spawnFn` and `fetchFn` are injectable so the lifecycle logic is unit-testable
 *   without llama.cpp installed or a real model on disk.
 * - Model auto-download is HITL-gated: {@link planDownload} only *describes* the
 *   download; {@link downloadModel} refuses unless explicitly approved, the URL is
 *   present, and the license is non-GPL (per task constraint).
 */

import { spawn as nodeSpawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

import type { ModelConfig } from '../types.js';

/** Minimal structural view of a spawned process (so tests can inject a fake). */
export interface SpawnedProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'exit', listener: (code: number | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

export type SpawnFn = (command: string, args: string[]) => SpawnedProcess;
export type FetchFn = typeof fetch;

export interface LlamaCppBackendConfig {
  /** Directory holding GGUF files. Default: ~/.nanoclaw/models */
  modelsDir?: string;
  /** Path to the llama-server executable. Default: 'llama-server' (on PATH). */
  executable?: string;
  /** Host to bind. Default: 127.0.0.1 (local-only — never bind publicly). */
  host?: string;
  /** First port to try; each model gets the next free port. Default: 8080. */
  basePort?: number;
  /** ms to wait for a freshly spawned server to become healthy. Default: 60s. */
  startupTimeoutMs?: number;
  /** Extra CLI args passed to llama-server (e.g. ['--ctx-size', '8192']). */
  extraArgs?: string[];
  /** Injectable spawn (tests). Defaults to child_process.spawn with stdio ignored. */
  spawnFn?: SpawnFn;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchFn?: FetchFn;
  /** Max consecutive auto-restart attempts before giving up. Default: 2. */
  maxRestarts?: number;
}

export interface LlamaCppInferenceRequest {
  modelId: string;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
}

export interface LlamaCppInferenceResponse {
  text: string;
  tokensGenerated: number;
  latencyMs: number;
  tokensThroughput: number; // tokens/sec
  modelId: string;
}

export interface DownloadPlan {
  modelId: string;
  /** Whether a download is actually needed (false if the GGUF is already present). */
  required: boolean;
  url?: string;
  destPath: string;
  approxSize: string;
  license?: string;
  /** Populated when the plan cannot proceed (missing URL, GPL license, etc.). */
  blockedReason?: string;
}

interface RunningServer {
  modelId: string;
  proc: SpawnedProcess;
  port: number;
  baseUrl: string;
  startedAt: number;
  restarts: number;
}

const DEFAULT_MODELS_DIR = path.join(os.homedir(), '.nanoclaw', 'models');

export class LlamaCppBackend {
  private readonly modelsDir: string;
  private readonly executable: string;
  private readonly host: string;
  private readonly basePort: number;
  private readonly startupTimeoutMs: number;
  private readonly extraArgs: string[];
  private readonly spawnFn: SpawnFn;
  private readonly fetchFn: FetchFn;
  private readonly maxRestarts: number;

  /** modelId → running server (one server per model). */
  private servers = new Map<string, RunningServer>();
  private nextPortOffset = 0;
  private exitHookInstalled = false;

  constructor(
    private readonly modelLookup: (modelId: string) => ModelConfig | undefined,
    config: LlamaCppBackendConfig = {},
  ) {
    this.modelsDir = config.modelsDir || process.env.NANOCLAW_MODELS_DIR || DEFAULT_MODELS_DIR;
    this.executable = config.executable || process.env.LLAMA_SERVER_BIN || 'llama-server';
    this.host = config.host || '127.0.0.1';
    this.basePort = config.basePort || 8080;
    this.startupTimeoutMs = config.startupTimeoutMs ?? 60_000;
    this.extraArgs = config.extraArgs || [];
    this.spawnFn =
      config.spawnFn ||
      ((cmd, args) => nodeSpawn(cmd, args, { stdio: 'ignore' }) as unknown as SpawnedProcess);
    this.fetchFn = config.fetchFn || ((...args: Parameters<FetchFn>) => fetch(...args));
    this.maxRestarts = config.maxRestarts ?? 2;
  }

  /** Absolute path where a model's GGUF file is expected on disk. */
  ggufPath(model: ModelConfig): string {
    const file = model.ggufFile || `${model.id}.gguf`;
    return path.isAbsolute(file) ? file : path.join(this.modelsDir, file);
  }

  /** True if the GGUF file for this model exists locally. */
  isModelPresent(modelId: string): boolean {
    const model = this.modelLookup(modelId);
    if (!model) return false;
    try {
      return fs.existsSync(this.ggufPath(model));
    } catch {
      return false;
    }
  }

  /**
   * Describe what downloading a model would entail — never downloads.
   * Used to build the HITL approval message before any bytes are fetched.
   */
  planDownload(modelId: string): DownloadPlan {
    const model = this.modelLookup(modelId);
    if (!model) {
      return {
        modelId,
        required: true,
        destPath: path.join(this.modelsDir, `${modelId}.gguf`),
        approxSize: 'unknown',
        blockedReason: `Unknown model: ${modelId}`,
      };
    }

    const destPath = this.ggufPath(model);
    const present = this.isModelPresent(modelId);
    const approxSize = this.estimateGgufSize(model);

    let blockedReason: string | undefined;
    if (!present) {
      if (!model.downloadUrl) {
        blockedReason =
          `No download URL configured for ${modelId}. ` +
          `Set the appropriate *_GGUF_URL env var to the verified GGUF source.`;
      } else if (model.license && /gpl/i.test(model.license)) {
        blockedReason = `License ${model.license} is GPL — blocked by non-GPL constraint.`;
      }
    }

    return {
      modelId,
      required: !present,
      url: model.downloadUrl,
      destPath,
      approxSize,
      license: model.license,
      blockedReason,
    };
  }

  /**
   * Download a model's GGUF to disk. Gated behind explicit approval — the caller
   * is responsible for obtaining HITL approval (see DownloadPlan) first.
   * Returns the destination path. Throws if not approved / blocked.
   */
  async downloadModel(modelId: string, opts: { approved: boolean }): Promise<string> {
    const plan = this.planDownload(modelId);
    if (!plan.required) return plan.destPath;
    if (!opts.approved) {
      throw new Error(`Download of ${modelId} not approved (HITL gate). ${plan.approxSize} required.`);
    }
    if (plan.blockedReason) {
      throw new Error(`Cannot download ${modelId}: ${plan.blockedReason}`);
    }
    if (!plan.url) {
      throw new Error(`Cannot download ${modelId}: no URL.`);
    }

    fs.mkdirSync(this.modelsDir, { recursive: true });
    const res = await this.fetchFn(plan.url);
    if (!res.ok) {
      throw new Error(`Download failed for ${modelId}: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const tmp = `${plan.destPath}.partial`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, plan.destPath);
    return plan.destPath;
  }

  /** Is a server currently running for this model? */
  isRunning(modelId: string): boolean {
    return this.servers.has(modelId);
  }

  /**
   * Run inference, lazily spawning (and if needed restarting) the server.
   */
  async inference(request: LlamaCppInferenceRequest): Promise<LlamaCppInferenceResponse> {
    const server = await this.ensureServer(request.modelId);
    const startTime = Date.now();

    const messages: Array<{ role: string; content: string }> = [];
    if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt });
    messages.push({ role: 'user', content: request.prompt });

    const body = JSON.stringify({
      model: request.modelId,
      messages,
      max_tokens: request.maxTokens ?? 512,
      temperature: request.temperature ?? 0.2,
      stop: request.stopSequences,
    });

    const data = await this.postChat(server.baseUrl, body);
    const text = data.choices?.[0]?.message?.content ?? '';
    const tokensGenerated = data.usage?.completion_tokens ?? 0;
    const latencyMs = Date.now() - startTime;

    return {
      text,
      tokensGenerated,
      latencyMs,
      tokensThroughput: latencyMs > 0 ? (tokensGenerated / latencyMs) * 1000 : 0,
      modelId: request.modelId,
    };
  }

  /** Ensure a healthy server exists for the model; spawn or restart as needed. */
  async ensureServer(modelId: string): Promise<RunningServer> {
    const existing = this.servers.get(modelId);
    if (existing && (await this.isHealthy(existing.baseUrl))) {
      return existing;
    }
    if (existing) {
      // Unhealthy — tear it down and (maybe) restart.
      const restarts = existing.restarts + 1;
      this.stopServer(modelId);
      if (restarts > this.maxRestarts) {
        throw new Error(`llama-server for ${modelId} failed health checks after ${this.maxRestarts} restarts`);
      }
      return this.spawnServer(modelId, restarts);
    }
    return this.spawnServer(modelId, 0);
  }

  private async spawnServer(modelId: string, restarts: number): Promise<RunningServer> {
    const model = this.modelLookup(modelId);
    if (!model) throw new Error(`Unknown model: ${modelId}`);

    const gguf = this.ggufPath(model);
    if (!fs.existsSync(gguf)) {
      throw new Error(
        `GGUF not found for ${modelId} at ${gguf}. Download it first (HITL-gated planDownload/downloadModel).`,
      );
    }

    const port = this.basePort + this.nextPortOffset++;
    const baseUrl = `http://${this.host}:${port}`;
    const args = [
      '-m', gguf,
      '--host', this.host,
      '--port', String(port),
      '--ctx-size', String(model.contextWindow || 8192),
      ...this.extraArgs,
    ];

    const proc = this.spawnFn(this.executable, args);
    proc.on('error', () => this.servers.delete(modelId));
    proc.on('exit', () => this.servers.delete(modelId));

    const server: RunningServer = {
      modelId,
      proc,
      port,
      baseUrl,
      startedAt: Date.now(),
      restarts,
    };
    this.servers.set(modelId, server);
    this.installExitHook();

    await this.waitForHealthy(baseUrl);
    return server;
  }

  /** Poll the health endpoint until ready or the startup timeout elapses. */
  private async waitForHealthy(baseUrl: string): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.isHealthy(baseUrl)) return;
      await delay(300);
    }
    throw new Error(`llama-server did not become healthy within ${this.startupTimeoutMs}ms`);
  }

  private async isHealthy(baseUrl: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 2000);
      const res = await this.fetchFn(`${baseUrl}/health`, { signal: controller.signal });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  }

  private async postChat(
    baseUrl: string,
    body: string,
  ): Promise<{
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { completion_tokens?: number };
  }> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await this.fetchFn(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      clearTimeout(t);
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`llama-server ${res.status}: ${errText.slice(0, 300)}`);
      }
      return (await res.json()) as Awaited<ReturnType<LlamaCppBackend['postChat']>>;
    } catch (err) {
      clearTimeout(t);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('llama-server inference timed out after 30s');
      }
      throw err;
    }
  }

  /** Stop one model's server. */
  stopServer(modelId: string): void {
    const server = this.servers.get(modelId);
    if (!server) return;
    try {
      server.proc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    this.servers.delete(modelId);
  }

  /** Stop all servers (called on process exit). */
  shutdown(): void {
    for (const modelId of Array.from(this.servers.keys())) {
      this.stopServer(modelId);
    }
  }

  getRunningModels(): Array<{ modelId: string; port: number; uptimeMs: number; restarts: number }> {
    const now = Date.now();
    return Array.from(this.servers.values()).map((s) => ({
      modelId: s.modelId,
      port: s.port,
      uptimeMs: now - s.startedAt,
      restarts: s.restarts,
    }));
  }

  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    const handler = () => this.shutdown();
    process.once('exit', handler);
    process.once('SIGINT', handler);
    process.once('SIGTERM', handler);
  }

  /** Rough on-disk size estimate for a Q4_K_M GGUF (~0.55 GB per 1B params). */
  private estimateGgufSize(model: ModelConfig): string {
    if (!model.paramCountB) return 'unknown';
    const gb = model.paramCountB * 0.64; // Q4_K_M ≈ 4.5 bits/param + overhead
    return `~${gb.toFixed(2)}GB`;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
