'use client';

import { useState, useMemo, useEffect } from 'react';
import { NewsCard } from './news-card';
import { CategoryFilter, type FilterOption } from './category-filter';
import { DayNavigation } from './day-navigation';
import type { DailyDigest, NewsItem } from '@/types';

export interface DigestViewProps {
  digest: DailyDigest;
  availableDates: string[];
}

function sortByHotness(items: NewsItem[]): NewsItem[] {
  return [...items].sort((a, b) => b.hotness_score - a.hotness_score);
}

function filterByCategory(items: NewsItem[], filter: FilterOption): NewsItem[] {
  if (filter === 'all') {
    return items;
  }
  return items.filter((item) => item.category === filter);
}

function EmptyState({ category }: { category: FilterOption }) {
  const categoryLabel = category === 'all' ? 'any category' : category.replace('-', '/').toUpperCase();

  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <p className="text-lg text-muted-foreground">
        No items today
      </p>
      <p className="text-sm text-muted-foreground/70 mt-1">
        {category === 'all'
          ? 'Check back later for new content.'
          : `No items in ${categoryLabel} for today.`}
      </p>
    </div>
  );
}

export function DigestView({ digest, availableDates }: DigestViewProps) {
  const [selectedCategory, setSelectedCategory] = useState<FilterOption>('all');
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  // Handle anchor links - expand and scroll to item on page load
  useEffect(() => {
    const hash = window.location.hash.slice(1); // Remove the # prefix
    if (hash) {
      // Find the item with matching slug
      const item = digest.items.find((i) => i.slug === hash);
      if (item) {
        // Expand the item
        setExpandedItems(new Set([item.id]));
        // Scroll to the element after a brief delay to allow render
        setTimeout(() => {
          const element = document.getElementById(hash);
          if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }, 100);
      }
    }
  }, [digest.items]);

  // Filter and sort items
  const displayedItems = useMemo(() => {
    const filtered = filterByCategory(digest.items, selectedCategory);
    return sortByHotness(filtered);
  }, [digest.items, selectedCategory]);

  const handleToggleExpand = (itemId: string) => {
    setExpandedItems((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(itemId)) {
        newSet.delete(itemId);
      } else {
        newSet.add(itemId);
      }
      return newSet;
    });
  };

  return (
    <main className="container py-4 sm:py-6 md:py-8">
      {/* Header */}
      <header className="mb-4 sm:mb-6 md:mb-8">
        <h1 className="text-xl sm:text-2xl font-bold">Tech Digest</h1>
        <p className="text-sm sm:text-base text-muted-foreground">Daily curated tech news</p>
      </header>

      {/* Navigation Section */}
      <div className="flex flex-col gap-3 sm:gap-4 mb-4 sm:mb-6 md:mb-8">
        {/* Day Navigation */}
        <section aria-label="Date selection">
          <DayNavigation currentDate={digest.date} availableDates={availableDates} />
        </section>

        {/* Category Filters */}
        <section aria-label="Category filters">
          <CategoryFilter selected={selectedCategory} onSelect={setSelectedCategory} />
        </section>
      </div>

      {/* News List */}
      <section aria-label="News items">
        {displayedItems.length === 0 ? (
          <EmptyState category={selectedCategory} />
        ) : (
          <div className="flex flex-col gap-3 sm:gap-4">
            {displayedItems.map((item) => (
              <NewsCard
                key={item.id}
                item={item}
                isExpanded={expandedItems.has(item.id)}
                onToggleExpand={() => handleToggleExpand(item.id)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Footer with item count */}
      {displayedItems.length > 0 && (
        <footer className="mt-6 sm:mt-8 pt-3 sm:pt-4 border-t border-border text-xs sm:text-sm text-muted-foreground text-center">
          Showing {displayedItems.length} of {digest.item_count} items
          {selectedCategory !== 'all' && ` in ${selectedCategory.replace('-', '/')}`}
        </footer>
      )}
    </main>
  );
}
