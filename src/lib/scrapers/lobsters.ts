import type { Source } from '@/types/news';

const LOBSTERS_API_BASE = 'https://lobste.rs';
const TOP_STORIES_LIMIT = 25;
const FETCH_TIMEOUT_MS = 10000;

export interface LobstersStory {
  short_id: string;
  created_at: string;
  title: string;
  url: string;
  score: number;
  flags: number;
  comment_count: number;
  description: string;
  description_plain: string;
  submitter_user: string;
  user_is_author: boolean;
  tags: string[];
  short_id_url: string;
  comments_url: string;
}

export interface LobstersScrapedItem {
  id: string;
  title: string;
  url: string;
  source: Source;
}

export class LobstersScraperError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'LobstersScraperError';
  }
}

async function fetchWithTimeout<T>(
  url: string,
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'TechDigest/1.0 (News Aggregator)',
      },
    });

    if (!response.ok) {
      throw new LobstersScraperError(
        `HTTP error: ${response.status} ${response.statusText}`,
        'HTTP_ERROR'
      );
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof LobstersScraperError) {
      throw error;
    }

    if (error instanceof Error && error.name === 'AbortError') {
      throw new LobstersScraperError(
        `Request timed out after ${timeoutMs}ms`,
        'TIMEOUT_ERROR',
        error
      );
    }

    throw new LobstersScraperError(
      `Failed to fetch: ${error instanceof Error ? error.message : String(error)}`,
      'FETCH_ERROR',
      error instanceof Error ? error : undefined
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchHottestStories(): Promise<LobstersStory[]> {
  const url = `${LOBSTERS_API_BASE}/hottest.json`;
  return fetchWithTimeout<LobstersStory[]>(url);
}

function storyToScrapedItem(story: LobstersStory): LobstersScrapedItem {
  // Use short_id_url as the discussion URL
  const discussionUrl = story.short_id_url;

  // If URL is empty (text post), use the discussion URL
  const mainUrl = story.url || discussionUrl;

  return {
    id: `lobsters-${story.short_id}`,
    title: story.title,
    url: mainUrl,
    source: {
      name: 'lobsters',
      url: discussionUrl,
      points: story.score,
      comments: story.comment_count,
      createdAt: story.created_at,
    },
  };
}

export async function scrapeLobsters(): Promise<LobstersScrapedItem[]> {
  try {
    const stories = await fetchHottestStories();

    // Filter out stories without required fields
    const validStories = stories.filter(
      (story): story is LobstersStory =>
        story.title !== undefined &&
        story.score !== undefined &&
        story.short_id !== undefined
    );

    // Sort by score descending and take top 25
    const topStories = validStories
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_STORIES_LIMIT);

    return topStories.map(storyToScrapedItem);
  } catch (error) {
    if (error instanceof LobstersScraperError) {
      throw error;
    }

    throw new LobstersScraperError(
      `Failed to scrape Lobste.rs: ${error instanceof Error ? error.message : String(error)}`,
      'SCRAPE_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}
