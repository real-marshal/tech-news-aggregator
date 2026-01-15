import type { Source } from '@/types/news';

const REDDIT_API_BASE = 'https://www.reddit.com';
const TOP_POSTS_LIMIT = 25;
const MIN_UPVOTES = 100;
const FETCH_TIMEOUT_MS = 10000;

export const SUBREDDITS = [
  'programming',
  'webdev',
  'machinelearning',
  'netsec',
  'devops',
  'singularity',
  'coding',
  'artificial',
  'startups',
  'cscareerquestions',
  'experienceddevs',
] as const;

export type Subreddit = (typeof SUBREDDITS)[number];

export interface RedditPost {
  id: string;
  title: string;
  url: string;
  permalink: string;
  subreddit: string;
  ups: number;
  num_comments: number;
  is_self: boolean;
  selftext?: string;
  created_utc: number;
}

export interface RedditListingChild {
  kind: string;
  data: RedditPost;
}

export interface RedditListingData {
  children: RedditListingChild[];
  after: string | null;
}

export interface RedditListing {
  kind: string;
  data: RedditListingData;
}

export interface RedditScrapedItem {
  id: string;
  title: string;
  url: string;
  source: Source;
}

export class RedditScraperError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'RedditScraperError';
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

    if (response.status === 429) {
      throw new RedditScraperError(
        'Rate limited by Reddit API',
        'RATE_LIMIT_ERROR'
      );
    }

    if (!response.ok) {
      throw new RedditScraperError(
        `HTTP error: ${response.status} ${response.statusText}`,
        'HTTP_ERROR'
      );
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof RedditScraperError) {
      throw error;
    }

    if (error instanceof Error && error.name === 'AbortError') {
      throw new RedditScraperError(
        `Request timed out after ${timeoutMs}ms`,
        'TIMEOUT_ERROR',
        error
      );
    }

    throw new RedditScraperError(
      `Failed to fetch: ${error instanceof Error ? error.message : String(error)}`,
      'FETCH_ERROR',
      error instanceof Error ? error : undefined
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchSubredditTop(subreddit: Subreddit): Promise<RedditPost[]> {
  // Fetch top posts from the past day to get recent high-quality content
  const url = `${REDDIT_API_BASE}/r/${subreddit}/top.json?t=day&limit=100`;

  try {
    const listing = await fetchWithTimeout<RedditListing>(url);
    return listing.data.children.map((child) => child.data);
  } catch (error) {
    // Log and return empty array for individual subreddit failures
    console.warn(`Failed to fetch r/${subreddit}:`, error);
    return [];
  }
}

function postToScrapedItem(post: RedditPost): RedditScrapedItem {
  const discussionUrl = `https://www.reddit.com${post.permalink}`;

  // If it's a self post, use the discussion URL as the main URL
  const mainUrl = post.is_self || !post.url ? discussionUrl : post.url;

  return {
    id: `reddit-${post.subreddit}-${post.id}`,
    title: post.title,
    url: mainUrl,
    source: {
      name: 'reddit',
      url: discussionUrl,
      upvotes: post.ups,
      comments: post.num_comments,
      subreddit: `r/${post.subreddit}`,
    },
  };
}

export async function scrapeSubreddit(
  subreddit: Subreddit
): Promise<RedditScrapedItem[]> {
  try {
    const posts = await fetchSubredditTop(subreddit);

    // Filter posts with 100+ upvotes
    const highQualityPosts = posts.filter((post) => post.ups >= MIN_UPVOTES);

    // Sort by upvotes descending and take top 25
    const topPosts = highQualityPosts
      .sort((a, b) => b.ups - a.ups)
      .slice(0, TOP_POSTS_LIMIT);

    return topPosts.map(postToScrapedItem);
  } catch (error) {
    if (error instanceof RedditScraperError) {
      throw error;
    }

    throw new RedditScraperError(
      `Failed to scrape r/${subreddit}: ${error instanceof Error ? error.message : String(error)}`,
      'SCRAPE_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}

export async function scrapeReddit(): Promise<RedditScrapedItem[]> {
  try {
    // Fetch all subreddits in parallel
    const results = await Promise.all(
      SUBREDDITS.map((subreddit) => scrapeSubreddit(subreddit))
    );

    // Flatten results from all subreddits
    return results.flat();
  } catch (error) {
    if (error instanceof RedditScraperError) {
      throw error;
    }

    throw new RedditScraperError(
      `Failed to scrape Reddit: ${error instanceof Error ? error.message : String(error)}`,
      'SCRAPE_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}
