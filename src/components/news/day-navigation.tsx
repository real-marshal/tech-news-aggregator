'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils';

export interface DayNavigationProps {
  currentDate: string; // YYYY-MM-DD format
  availableDates?: string[]; // dates that have data available
}

interface DayOption {
  date: string;
  label: string;
  href: string;
}

function formatDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getDayLabel(daysAgo: number): string {
  if (daysAgo === 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';
  return `${daysAgo} days ago`;
}

function generateDayOptions(): DayOption[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const options: DayOption[] = [];

  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    const dateString = formatDateString(date);

    options.push({
      date: dateString,
      label: getDayLabel(i),
      href: i === 0 ? '/' : `/${dateString}`,
    });
  }

  return options;
}

export function DayNavigation({ currentDate, availableDates }: DayNavigationProps) {
  const dayOptions = generateDayOptions();
  const availableSet = availableDates ? new Set(availableDates) : null;

  return (
    <nav aria-label="Day navigation" className="flex flex-wrap gap-1.5 sm:gap-2">
      {dayOptions.map((option) => {
        const isSelected = option.date === currentDate;
        const isAvailable = availableSet === null || availableSet.has(option.date);

        if (!isAvailable) {
          return (
            <span
              key={option.date}
              className={cn(
                'inline-flex items-center rounded-full px-2.5 sm:px-3 py-1.5 text-xs sm:text-sm font-medium',
                'bg-muted text-muted-foreground/50 cursor-not-allowed',
                'min-h-[36px] sm:min-h-0'
              )}
              title="No data available for this day"
            >
              {option.label}
            </span>
          );
        }

        return (
          <Link
            key={option.date}
            href={option.href}
            className={cn(
              'inline-flex items-center rounded-full px-2.5 sm:px-3 py-1.5 text-xs sm:text-sm font-medium transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              'min-h-[36px] sm:min-h-0',
              isSelected
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
            )}
            aria-current={isSelected ? 'page' : undefined}
          >
            {option.label}
          </Link>
        );
      })}
    </nav>
  );
}
