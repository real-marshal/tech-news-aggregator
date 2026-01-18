import * as fs from 'fs/promises';
import * as path from 'path';
import type { NewsItem, DailyDigest, Analysis } from '@/types/news';
import type { ProcessedItem, GeneratedSummary } from '@/lib/claude/processor';

export interface DigestGeneratorConfig {
  minItems?: number;
  maxItems?: number;
  maxFileSizeBytes?: number;
  outputDir?: string;
}

const DEFAULT_CONFIG: Required<DigestGeneratorConfig> = {
  minItems: 30,
  maxItems: 50,
  maxFileSizeBytes: 500 * 1024, // 500KB
  outputDir: 'data',
};

export class DigestGeneratorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'DigestGeneratorError';
  }
}

/**
 * Generates a URL-friendly slug from a title.
 * - Converts to lowercase
 * - Removes special characters
 * - Replaces spaces with hyphens
 * - Limits to 50 characters
 */
export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50)
    .replace(/^-|-$/g, '');
}

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
 * Generates the output file path for a given date.
 */
export function getOutputPath(date: Date, outputDir: string): string {
  const dateStr = formatDate(date);
  return path.join(outputDir, `${dateStr}.json`);
}

/**
 * Creates a default analysis object for items missing summaries.
 */
function createDefaultAnalysis(): Analysis {
  return {
    sentiment: '',
  };
}

/**
 * Combines processed items with their generated summaries into NewsItems.
 */
export function combineItemsWithSummaries(
  processedItems: ProcessedItem[],
  summaries: Map<string, GeneratedSummary>
): NewsItem[] {
  const newsItems: NewsItem[] = [];

  for (const item of processedItems) {
    const summary = summaries.get(item.id);

    const newsItem: NewsItem = {
      id: item.id,
      slug: item.slug || generateSlug(item.title),
      title: item.title,
      url: item.url,
      category: item.category,
      sources: item.sources,
      hotness_score: item.hotness_score,
      summary: summary?.summary ?? '',
      analysis: summary?.analysis ?? createDefaultAnalysis(),
    };

    newsItems.push(newsItem);
  }

  return newsItems;
}

/**
 * Limits items to the specified range, prioritizing by hotness score.
 * Items are expected to already be sorted by hotness_score descending.
 */
export function limitItems(
  items: NewsItem[],
  minItems: number,
  maxItems: number
): NewsItem[] {
  // Items should already be sorted by hotness, just slice to max
  return items.slice(0, maxItems);
}

/**
 * Creates a DailyDigest object from news items.
 */
export function createDigest(items: NewsItem[], date: Date): DailyDigest {
  return {
    date: formatDate(date),
    generated_at: new Date().toISOString(),
    item_count: items.length,
    items,
  };
}

/**
 * Serializes a digest to JSON string.
 */
export function serializeDigest(digest: DailyDigest): string {
  return JSON.stringify(digest, null, 2);
}

/**
 * Validates that the serialized digest is within the size limit.
 */
export function validateFileSize(
  jsonStr: string,
  maxBytes: number
): { valid: boolean; sizeBytes: number } {
  const sizeBytes = Buffer.byteLength(jsonStr, 'utf8');
  return {
    valid: sizeBytes <= maxBytes,
    sizeBytes,
  };
}

/**
 * Trims digest items to fit within the file size limit.
 * Removes items from the end (lowest hotness) until size is acceptable.
 */
export function trimToFitSize(
  digest: DailyDigest,
  maxBytes: number,
  minItems: number
): DailyDigest {
  let currentDigest = { ...digest };
  let serialized = serializeDigest(currentDigest);
  let { valid, sizeBytes } = validateFileSize(serialized, maxBytes);

  while (!valid && currentDigest.items.length > minItems) {
    // Remove the last item (lowest hotness score)
    currentDigest = {
      ...currentDigest,
      items: currentDigest.items.slice(0, -1),
      item_count: currentDigest.items.length - 1,
    };

    serialized = serializeDigest(currentDigest);
    const result = validateFileSize(serialized, maxBytes);
    valid = result.valid;
    sizeBytes = result.sizeBytes;
  }

  if (!valid) {
    console.warn(
      `Warning: Digest still exceeds size limit (${sizeBytes} bytes) after trimming to ${minItems} items`
    );
  }

  return currentDigest;
}

/**
 * Ensures the output directory exists.
 */
async function ensureOutputDir(outputDir: string): Promise<void> {
  try {
    await fs.mkdir(outputDir, { recursive: true });
  } catch (error) {
    throw new DigestGeneratorError(
      `Failed to create output directory: ${outputDir}`,
      'DIR_CREATE_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Writes the digest JSON to a file.
 */
async function writeDigestFile(
  filePath: string,
  content: string
): Promise<void> {
  try {
    await fs.writeFile(filePath, content, 'utf8');
  } catch (error) {
    throw new DigestGeneratorError(
      `Failed to write digest file: ${filePath}`,
      'FILE_WRITE_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}

export interface GenerateDigestInput {
  processedItems: ProcessedItem[];
  summaries: Map<string, GeneratedSummary>;
  date?: Date;
}

export interface GenerateDigestResult {
  digest: DailyDigest;
  filePath: string;
  sizeBytes: number;
  itemsIncluded: number;
  itemsExcluded: number;
}

/**
 * Main function to generate and write a daily digest JSON file.
 *
 * This function:
 * 1. Combines processed items with their summaries
 * 2. Limits items to the configured range (30-50 by default)
 * 3. Creates the DailyDigest structure
 * 4. Validates/trims to fit within file size limit
 * 5. Writes to data/YYYY-MM-DD.json
 */
export async function generateDigest(
  input: GenerateDigestInput,
  config: DigestGeneratorConfig = {}
): Promise<GenerateDigestResult> {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const { minItems, maxItems, maxFileSizeBytes, outputDir } = mergedConfig;
  const date = input.date ?? new Date();

  console.log(`Generating daily digest for ${formatDate(date)}...`);

  // Combine processed items with summaries
  const newsItems = combineItemsWithSummaries(
    input.processedItems,
    input.summaries
  );

  console.log(`Combined ${newsItems.length} items with summaries`);

  // Limit items to the configured range
  const limitedItems = limitItems(newsItems, minItems, maxItems);
  const itemsExcluded = newsItems.length - limitedItems.length;

  console.log(
    `Limited to ${limitedItems.length} items (excluded ${itemsExcluded} lower-ranked items)`
  );

  // Create the digest structure
  let digest = createDigest(limitedItems, date);

  // Validate and trim if needed to fit size limit
  const initialSize = Buffer.byteLength(serializeDigest(digest), 'utf8');
  if (initialSize > maxFileSizeBytes) {
    console.log(
      `Initial size (${initialSize} bytes) exceeds limit (${maxFileSizeBytes} bytes), trimming...`
    );
    digest = trimToFitSize(digest, maxFileSizeBytes, minItems);
  }

  // Serialize final digest
  const jsonContent = serializeDigest(digest);
  const { sizeBytes } = validateFileSize(jsonContent, maxFileSizeBytes);

  // Ensure output directory exists and write file
  await ensureOutputDir(outputDir);
  const filePath = getOutputPath(date, outputDir);
  await writeDigestFile(filePath, jsonContent);

  console.log(`Digest written to ${filePath} (${sizeBytes} bytes)`);
  console.log(`Final item count: ${digest.item_count}`);

  return {
    digest,
    filePath,
    sizeBytes,
    itemsIncluded: digest.item_count,
    itemsExcluded: newsItems.length - digest.item_count,
  };
}
