export type Category = 'ai-ml' | 'development' | 'infrastructure' | 'career' | 'other';

export type SourceName = 'hackernews' | 'reddit' | 'lobsters' | 'devto';

export interface Source {
  name: SourceName;
  url: string;
  points?: number;
  upvotes?: number;
  comments: number;
  subreddit?: string;
  createdAt: string; // ISO 8601 timestamp of when the post was created
}

export interface Analysis {
  extended_summary: string;
  sentiment: string;
}

export interface NewsItem {
  id: string;
  slug: string;
  title: string;
  url: string;
  category: Category;
  sources: Source[];
  hotness_score: number;
  summary: string;
  analysis: Analysis;
}

export interface DailyDigest {
  date: string;
  generated_at: string;
  item_count: number;
  items: NewsItem[];
}
