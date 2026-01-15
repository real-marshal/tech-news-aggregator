import type { Source } from '@/types/news';

const DEVTO_API_BASE = 'https://dev.to/api';
const TOP_ARTICLES_LIMIT = 25;
const FETCH_TIMEOUT_MS = 10000;
const TOP_DAYS = 7; // Fetch top articles from the last 7 days

export interface DevtoArticle {
  id: number;
  title: string;
  description: string;
  readable_publish_date: string;
  slug: string;
  path: string;
  url: string;
  comments_count: number;
  public_reactions_count: number;
  positive_reactions_count: number;
  collection_id: number | null;
  published_timestamp: string;
  cover_image: string | null;
  social_image: string;
  canonical_url: string;
  created_at: string;
  edited_at: string | null;
  crossposted_at: string | null;
  published_at: string;
  last_comment_at: string;
  reading_time_minutes: number;
  tag_list: string[];
  tags: string;
  user: {
    name: string;
    username: string;
    twitter_username: string | null;
    github_username: string | null;
    user_id: number;
    website_url: string | null;
    profile_image: string;
    profile_image_90: string;
  };
  organization?: {
    name: string;
    username: string;
    slug: string;
    profile_image: string;
    profile_image_90: string;
  };
}

export interface DevtoScrapedItem {
  id: string;
  title: string;
  url: string;
  source: Source;
}

export class DevtoScraperError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'DevtoScraperError';
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
      throw new DevtoScraperError(
        `HTTP error: ${response.status} ${response.statusText}`,
        'HTTP_ERROR'
      );
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof DevtoScraperError) {
      throw error;
    }

    if (error instanceof Error && error.name === 'AbortError') {
      throw new DevtoScraperError(
        `Request timed out after ${timeoutMs}ms`,
        'TIMEOUT_ERROR',
        error
      );
    }

    throw new DevtoScraperError(
      `Failed to fetch: ${error instanceof Error ? error.message : String(error)}`,
      'FETCH_ERROR',
      error instanceof Error ? error : undefined
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchTopArticles(): Promise<DevtoArticle[]> {
  // Fetch top articles from the last 7 days, ordered by popularity
  // We fetch more than needed to ensure we get 25 after filtering
  const url = `${DEVTO_API_BASE}/articles?top=${TOP_DAYS}&per_page=50`;
  return fetchWithTimeout<DevtoArticle[]>(url);
}

function articleToScrapedItem(article: DevtoArticle): DevtoScrapedItem {
  // Use canonical_url if available, otherwise construct from url
  const mainUrl = article.canonical_url || article.url;

  // The article URL on dev.to is the discussion page
  const discussionUrl = article.url;

  return {
    id: `devto-${article.id}`,
    title: article.title,
    url: mainUrl,
    source: {
      name: 'devto',
      url: discussionUrl,
      points: article.positive_reactions_count,
      comments: article.comments_count,
    },
  };
}

export async function scrapeDevto(): Promise<DevtoScrapedItem[]> {
  try {
    const articles = await fetchTopArticles();

    // Filter out articles without required fields
    const validArticles = articles.filter(
      (article): article is DevtoArticle =>
        article.title !== undefined &&
        article.id !== undefined &&
        article.positive_reactions_count !== undefined
    );

    // Sort by positive_reactions_count descending and take top 25
    const topArticles = validArticles
      .sort((a, b) => b.positive_reactions_count - a.positive_reactions_count)
      .slice(0, TOP_ARTICLES_LIMIT);

    return topArticles.map(articleToScrapedItem);
  } catch (error) {
    if (error instanceof DevtoScraperError) {
      throw error;
    }

    throw new DevtoScraperError(
      `Failed to scrape dev.to: ${error instanceof Error ? error.message : String(error)}`,
      'SCRAPE_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}
