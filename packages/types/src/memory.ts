export interface MemoryFact {
  id: string;
  content: string;
  relevance?: number;
  source?: string;
}

export interface MemoryChunkHit {
  id: string;
  content: string;
  relevance?: number;
  source?: string;
}

export interface MemoryThreadState {
  threadId: string;
  workingSummary?: string;
  userPreferences?: string[];
  openLoops?: string[];
  constraints?: string[];
}

type MaybePromise<T> = T | Promise<T>;

export interface MemoryStore {
  getThreadState(threadId: string): MaybePromise<MemoryThreadState | null>;
  getTopFacts(
    threadId: string,
    query: string,
    limit: number,
    /** When set, the project's facts are compiled alongside thread + global. */
    projectId?: string,
  ): MaybePromise<MemoryFact[]>;
  searchChunks?(
    threadId: string,
    query: string,
    topK?: number,
  ): MaybePromise<MemoryChunkHit[]>;
}
