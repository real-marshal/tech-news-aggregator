import type { Source } from '@/types/news';

const HN_API_BASE = 'https://hacker-news.firebaseio.com/v0';
const TOP_STORIES_LIMIT = 25;
const FETCH_TIMEOUT_MS = 10000;

export interface HNStory {
  id: number;
  title: string;
  url?: string;
  score: number;
  descendants: number;
  by: string;
  time: number;
  type: string;
}

export interface HNScrapedItem {
  id: string;
  title: string;
  url: string;
  source: Source;
}

export class HNScraperError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'HNScraperError';
  }
}

function isShowAskOrJobs(story: HNStory): boolean {
  const title = story.title.toLowerCase();
  return (
    title.startsWith('show hn:') ||
    title.startsWith('ask hn:') ||
    story.type === 'job' ||
    title.startsWith('hiring:') ||
    title.startsWith('who is hiring')
  );
}

async function fetchWithTimeout<T>(
  url: string,
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new HNScraperError(
        `HTTP error: ${response.status} ${response.statusText}`,
        'HTTP_ERROR'
      );
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof HNScraperError) {
      throw error;
    }

    if (error instanceof Error && error.name === 'AbortError') {
      throw new HNScraperError(
        `Request timed out after ${timeoutMs}ms`,
        'TIMEOUT_ERROR',
        error
      );
    }

    throw new HNScraperError(
      `Failed to fetch: ${error instanceof Error ? error.message : String(error)}`,
      'FETCH_ERROR',
      error instanceof Error ? error : undefined
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchTopStoryIds(): Promise<number[]> {
  const url = `${HN_API_BASE}/topstories.json`;
  return fetchWithTimeout<number[]>(url);
}

async function fetchStory(id: number): Promise<HNStory | null> {
  const url = `${HN_API_BASE}/item/${id}.json`;
  try {
    const story = await fetchWithTimeout<HNStory | null>(url);
    return story;
  } catch (error) {
    // Log and skip individual story fetch failures
    console.warn(`Failed to fetch HN story ${id}:`, error);
    return null;
  }
}

function storyToScrapedItem(story: HNStory): HNScrapedItem {
  const discussionUrl = `https://news.ycombinator.com/item?id=${story.id}`;

  return {
    id: `hn-${story.id}`,
    title: story.title,
    url: story.url ?? discussionUrl,
    source: {
      name: 'hackernews',
      url: discussionUrl,
      points: story.score,
      comments: story.descendants ?? 0,
    },
  };
}

export async function scrapeHackerNews(): Promise<HNScrapedItem[]> {
  try {
    const storyIds = await fetchTopStoryIds();

    // Fetch stories in parallel with a reasonable batch size
    const stories: (HNStory | null)[] = await Promise.all(
      storyIds.map((id) => fetchStory(id))
    );

    // Filter out nulls, Show/Ask/Jobs, and stories without required fields
    const validStories = stories.filter(
      (story): story is HNStory =>
        story !== null &&
        story.title !== undefined &&
        story.score !== undefined &&
        !isShowAskOrJobs(story)
    );

    // Sort by score (points) descending and take top 25
    const topStories = validStories
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_STORIES_LIMIT);

    return topStories.map(storyToScrapedItem);
  } catch (error) {
    if (error instanceof HNScraperError) {
      throw error;
    }

    throw new HNScraperError(
      `Failed to scrape Hacker News: ${error instanceof Error ? error.message : String(error)}`,
      'SCRAPE_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}
