const DEFAULT_OLLAMA_MODEL = "nomic-embed-text";
const FALLBACK_VECTOR_SIZE = 256;
const FALLBACK_MODEL = "fallback-hash-v1";

function normalizeOllamaHost(host: string): string {
  return host.endsWith("/") ? host.slice(0, -1) : host;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function fallbackEmbedding(text: string): number[] {
  const vector = new Array<number>(FALLBACK_VECTOR_SIZE).fill(0);
  for (const token of tokenize(text)) {
    const hash = hashToken(token);
    const slot = hash % FALLBACK_VECTOR_SIZE;
    const direction = (hash & 1) === 0 ? 1 : -1;
    vector[slot] = (vector[slot] ?? 0) + direction;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) {
    return vector;
  }
  return vector.map((value) => value / magnitude);
}

function toEmbeddingArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const embedding = value.filter((entry) => typeof entry === "number") as number[];
  if (!embedding.length || embedding.length !== value.length) {
    return null;
  }
  return embedding;
}

function toEmbeddingMatrix(value: unknown): number[][] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const matrix: number[][] = [];
  for (const entry of value) {
    const embedding = toEmbeddingArray(entry);
    if (!embedding) {
      return null;
    }
    matrix.push(embedding);
  }
  return matrix;
}

type EmbedBatchResult = {
  embeddings: number[][];
  provider: "ollama" | "fallback";
  model: string;
};

export type EmbeddingMetadata = {
  provider: string;
  model: string;
  dimensions: number;
};

async function embedBatchInternal(texts: string[]): Promise<EmbedBatchResult> {
  if (!texts.length) {
    return {
      embeddings: [],
      provider: "fallback",
      model: FALLBACK_MODEL,
    };
  }

  const host = process.env.OLLAMA_HOST?.trim();
  if (!host) {
    return {
      embeddings: texts.map((text) => fallbackEmbedding(text)),
      provider: "fallback",
      model: FALLBACK_MODEL,
    };
  }

  try {
    const response = await fetch(`${normalizeOllamaHost(host)}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: DEFAULT_OLLAMA_MODEL,
        input: texts,
      }),
    });
    if (!response.ok) {
      throw new Error(`Ollama embed request failed: ${response.status}`);
    }
    const payload = (await response.json()) as {
      embeddings?: unknown;
      embedding?: unknown;
      data?: Array<{ embedding?: unknown }>;
    };

    const directBatch = toEmbeddingMatrix(payload.embeddings);
    if (directBatch && directBatch.length === texts.length) {
      return {
        embeddings: directBatch,
        provider: "ollama",
        model: DEFAULT_OLLAMA_MODEL,
      };
    }

    const nestedBatch = toEmbeddingMatrix(payload.data?.map((entry) => entry.embedding));
    if (nestedBatch && nestedBatch.length === texts.length) {
      return {
        embeddings: nestedBatch,
        provider: "ollama",
        model: DEFAULT_OLLAMA_MODEL,
      };
    }

    const single = toEmbeddingArray(payload.embedding);
    if (single && texts.length === 1) {
      return {
        embeddings: [single],
        provider: "ollama",
        model: DEFAULT_OLLAMA_MODEL,
      };
    }

    throw new Error("Missing embedding payload from Ollama.");
  } catch {
    return {
      embeddings: texts.map((text) => fallbackEmbedding(text)),
      provider: "fallback",
      model: FALLBACK_MODEL,
    };
  }
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const result = await embedBatchInternal(texts);
  return result.embeddings;
}

export async function embedBatchWithMetadata(
  texts: string[],
): Promise<{ embeddings: number[][]; metadata: EmbeddingMetadata }> {
  const result = await embedBatchInternal(texts);
  const dimensions = result.embeddings[0]?.length ?? 0;
  return {
    embeddings: result.embeddings,
    metadata: {
      provider: result.provider,
      model: result.model,
      dimensions,
    },
  };
}

export async function embedText(text: string): Promise<number[]> {
  const [embedding] = await embedBatch([text]);
  return embedding ?? fallbackEmbedding(text);
}

export function chunkText(text: string, size = 256, overlap = 32): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }
  if (size <= 0) {
    return [normalized];
  }
  const safeOverlap = Math.max(0, Math.min(overlap, size - 1));
  const step = Math.max(1, size - safeOverlap);
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const chunk = normalized.slice(start, start + size).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    if (start + size >= normalized.length) {
      break;
    }
    start += step;
  }
  return chunks;
}
