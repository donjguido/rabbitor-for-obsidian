import type { ModelCacheEntry } from "../types";

const CACHE_KEY = "modelCache";
const DEFAULT_MAX_AGE = 3_600_000; // 1 hour

export function getCachedModels(pluginData: any, providerId: string): string[] | null {
  const entries: ModelCacheEntry[] = pluginData?.[CACHE_KEY] || [];
  const entry = entries.find((e) => e.providerId === providerId);
  if (!entry) return null;
  return entry.models;
}

export function isCacheStale(
  pluginData: any,
  providerId: string,
  maxAgeMs: number = DEFAULT_MAX_AGE
): boolean {
  const entries: ModelCacheEntry[] = pluginData?.[CACHE_KEY] || [];
  const entry = entries.find((e) => e.providerId === providerId);
  if (!entry) return true;
  return Date.now() - entry.fetchedAt > maxAgeMs;
}

export function setCachedModels(
  pluginData: any,
  providerId: string,
  models: string[]
): void {
  const entries: ModelCacheEntry[] = pluginData?.[CACHE_KEY] || [];
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

export function clearCache(pluginData: any, providerId: string): void {
  const entries: ModelCacheEntry[] = pluginData?.[CACHE_KEY] || [];
  pluginData[CACHE_KEY] = entries.filter((e) => e.providerId !== providerId);
}
