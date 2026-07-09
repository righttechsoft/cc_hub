// Local text embedder wrapping transformers.js (ONNX, CPU). Lazily loads the model on first
// embed() so hub startup never waits on it; the ~25MB quantized model downloads on first use
// into data/models (gitignored). All failure modes degrade to FTS-only search upstream.
import type { HubConfig, Logger } from '../types.js';

export interface Embedder {
  readonly model: string;
  // Returns an L2-normalized vector (so L2 distance == cosine ranking downstream).
  embed(text: string): Promise<Float32Array>;
}

export interface EmbedderDeps {
  config: HubConfig;
  log: Logger;
  modelCacheDir: string;
}

type Extractor = (
  text: string,
  opts: { pooling: 'mean'; normalize: boolean }
) => Promise<{ data: Float32Array }>;

export function createEmbedder(deps: EmbedderDeps): Embedder {
  const { config, log, modelCacheDir } = deps;
  const model = config.athen.model;

  let initPromise: Promise<Extractor> | null = null;
  let warned = false;

  async function init(): Promise<Extractor> {
    // Dynamic import: if the onnxruntime native binary fails to load, only embedding breaks —
    // a static top-level import would crash the whole hub at startup.
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = modelCacheDir;
    const extractor = await pipeline('feature-extraction', model, { dtype: 'q8' });
    log.info(`athen: embedding model ready (${model})`);
    return extractor as unknown as Extractor;
  }

  return {
    model,
    async embed(text: string): Promise<Float32Array> {
      if (!initPromise) initPromise = init();
      let extractor: Extractor;
      try {
        extractor = await initPromise;
      } catch (err) {
        // Null the promise so a later call retries — covers "offline at first boot".
        initPromise = null;
        if (!warned) {
          warned = true;
          log.warn('athen: embedding model failed to load — semantic search degraded to FTS', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        throw err;
      }
      const out = await extractor(text, { pooling: 'mean', normalize: true });
      return out.data instanceof Float32Array ? out.data : new Float32Array(out.data);
    },
  };
}
