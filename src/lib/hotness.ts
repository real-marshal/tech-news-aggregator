import type { Source, SourceName } from '@/types/news';

/**
 * Cross-source normalization constants
 * These represent typical max values for each source to normalize engagement metrics
 * to a comparable scale before calculating hotness scores.
 */
const SOURCE_NORMALIZATION: Record<
  SourceName,
  { maxUpvotes: number; maxComments: number }
> = {
  hackernews: { maxUpvotes: 1000, maxComments: 500 },
  reddit: { maxUpvotes: 5000, maxComments: 1000 },
  lobsters: { maxUpvotes: 100, maxComments: 100 },
  devto: { maxUpvotes: 500, maxComments: 100 },
};

export interface SourceStats {
  source: SourceName;
  upvotes: number;
  comments: number;
}

export interface NormalizationResult {
  normalizedUpvotes: number;
  normalizedComments: number;
  rawUpvotes: number;
  rawComments: number;
}

/**
 * Normalizes a value to a 0-1 scale based on a maximum reference value.
 * Values above the max are capped at 1.0 to prevent outliers from skewing results.
 */
function normalizeValue(value: number, maxValue: number): number {
  if (maxValue <= 0) return 0;
  return Math.min(value / maxValue, 1.0);
}

/**
 * Extracts upvotes from a source, handling different property names.
 * HN and Lobsters use 'points', Reddit uses 'upvotes', dev.to uses 'points' (reactions)
 */
function getUpvotes(source: Source): number {
  return source.points ?? source.upvotes ?? 0;
}

/**
 * Normalizes engagement metrics for a single source.
 */
export function normalizeSourceMetrics(source: Source): NormalizationResult {
  const normalization = SOURCE_NORMALIZATION[source.name];
  const rawUpvotes = getUpvotes(source);
  const rawComments = source.comments;

  return {
    normalizedUpvotes: normalizeValue(rawUpvotes, normalization.maxUpvotes),
    normalizedComments: normalizeValue(rawComments, normalization.maxComments),
    rawUpvotes,
    rawComments,
  };
}

/**
 * Calculates the hotness score for a single source using the formula:
 * hotness = (upvotes * 0.5) + (comments * 0.5)
 *
 * The score is calculated on normalized values (0-1 scale) and then
 * scaled to a readable range (0-100).
 */
export function calculateSourceHotness(source: Source): number {
  const normalized = normalizeSourceMetrics(source);
  const hotness =
    normalized.normalizedUpvotes * 0.5 + normalized.normalizedComments * 0.5;
  return hotness * 100; // Scale to 0-100
}

/**
 * Calculates the combined hotness score for an item with multiple sources.
 *
 * For merged items (appearing on multiple platforms), we:
 * 1. Normalize each source's metrics independently
 * 2. Sum the normalized contributions from each source
 * 3. Apply a diminishing returns factor for multi-source items
 *
 * This ensures that:
 * - Items appearing on multiple sources get a boost (more visibility = more relevant)
 * - The boost is capped to prevent multi-source items from dominating
 * - Each source contributes proportionally based on its normalized engagement
 */
export function calculateHotnessScore(sources: Source[]): number {
  if (sources.length === 0) return 0;

  let totalNormalizedUpvotes = 0;
  let totalNormalizedComments = 0;

  for (const source of sources) {
    const normalized = normalizeSourceMetrics(source);
    totalNormalizedUpvotes += normalized.normalizedUpvotes;
    totalNormalizedComments += normalized.normalizedComments;
  }

  // Apply diminishing returns for multi-source items
  // First source counts fully, additional sources contribute at 50% rate
  const sourceMultiplier = 1 + (sources.length - 1) * 0.5;
  const avgNormalizedUpvotes = totalNormalizedUpvotes / sourceMultiplier;
  const avgNormalizedComments = totalNormalizedComments / sourceMultiplier;

  // Apply the hotness formula: (upvotes * 0.5) + (comments * 0.5)
  const baseHotness = avgNormalizedUpvotes * 0.5 + avgNormalizedComments * 0.5;

  // Multi-source bonus: items on multiple sources get a visibility boost
  // but capped to prevent domination
  const multiSourceBonus = Math.min((sources.length - 1) * 0.1, 0.3);
  const hotness = baseHotness * (1 + multiSourceBonus);

  // Scale to a readable range and round
  return Math.round(hotness * 1000);
}

/**
 * Dynamic normalization using actual data statistics.
 * Use this when processing a batch of items to get more accurate normalization
 * based on the actual data distribution.
 */
export interface BatchStats {
  hackernews: { maxUpvotes: number; maxComments: number };
  reddit: { maxUpvotes: number; maxComments: number };
  lobsters: { maxUpvotes: number; maxComments: number };
  devto: { maxUpvotes: number; maxComments: number };
}

/**
 * Calculates per-source statistics from a batch of sources.
 */
export function calculateBatchStats(allSources: Source[]): BatchStats {
  const stats: BatchStats = {
    hackernews: { maxUpvotes: 0, maxComments: 0 },
    reddit: { maxUpvotes: 0, maxComments: 0 },
    lobsters: { maxUpvotes: 0, maxComments: 0 },
    devto: { maxUpvotes: 0, maxComments: 0 },
  };

  for (const source of allSources) {
    const upvotes = getUpvotes(source);
    const stat = stats[source.name];
    stat.maxUpvotes = Math.max(stat.maxUpvotes, upvotes);
    stat.maxComments = Math.max(stat.maxComments, source.comments);
  }

  // Apply minimum thresholds to avoid division issues
  const minUpvotes = 10;
  const minComments = 5;

  for (const key of Object.keys(stats) as SourceName[]) {
    stats[key].maxUpvotes = Math.max(stats[key].maxUpvotes, minUpvotes);
    stats[key].maxComments = Math.max(stats[key].maxComments, minComments);
  }

  return stats;
}

/**
 * Calculates hotness score using dynamic batch statistics.
 * This provides more accurate normalization based on the actual data.
 */
export function calculateHotnessScoreWithStats(
  sources: Source[],
  batchStats: BatchStats
): number {
  if (sources.length === 0) return 0;

  let totalNormalizedUpvotes = 0;
  let totalNormalizedComments = 0;

  for (const source of sources) {
    const stat = batchStats[source.name];
    const upvotes = getUpvotes(source);
    totalNormalizedUpvotes += normalizeValue(upvotes, stat.maxUpvotes);
    totalNormalizedComments += normalizeValue(
      source.comments,
      stat.maxComments
    );
  }

  // Apply diminishing returns for multi-source items
  const sourceMultiplier = 1 + (sources.length - 1) * 0.5;
  const avgNormalizedUpvotes = totalNormalizedUpvotes / sourceMultiplier;
  const avgNormalizedComments = totalNormalizedComments / sourceMultiplier;

  // Apply the hotness formula: (upvotes * 0.5) + (comments * 0.5)
  const baseHotness = avgNormalizedUpvotes * 0.5 + avgNormalizedComments * 0.5;

  // Multi-source bonus
  const multiSourceBonus = Math.min((sources.length - 1) * 0.1, 0.3);
  const hotness = baseHotness * (1 + multiSourceBonus);

  return Math.round(hotness * 1000);
}

/**
 * Sorts items by hotness score in descending order.
 */
export function sortByHotness<T extends { hotness_score: number }>(
  items: T[]
): T[] {
  return [...items].sort((a, b) => b.hotness_score - a.hotness_score);
}
