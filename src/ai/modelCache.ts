import type { ModelCacheEntry } from "../types";

const CACHE_KEY = "modelCache";
const DEFAULT_MAX_AGE = 3_600_000; // 1 hour

export function getCachedModels(pluginData: Record<string, unknown>, providerId: string): string[] | null {
  const entries = (pluginData?.[CACHE_KEY] as ModelCacheEntry[] | undefined) ?? [];
  const entry = entries.find((e) => e.providerId === providerId);
  if (!entry) return null;
  return entry.models;
}

export function isCacheStale(
  pluginData: Record<string, unknown>,
  providerId: string,
  maxAgeMs: number = DEFAULT_MAX_AGE
): boolean {
  const entries = (pluginData?.[CACHE_KEY] as ModelCacheEntry[] | undefined) ?? [];
  const entry = entries.find((e) => e.providerId === providerId);
  if (!entry) return true;
  return Date.now() - entry.fetchedAt > maxAgeMs;
}

export function setCachedModels(
  pluginData: Record<string, unknown>,
  providerId: string,
  models: string[]
): void {
  const entries = (pluginData?.[CACHE_KEY] as ModelCacheEntry[] | undefined) ?? [];
  const idx = entries.findIndex((e) => e.providerId === providerId);
  const newEntry: ModelCacheEntry = {
    providerId,
    models,
    fetchedAt: Date.now(),
  };
  if (idx !== -1) {
    entries[idx] = newEntry;
  } else {
    entries.push(newEntry);
  }
  pluginData[CACHE_KEY] = entries;
}

export function clearCache(pluginData: Record<string, unknown>, providerId: string): void {
  const entries = (pluginData?.[CACHE_KEY] as ModelCacheEntry[] | undefined) ?? [];
  pluginData[CACHE_KEY] = entries.filter((e) => e.providerId !== providerId);
}
