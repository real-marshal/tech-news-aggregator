import fs from 'fs';
import path from 'path';
import { notFound } from 'next/navigation';
import { DigestView } from '@/components/news';
import type { DailyDigest } from '@/types';

interface DatePageProps {
  params: Promise<{
    date: string;
  }>;
}

// Validate date format (YYYY-MM-DD)
function isValidDateFormat(date: string): boolean {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(date)) {
    return false;
  }
  // Also check if it's a valid date
  const parsed = new Date(date);
  return !isNaN(parsed.getTime());
}

// Get today's date in YYYY-MM-DD format
function getTodayDateString(): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Check if a date is within the last 7 days
function isWithinLast7Days(dateStr: string): boolean {
  const todayStr = getTodayDateString();
  const today = new Date(todayStr + 'T00:00:00Z');
  const date = new Date(dateStr + 'T00:00:00Z');

  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(today.getDate() - 7);

  return date >= sevenDaysAgo && date <= today;
}

// Get all available dates from the data directory (last 7 days only)
function getAvailableDates(): string[] {
  const dataDir = path.join(process.cwd(), 'data');

  try {
    const files = fs.readdirSync(dataDir);
    return files
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace('.json', ''))
      .filter(isValidDateFormat)
      .filter(isWithinLast7Days)
      .sort()
      .reverse(); // Most recent first
  } catch {
    return [];
  }
}

// Load digest data for a specific date
function loadDigestSync(date: string): DailyDigest | null {
  const filePath = path.join(process.cwd(), 'data', `${date}.json`);

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as DailyDigest;
  } catch {
    return null;
  }
}

// Generate static params for all available dates
export function generateStaticParams(): Array<{ date: string }> {
  const dates = getAvailableDates();
  return dates.map((date) => ({ date }));
}

export default async function DatePage({ params }: DatePageProps) {
  const { date } = await params;

  // Validate date format
  if (!isValidDateFormat(date)) {
    notFound();
  }

  // Load digest for the requested date
  const digest = loadDigestSync(date);

  // Handle missing data
  if (!digest) {
    notFound();
  }

  // Get available dates for navigation
  const availableDates = getAvailableDates();

  return <DigestView digest={digest} availableDates={availableDates} />;
}
