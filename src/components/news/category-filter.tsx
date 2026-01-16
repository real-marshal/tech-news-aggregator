'use client';

import { cn } from '@/lib/utils';
import type { Category } from '@/types';

export type FilterOption = 'all' | Category;

export interface CategoryFilterProps {
  selected: FilterOption;
  onSelect: (filter: FilterOption) => void;
}

const filterOptions: { value: FilterOption; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'ai-ml', label: 'AI/ML' },
  { value: 'development', label: 'Development' },
  { value: 'infrastructure', label: 'Infrastructure' },
  { value: 'career', label: 'Career' },
  { value: 'other', label: 'Other' },
];

export function CategoryFilter({ selected, onSelect }: CategoryFilterProps) {
  return (
    <nav aria-label="Category filter" className="flex flex-wrap gap-1.5 sm:gap-2">
      {filterOptions.map((option) => {
        const isSelected = selected === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onSelect(option.value)}
            className={cn(
              'inline-flex items-center rounded-full px-2.5 sm:px-3 py-1.5 sm:py-1.5 text-xs sm:text-sm font-medium transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              'min-h-[36px] sm:min-h-0',
              isSelected
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
            )}
            aria-pressed={isSelected}
          >
            {option.label}
          </button>
        );
      })}
    </nav>
  );
}
