import type { DailyDigest } from '@/types';

/**
 * Formats a Date object to YYYY-MM-DD string.
 */
export function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Gets today's date in YYYY-MM-DD format.
 */
export function getTodayDate(): string {
  return formatDate(new Date());
}

/**
 * Loads a daily digest from the data directory.
 * Returns null if the file doesn't exist.
 */
export async function loadDigest(date: string): Promise<DailyDigest | null> {
  try {
    // Dynamic import for JSON files in data directory
    // In static export, these will be bundled at build time
    const data = await import(`../../data/${date}.json`);
    return data.default as DailyDigest;
  } catch {
    return null;
  }
}

/**
 * Gets a list of available dates (last 7 days that have data).
 * This scans the data directory for existing JSON files.
 */
export async function getAvailableDates(): Promise<string[]> {
  const dates: string[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Check last 7 days for available data
  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    const dateStr = formatDate(date);

    try {
      await import(`../../data/${dateStr}.json`);
      dates.push(dateStr);
    } catch {
      // File doesn't exist, skip
    }
  }

  return dates;
}
