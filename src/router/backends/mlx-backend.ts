/**
 * Local Model Backend
 * Interface with Ollama (or any OpenAI-compatible server) for local inference
 * Default: Ollama on port 11434
 */

export interface MLXModelConfig {
  modelId: string;
  modelPath: string; // Ollama model name (e.g. "qwen2.5-coder")
  quantization?: '4bit' | '8bit' | 'fp16' | 'fp32';
  maxTokens: number;
  temperature?: number;
  memoryGb?: number;
}

export interface MLXInferenceRequest {
  modelId: string;
  prompt: string;
  systemPrompt?: string;
  images?: string[]; // Base64 or file paths
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
}

export interface MLXInferenceResponse {
  text: string;
  tokensGenerated: number;
  latencyMs: number;
  tokensThroughput: number; // tokens/sec
}

/**
 * Local model backend for inference via Ollama or any OpenAI-compatible server
 */
export class MLXBackend {
  private loadedModels = new Map<string, LoadedModel>();
  private maxLoadedModels = 2;
  private serverUrl: string;

  constructor(private config: MLXBackendConfig) {
    this.serverUrl = config.serverUrl || 'http://127.0.0.1:11434';
  }

  /**
   * Check if the MLX server is reachable
   */
  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${this.serverUrl}/v1/models`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Run inference on a model
   */
  async inference(request: MLXInferenceRequest): Promise<MLXInferenceResponse> {
    const startTime = Date.now();

    // Resolve the HuggingFace model path for the server
    const modelConfig = this.config.models.get(request.modelId);
    const hfModel = modelConfig?.modelPath || request.modelId;

    // Build messages array
    const messages: Array<{ role: string; content: string }> = [];
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    messages.push({ role: 'user', content: request.prompt });

    // Call the OpenAI-compatible endpoint
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const res = await fetch(`${this.serverUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: hfModel,
          messages,
          max_tokens: request.maxTokens || 500,
          temperature: request.temperature ?? modelConfig?.temperature ?? 0.7,
          stop: request.stopSequences,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Local model server returned ${res.status}: ${body}`);
      }

      const data = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
        usage?: { completion_tokens?: number; prompt_tokens?: number; total_tokens?: number };
      };

      const text = data.choices?.[0]?.message?.content || '';
      const tokensGenerated = data.usage?.completion_tokens || 0;
      const latencyMs = Date.now() - startTime;
      const tokensThroughput = latencyMs > 0 ? (tokensGenerated / latencyMs) * 1000 : 0;

      // Track model usage
      this.trackUsage(request.modelId, modelConfig);

      return { text, tokensGenerated, latencyMs, tokensThroughput };
    } catch (err: unknown) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Local model inference timed out after 30s for ${request.modelId}`);
      }
      throw err;
    }
  }

  /**
   * Preload a model (no-op — mlx_lm.server manages model loading)
   */
  async preloadModel(modelId: string): Promise<void> {
    const modelConfig = this.config.models.get(modelId);
    if (!modelConfig) {
      throw new Error(`Model not found in config: ${modelId}`);
    }
    // Server handles model loading; just register it as "loaded"
    if (!this.loadedModels.has(modelId)) {
      this.loadedModels.set(modelId, {
        config: modelConfig,
        loadedAt: new Date(),
        lastUsedAt: new Date(),
        inferenceCount: 0,
      });
    }
  }

  /**
   * Unload a model (no-op — server manages memory)
   */
  async unloadModel(modelId: string): Promise<void> {
    this.loadedModels.delete(modelId);
  }

  /**
   * Get loaded models info
   */
  getLoadedModels(): Array<{
    modelId: string;
    loadedAt: Date;
    lastUsedAt: Date;
    inferenceCount: number;
    memoryGb?: number;
  }> {
    return Array.from(this.loadedModels.entries()).map(([modelId, info]) => ({
      modelId,
      loadedAt: info.loadedAt,
      lastUsedAt: info.lastUsedAt,
      inferenceCount: info.inferenceCount,
      memoryGb: info.config.memoryGb,
    }));
  }

  /**
   * Estimate memory usage
   */
  getMemoryUsageGb(): number {
    let total = 0;
    this.loadedModels.forEach((loaded) => {
      total += loaded.config.memoryGb || 0;
    });
    return total;
  }

  private trackUsage(modelId: string, modelConfig?: MLXModelConfig): void {
    let loaded = this.loadedModels.get(modelId);
    if (!loaded && modelConfig) {
      loaded = {
        config: modelConfig,
        loadedAt: new Date(),
        lastUsedAt: new Date(),
        inferenceCount: 0,
      };
      this.loadedModels.set(modelId, loaded);
    }
    if (loaded) {
      loaded.lastUsedAt = new Date();
      loaded.inferenceCount++;
    }
  }
}

/**
 * MLX Backend Configuration
 */
export interface MLXBackendConfig {
  models: Map<string, MLXModelConfig>;
  mlxExecutable?: string;
  serverUrl?: string; // Ollama URL, defaults to http://127.0.0.1:11434
}

interface LoadedModel {
  config: MLXModelConfig;
  loadedAt: Date;
  lastUsedAt: Date;
  inferenceCount: number;
}

/**
 * Factory for creating local model backend with Ollama models
 */
export class MLXBackendFactory {
  static create(): MLXBackend {
    const config: MLXBackendConfig = {
      models: new Map([
        [
          'qwen2.5-coder',
          {
            modelId: 'qwen2.5-coder',
            modelPath: 'qwen2.5-coder',
            maxTokens: 8192,
            temperature: 0.7,
            memoryGb: 4.7,
          },
        ],
        [
          'deepseek-coder-v2',
          {
            modelId: 'deepseek-coder-v2',
            modelPath: 'deepseek-coder-v2',
            maxTokens: 8192,
            temperature: 0.7,
            memoryGb: 8.9,
          },
        ],
        [
          'llama3',
          {
            modelId: 'llama3',
            modelPath: 'llama3',
            maxTokens: 8192,
            temperature: 0.7,
            memoryGb: 4.7,
          },
        ],
      ]),
      serverUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
    };

    return new MLXBackend(config);
  }

  /**
   * Create with custom models
   */
  static createCustom(models: Map<string, MLXModelConfig>): MLXBackend {
    return new MLXBackend({ models });
  }
}

/**
 * Helper: Convert MLX response to standard format
 */
export function formatMLXResponse(
  response: MLXInferenceResponse,
): {
  content: string;
  metadata: {
    tokensGenerated: number;
    latencyMs: number;
    throughput: number;
  };
} {
  return {
    content: response.text,
    metadata: {
      tokensGenerated: response.tokensGenerated,
      latencyMs: response.latencyMs,
      throughput: response.tokensThroughput,
    },
  };
}
