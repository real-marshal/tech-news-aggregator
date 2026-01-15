import type { Source, SourceName } from '@/types/news';
import {
  scrapeHackerNews,
  HNScraperError,
  type HNScrapedItem,
} from './hackernews';
import {
  scrapeReddit,
  RedditScraperError,
  type RedditScrapedItem,
} from './reddit';
import {
  scrapeLobsters,
  LobstersScraperError,
  type LobstersScrapedItem,
} from './lobsters';
import { scrapeDevto, DevtoScraperError, type DevtoScrapedItem } from './devto';

export interface ScrapedItem {
  id: string;
  title: string;
  url: string;
  source: Source;
}

export interface SourceResult {
  source: SourceName;
  success: boolean;
  items: ScrapedItem[];
  error?: string;
  itemCount: number;
}

export interface OrchestratorResult {
  items: ScrapedItem[];
  sourceResults: SourceResult[];
  totalItems: number;
  successfulSources: SourceName[];
  failedSources: SourceName[];
}

export class OrchestratorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly sourceResults: SourceResult[]
  ) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

function normalizeHNItem(item: HNScrapedItem): ScrapedItem {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    source: item.source,
  };
}

function normalizeRedditItem(item: RedditScrapedItem): ScrapedItem {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    source: item.source,
  };
}

function normalizeLobstersItem(item: LobstersScrapedItem): ScrapedItem {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    source: item.source,
  };
}

function normalizeDevtoItem(item: DevtoScrapedItem): ScrapedItem {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    source: item.source,
  };
}

function getErrorMessage(error: unknown): string {
  if (
    error instanceof HNScraperError ||
    error instanceof RedditScraperError ||
    error instanceof LobstersScraperError ||
    error instanceof DevtoScraperError
  ) {
    return `${error.code}: ${error.message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function scrapeSource<T>(
  sourceName: SourceName,
  scraper: () => Promise<T[]>,
  normalizer: (item: T) => ScrapedItem
): Promise<SourceResult> {
  try {
    const items = await scraper();
    const normalizedItems = items.map(normalizer);

    console.log(`[${sourceName}] Successfully scraped ${items.length} items`);

    return {
      source: sourceName,
      success: true,
      items: normalizedItems,
      itemCount: normalizedItems.length,
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error(`[${sourceName}] Failed to scrape: ${errorMessage}`);

    return {
      source: sourceName,
      success: false,
      items: [],
      error: errorMessage,
      itemCount: 0,
    };
  }
}

export async function scrapeAllSources(): Promise<OrchestratorResult> {
  console.log('Starting scrape of all sources...');

  // Run all scrapers in parallel using Promise.allSettled
  const results = await Promise.allSettled([
    scrapeSource('hackernews', scrapeHackerNews, normalizeHNItem),
    scrapeSource('reddit', scrapeReddit, normalizeRedditItem),
    scrapeSource('lobsters', scrapeLobsters, normalizeLobstersItem),
    scrapeSource('devto', scrapeDevto, normalizeDevtoItem),
  ]);

  // Extract results from settled promises
  const sourceResults: SourceResult[] = results.map((result, index) => {
    const sourceNames: SourceName[] = [
      'hackernews',
      'reddit',
      'lobsters',
      'devto',
    ];

    if (result.status === 'fulfilled') {
      return result.value;
    }

    // This shouldn't happen since scrapeSource catches errors,
    // but handle it just in case
    const sourceName = sourceNames[index];
    console.error(
      `[${sourceName}] Unexpected promise rejection:`,
      result.reason
    );

    return {
      source: sourceName,
      success: false,
      items: [],
      error: `Unexpected error: ${getErrorMessage(result.reason)}`,
      itemCount: 0,
    };
  });

  // Aggregate all items
  const allItems = sourceResults.flatMap((result) => result.items);

  // Categorize sources by success/failure
  const successfulSources = sourceResults
    .filter((r) => r.success)
    .map((r) => r.source);

  const failedSources = sourceResults
    .filter((r) => !r.success)
    .map((r) => r.source);

  // Log summary
  console.log('\n=== Scrape Summary ===');
  console.log(`Total items scraped: ${allItems.length}`);
  console.log(
    `Successful sources (${successfulSources.length}): ${successfulSources.join(', ') || 'none'}`
  );
  console.log(
    `Failed sources (${failedSources.length}): ${failedSources.join(', ') || 'none'}`
  );

  for (const result of sourceResults) {
    const status = result.success ? 'OK' : 'FAILED';
    const details = result.success
      ? `${result.itemCount} items`
      : result.error;
    console.log(`  [${result.source}] ${status}: ${details}`);
  }

  // Throw error only if all sources failed
  if (successfulSources.length === 0) {
    throw new OrchestratorError(
      'All sources failed to scrape',
      'ALL_SOURCES_FAILED',
      sourceResults
    );
  }

  return {
    items: allItems,
    sourceResults,
    totalItems: allItems.length,
    successfulSources,
    failedSources,
  };
}
