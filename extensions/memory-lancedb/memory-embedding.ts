export type DurableMemoryEmbedding = {
  embed(text: string, options?: { timeoutMs?: number }): Promise<number[]>;
  embedBatch?(texts: string[], options?: { timeoutMs?: number }): Promise<number[][]>;
};
