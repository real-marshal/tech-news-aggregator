'use client';

import { ChevronDown, ChevronUp, ArrowUp, MessageSquare, ExternalLink, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { NewsItem, Category, SourceName, Source } from '@/types';

export interface NewsCardProps {
  item: NewsItem;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}

const categoryLabels: Record<Category, string> = {
  'ai-ml': 'AI/ML',
  'development': 'Development',
  'infrastructure': 'Infrastructure',
  'career': 'Career',
  'other': 'Other',
};

const categoryColors: Record<Category, string> = {
  'ai-ml': 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  'development': 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  'infrastructure': 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  'career': 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  'other': 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200',
};

const sourceLabels: Record<SourceName, string> = {
  'hackernews': 'HN',
  'reddit': 'Reddit',
  'lobsters': 'Lobste.rs',
  'devto': 'dev.to',
};

function formatNumber(num: number): string {
  if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}k`;
  }
  return num.toString();
}

function formatFullTimestamp(date: Date): string {
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) {
    return 'just now';
  } else if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
  } else if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  } else if (diffDays < 7) {
    return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  } else {
    return formatFullTimestamp(date);
  }
}

function getOldestSourceTimestamp(sources: Source[]): Date | null {
  if (sources.length === 0) return null;

  let oldest: Date | null = null;
  for (const source of sources) {
    const date = new Date(source.createdAt);
    if (!oldest || date < oldest) {
      oldest = date;
    }
  }
  return oldest;
}

function getTotalEngagement(item: NewsItem): { upvotes: number; comments: number } {
  let upvotes = 0;
  let comments = 0;

  for (const source of item.sources) {
    upvotes += source.points ?? source.upvotes ?? 0;
    comments += source.comments;
  }

  return { upvotes, comments };
}

function formatSources(item: NewsItem): string {
  const names = item.sources.map((s) => {
    if (s.name === 'reddit' && s.subreddit) {
      return s.subreddit;
    }
    return sourceLabels[s.name];
  });

  return names.join(', ');
}

function getDiscussionSource(sources: Source[]): Source | null {
  // Prioritize HN, then Reddit, then Lobsters, then dev.to
  const priority: SourceName[] = ['hackernews', 'reddit', 'lobsters', 'devto'];
  for (const sourceName of priority) {
    const found = sources.find((s) => s.name === sourceName);
    if (found) return found;
  }
  return sources[0] ?? null;
}

export function NewsCard({ item, isExpanded = false, onToggleExpand }: NewsCardProps) {
  const { upvotes, comments } = getTotalEngagement(item);
  const sourcesText = formatSources(item);
  const discussionSource = getDiscussionSource(item.sources);
  const createdAt = getOldestSourceTimestamp(item.sources);

  return (
    <article
      id={item.slug}
      className={cn(
        'rounded-lg border border-border bg-card p-3 sm:p-4 shadow-sm transition-shadow hover:shadow-md',
        'flex flex-col gap-2 sm:gap-3'
      )}
    >
      {/* Header: Category chip and Sources */}
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium shrink-0',
            categoryColors[item.category]
          )}
        >
          {categoryLabels[item.category]}
        </span>
        <span className="text-xs text-muted-foreground truncate">{sourcesText}</span>
      </div>

      {/* Headline */}
      <h2 className="text-base sm:text-lg font-semibold leading-tight text-card-foreground">
        {item.title}
      </h2>

      {/* Summary */}
      <p className="text-sm text-muted-foreground leading-relaxed">{item.summary}</p>

      {/* Expanded Content */}
      {isExpanded && (
        <div
          id={`${item.slug}-content`}
          className="flex flex-col gap-3 sm:gap-4 border-t border-border pt-3 sm:pt-4"
        >
          {/* Claude's Analysis Section */}
          <div className="flex flex-col gap-1.5 sm:gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Claude&apos;s Analysis
            </h3>
            <p className="text-sm text-card-foreground leading-relaxed">
              {item.analysis.extended_summary}
            </p>
          </div>

          {/* Community Sentiment Section */}
          <div className="flex flex-col gap-1.5 sm:gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Community Sentiment
            </h3>
            <p className="text-sm text-card-foreground leading-relaxed">
              {item.analysis.sentiment}
            </p>
          </div>

          {/* Action Links */}
          <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2 sm:gap-3 pt-2">
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 sm:py-1.5',
                'text-sm font-medium min-h-[44px] sm:min-h-0',
                'bg-primary text-primary-foreground',
                'hover:bg-primary/90 transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
              )}
            >
              Read Article
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            {discussionSource && (
              <a
                href={discussionSource.url}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  'inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 sm:py-1.5',
                  'text-sm font-medium min-h-[44px] sm:min-h-0',
                  'bg-secondary text-secondary-foreground',
                  'hover:bg-secondary/80 transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
                )}
              >
                View Discussion
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        </div>
      )}

      {/* Footer: Engagement metrics, timestamp, and Expand button */}
      <div className="flex items-center justify-between pt-1 gap-2">
        <div className="flex items-center gap-3 sm:gap-4 text-xs sm:text-sm text-muted-foreground">
          <span className="flex items-center gap-1">
            <ArrowUp className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            {formatNumber(upvotes)}
          </span>
          <span className="flex items-center gap-1">
            <MessageSquare className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            {formatNumber(comments)}
          </span>
          {createdAt && (
            <span
              className="flex items-center gap-1 cursor-default"
              title={formatFullTimestamp(createdAt)}
            >
              <Clock className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              {formatRelativeTime(createdAt)}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onToggleExpand}
          className={cn(
            'flex items-center gap-1 text-xs sm:text-sm font-medium text-muted-foreground',
            'hover:text-foreground transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded',
            'min-h-[44px] sm:min-h-0 px-2 -mr-2'
          )}
          aria-expanded={isExpanded}
          aria-controls={`${item.slug}-content`}
        >
          {isExpanded ? 'Collapse' : 'Expand'}
          {isExpanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </button>
      </div>
    </article>
  );
}
