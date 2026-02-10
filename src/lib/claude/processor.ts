import { getClaudeClient, ClaudeClientError, ClaudeClient } from '@/lib/claude';
import type { MessageParam } from '@/lib/claude';
import type { Category, Source, Analysis } from '@/types/news';
import type { ScrapedItem } from '@/lib/scrapers/orchestrator';
import {
  calculateBatchStats,
  calculateHotnessScoreWithStats,
  sortByHotness,
  type BatchStats,
} from '@/lib/hotness';

export interface ProcessedItem {
  id: string;
  slug: string;
  title: string;
  url: string;
  category: Category;
  sources: Source[];
  hotness_score: number;
}

export interface DeduplicationResult {
  items: ProcessedItem[];
  originalCount: number;
  deduplicatedCount: number;
  duplicateGroups: number;
}

export interface ClaudeProcessorConfig {
  maxRetries?: number;
}

export class ProcessorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'ProcessorError';
  }
}

const SYSTEM_PROMPT = `You are a tech news processor. Your job is to:
1. Identify duplicate stories across multiple sources (same underlying news appearing on HN, Reddit, Lobsters, or dev.to)
2. Categorize each unique story into exactly one category

Categories:
- ai-ml: Artificial intelligence, machine learning, LLMs, computer vision, neural networks, data science
- development: Programming languages, frameworks, tools, best practices, frontend/backend, software engineering
- infrastructure: DevOps, cloud, databases, security, networking, systems, containers, deployment
- career: Industry news, job market, layoffs, company culture, career advice, hiring, workplace
- other: Trending topics that don't fit above categories

Rules for deduplication:
- Stories are duplicates if they discuss the same underlying news, article, or topic
- URLs pointing to the same domain/path (ignoring query params) are definitely duplicates
- Similar titles about the same announcement/event are likely duplicates
- When merging duplicates, keep the most descriptive title
- Combine source attributions from all duplicate sources

Output format: Return ONLY valid JSON matching this exact structure:
{
  "items": [
    {
      "title": "Most descriptive title for this story",
      "url": "Primary URL to the original article/content",
      "category": "ai-ml|development|infrastructure|career|other",
      "source_ids": ["id1", "id2"]
    }
  ]
}

Important:
- source_ids must contain the original item IDs that were merged
- Each item can only have one category
- Return ONLY the JSON, no explanation or markdown`;

interface ClaudeResponseItem {
  title: string;
  url: string;
  category: Category;
  source_ids: string[];
}

interface ClaudeResponse {
  items: ClaudeResponseItem[];
}

function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50)
    .replace(/^-|-$/g, '');
}

// Hotness score calculation is now imported from @/lib/hotness

function buildSourceMap(items: ScrapedItem[]): Map<string, ScrapedItem> {
  const map = new Map<string, ScrapedItem>();
  for (const item of items) {
    map.set(item.id, item);
  }
  return map;
}

function formatItemsForClaude(items: ScrapedItem[]): string {
  const formattedItems = items.map((item) => ({
    id: item.id,
    title: item.title,
    url: item.url,
    source: item.source.name,
    subreddit: item.source.subreddit,
  }));

  return JSON.stringify(formattedItems, null, 2);
}

function sanitizeJsonString(str: string): string {
  // Remove any BOM or invisible control characters that might interfere with JSON parsing
  // Replace various problematic characters while preserving valid JSON escape sequences
  const result = str
    // Remove BOM
    .replace(/^\uFEFF/, '')
    // Remove null bytes (can appear in UTF-16 encoded strings incorrectly passed as UTF-8)
    .replace(/\u0000/g, '')
    // Remove other control characters (except \n, \r, \t which are valid in JSON strings when escaped)
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Remove Unicode line/paragraph separators that can break JSON
    .replace(/[\u2028\u2029]/g, ' ')
    // Replace smart/curly quotes with straight quotes (escaped for JSON)
    // These are often output by Claude when processing text that contains them
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '\\"')  // Double quotes: " " „ ‟ ″ ‶ -> escaped
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'"); // Single quotes: ' ' ‚ ‛ ′ ‵

  return result;
}

function escapeUnescapedQuotesInStrings(json: string): string {
  // This function attempts to fix unescaped double quotes within JSON string values
  // It uses a state machine to track whether we're inside a JSON string value

  const result: string[] = [];
  let i = 0;
  let inString = false;
  let escapeNext = false;

  while (i < json.length) {
    const char = json[i];

    if (escapeNext) {
      result.push(char);
      escapeNext = false;
      i++;
      continue;
    }

    if (char === '\\') {
      result.push(char);
      escapeNext = true;
      i++;
      continue;
    }

    if (char === '"') {
      if (!inString) {
        // Starting a string
        inString = true;
        result.push(char);
        i++;
        continue;
      }

      // We're inside a string and hit a quote
      // Look ahead to see if this quote ends the string properly
      // A proper ending quote should be followed by: , ] } : or whitespace then one of those
      let j = i + 1;
      while (j < json.length && /\s/.test(json[j])) {
        j++;
      }

      const nextNonWhitespace = json[j];
      if (nextNonWhitespace === ',' || nextNonWhitespace === ']' ||
          nextNonWhitespace === '}' || nextNonWhitespace === ':' ||
          nextNonWhitespace === undefined) {
        // This is a proper closing quote
        inString = false;
        result.push(char);
        i++;
        continue;
      }

      // This quote is embedded in the string - it should be escaped
      // But first check if it might start a new property name (after a value)
      // If the text after looks like a property name pattern, we might have a truncated string
      const textAfter = json.slice(i + 1, i + 50);
      if (/^[a-z_][a-z0-9_]*"\s*:/i.test(textAfter)) {
        // Looks like a property name - this might be a truncated string
        // Close the current string here
        inString = false;
        result.push(char);
        i++;
        continue;
      }

      // This is an embedded quote that needs escaping
      result.push('\\');
      result.push(char);
      i++;
      continue;
    }

    result.push(char);
    i++;
  }

  return result.join('');
}

function extractJsonFromResponse(responseText: string): string {
  let jsonStr = responseText.trim();

  // Handle markdown code blocks (greedy match to get the last complete block)
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  // Sanitize the JSON string to remove problematic characters
  jsonStr = sanitizeJsonString(jsonStr);

  // Fix unescaped quotes within string values
  jsonStr = escapeUnescapedQuotesInStrings(jsonStr);

  // Try to find a complete JSON object if the response has extra content
  // Look for the outermost { ... } structure
  const firstBrace = jsonStr.indexOf('{');
  if (firstBrace > 0) {
    jsonStr = jsonStr.slice(firstBrace);
  }

  // Find the matching closing brace by counting braces
  let braceCount = 0;
  let lastValidIndex = -1;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < jsonStr.length; i++) {
    const char = jsonStr[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') {
        braceCount++;
      } else if (char === '}') {
        braceCount--;
        if (braceCount === 0) {
          lastValidIndex = i;
          break;
        }
      }
    }
  }

  // If we found a complete JSON object, truncate any trailing content
  if (lastValidIndex > 0 && lastValidIndex < jsonStr.length - 1) {
    jsonStr = jsonStr.slice(0, lastValidIndex + 1);
  }

  return jsonStr;
}

function parseClaudeResponse(responseText: string): ClaudeResponse {
  let jsonStr = extractJsonFromResponse(responseText);

  // Escape unescaped control characters inside JSON strings
  // This handles cases where Claude outputs raw control characters in strings
  // that should have been escaped
  jsonStr = jsonStr.replace(
    /"([^"\\]*(?:\\.[^"\\]*)*)"/g,
    (match, content) => {
      // Escape any unescaped control characters within the string content
      const escaped = content
        .replace(/[\x00-\x1f]/g, (char: string) => {
          const code = char.charCodeAt(0);
          if (code === 0x09) return '\\t';
          if (code === 0x0a) return '\\n';
          if (code === 0x0d) return '\\r';
          return `\\u${code.toString(16).padStart(4, '0')}`;
        });
      return `"${escaped}"`;
    }
  );

  try {
    const parsed = JSON.parse(jsonStr) as ClaudeResponse;

    if (!parsed.items || !Array.isArray(parsed.items)) {
      throw new Error('Response missing items array');
    }

    // Validate each item
    for (const item of parsed.items) {
      if (!item.title || typeof item.title !== 'string') {
        throw new Error('Item missing title');
      }
      if (!item.url || typeof item.url !== 'string') {
        throw new Error('Item missing url');
      }
      if (!item.category || typeof item.category !== 'string') {
        throw new Error('Item missing category');
      }
      if (!item.source_ids || !Array.isArray(item.source_ids)) {
        throw new Error('Item missing source_ids array');
      }

      const validCategories: Category[] = [
        'ai-ml',
        'development',
        'infrastructure',
        'career',
        'other',
      ];
      if (!validCategories.includes(item.category as Category)) {
        throw new Error(`Invalid category: ${item.category}`);
      }
    }

    return parsed;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Log context to help debug parsing issues
    console.error('JSON parse error:', errorMsg);
    console.error('Response length:', jsonStr.length);
    console.error('Response start:', jsonStr.slice(0, 200));
    console.error('Response end:', jsonStr.slice(-200));

    throw new ProcessorError(
      `Failed to parse Claude response: ${errorMsg}`,
      'PARSE_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}

function buildProcessedItems(
  claudeResponse: ClaudeResponse,
  sourceMap: Map<string, ScrapedItem>,
  batchStats: BatchStats
): ProcessedItem[] {
  const processedItems: ProcessedItem[] = [];

  for (const responseItem of claudeResponse.items) {
    // Collect all sources from merged items
    const sources: Source[] = [];
    let primaryId = '';

    for (const sourceId of responseItem.source_ids) {
      const originalItem = sourceMap.get(sourceId);
      if (originalItem) {
        sources.push(originalItem.source);
        if (!primaryId) {
          primaryId = sourceId;
        }
      }
    }

    if (sources.length === 0) {
      console.warn(
        `No valid sources found for item: ${responseItem.title}. Source IDs: ${responseItem.source_ids.join(', ')}`
      );
      continue;
    }

    // Calculate hotness score using batch statistics for cross-source normalization
    const processedItem: ProcessedItem = {
      id: primaryId,
      slug: generateSlug(responseItem.title),
      title: responseItem.title,
      url: responseItem.url,
      category: responseItem.category as Category,
      sources,
      hotness_score: calculateHotnessScoreWithStats(sources, batchStats),
    };

    processedItems.push(processedItem);
  }

  return processedItems;
}

export async function deduplicateAndCategorize(
  items: ScrapedItem[],
  _config: ClaudeProcessorConfig = {}
): Promise<DeduplicationResult> {
  if (items.length === 0) {
    return {
      items: [],
      originalCount: 0,
      deduplicatedCount: 0,
      duplicateGroups: 0,
    };
  }

  console.log(`Processing ${items.length} scraped items with Claude...`);

  const sourceMap = buildSourceMap(items);
  const formattedItems = formatItemsForClaude(items);

  // Calculate batch statistics for cross-source normalization
  const allSources = items.map((item) => item.source);
  const batchStats = calculateBatchStats(allSources);

  const messages: MessageParam[] = [
    {
      role: 'user',
      content: `Process these scraped tech news items. Identify duplicates across sources, merge them, and categorize each unique story:\n\n${formattedItems}`,
    },
  ];

  try {
    const client = getClaudeClient();
    const response = await client.sendMessage(messages, {
      systemPrompt: SYSTEM_PROMPT,
      maxTokens: 8192,
    });

    const responseText = await client.extractText(response);

    if (!responseText) {
      throw new ProcessorError(
        'Empty response from Claude',
        'EMPTY_RESPONSE'
      );
    }

    const claudeResponse = parseClaudeResponse(responseText);
    const processedItems = buildProcessedItems(
      claudeResponse,
      sourceMap,
      batchStats
    );

    // Sort by hotness score descending using the sortByHotness utility
    const sortedItems = sortByHotness(processedItems);

    // Count duplicate groups (items that had multiple sources merged)
    const duplicateGroups = claudeResponse.items.filter(
      (item) => item.source_ids.length > 1
    ).length;

    console.log(
      `Deduplication complete: ${items.length} -> ${sortedItems.length} items (${duplicateGroups} duplicate groups merged)`
    );

    return {
      items: sortedItems,
      originalCount: items.length,
      deduplicatedCount: sortedItems.length,
      duplicateGroups,
    };
  } catch (error) {
    if (error instanceof ProcessorError) {
      throw error;
    }

    if (error instanceof ClaudeClientError) {
      throw new ProcessorError(
        `Claude API error: ${error.message}`,
        `CLAUDE_${error.code}`,
        error
      );
    }

    throw new ProcessorError(
      `Unexpected error during processing: ${error instanceof Error ? error.message : String(error)}`,
      'UNKNOWN_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}

export { type ClaudeResponse, type ClaudeResponseItem };

// Summary Generation

export interface SummaryInput {
  id: string;
  title: string;
  url: string;
  sources: Source[];
  comments?: string[];
}

export interface GeneratedSummary {
  id: string;
  summary: string;
  analysis: Analysis;
}

export interface SummaryGenerationResult {
  summaries: Map<string, GeneratedSummary>;
  processedCount: number;
  failedCount: number;
}

const SUMMARY_SYSTEM_PROMPT = `You are a tech news analyst writing for experienced software engineers and tech professionals.

For each news item, generate:
1. A brief summary (2-3 sentences) suitable for quick scanning
2. A community sentiment summary based on the provided comments

Guidelines:
- Target audience: Tech professionals with deep technical knowledge
- Skip basic explanations - assume the reader understands technical concepts
- Be direct and information-dense
- Focus on what's new, why it matters, and technical implications
- For community sentiment, capture the main themes and concerns from the comments
- If no comments are provided, base sentiment on likely community reaction given the topic

Output format: Return ONLY valid JSON matching this exact structure:
{
  "items": [
    {
      "id": "item_id",
      "summary": "2-3 sentence summary...",
      "sentiment": "Community sentiment summary..."
    }
  ]
}

Important:
- Return ONLY the JSON, no explanation or markdown
- Use the exact item IDs provided in the input
- Each field should be a complete, standalone piece of text`;

interface SummaryResponseItem {
  id: string;
  summary: string;
  sentiment: string;
}

interface SummaryResponse {
  items: SummaryResponseItem[];
}

function formatItemsForSummary(items: SummaryInput[]): string {
  const formattedItems = items.map((item) => {
    const sourceInfo = item.sources
      .map((s) => {
        const engagement =
          s.points !== undefined ? `${s.points} points` : `${s.upvotes} upvotes`;
        return `${s.name}${s.subreddit ? ` (${s.subreddit})` : ''}: ${engagement}, ${s.comments} comments`;
      })
      .join('; ');

    return {
      id: item.id,
      title: item.title,
      url: item.url,
      sources: sourceInfo,
      top_comments: item.comments?.slice(0, 20) ?? [],
    };
  });

  return JSON.stringify(formattedItems, null, 2);
}

function parseSummaryResponse(responseText: string): SummaryResponse {
  const jsonStr = extractJsonFromResponse(responseText);

  try {
    const parsed = JSON.parse(jsonStr) as SummaryResponse;

    if (!parsed.items || !Array.isArray(parsed.items)) {
      throw new Error('Response missing items array');
    }

    // Validate each item
    for (const item of parsed.items) {
      if (!item.id || typeof item.id !== 'string') {
        throw new Error('Item missing id');
      }
      if (!item.summary || typeof item.summary !== 'string') {
        throw new Error('Item missing summary');
      }
      if (!item.sentiment || typeof item.sentiment !== 'string') {
        throw new Error('Item missing sentiment');
      }
    }

    return parsed;
  } catch (error) {
    // Log more details about the parsing failure for debugging
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('Summary JSON parse error:', errorMsg);
    console.error('Response length:', jsonStr.length);
    console.error('Response start:', jsonStr.slice(0, 200));
    console.error('Response end:', jsonStr.slice(-200));

    throw new ProcessorError(
      `Failed to parse summary response: ${errorMsg}`,
      'SUMMARY_PARSE_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}

const BATCH_SIZE = 10;

function formatTimeRemaining(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

async function processSummaryBatch(
  batchItems: SummaryInput[],
  client: ClaudeClient
): Promise<SummaryResponse> {
  const formattedItems = formatItemsForSummary(batchItems);

  const messages: MessageParam[] = [
    {
      role: 'user',
      content: `Generate summaries and analysis for these tech news items:\n\n${formattedItems}`,
    },
  ];

  const response = await client.sendMessage(messages, {
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    maxTokens: 8192,
  });

  const responseText = await client.extractText(response);

  if (!responseText) {
    throw new ProcessorError(
      'Empty response from Claude for summaries',
      'EMPTY_SUMMARY_RESPONSE'
    );
  }

  return parseSummaryResponse(responseText);
}

export async function generateSummaries(
  items: SummaryInput[],
  _config: ClaudeProcessorConfig = {}
): Promise<SummaryGenerationResult> {
  if (items.length === 0) {
    return {
      summaries: new Map(),
      processedCount: 0,
      failedCount: 0,
    };
  }

  const totalItems = items.length;
  const totalBatches = Math.ceil(totalItems / BATCH_SIZE);

  console.log(
    `Generating summaries for ${totalItems} items in ${totalBatches} batches (batch size: ${BATCH_SIZE})...`
  );

  const summaries = new Map<string, GeneratedSummary>();
  let processedCount = 0;
  let failedCount = 0;
  const batchTimes: number[] = [];

  try {
    const client = getClaudeClient();

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const startIdx = batchIndex * BATCH_SIZE;
      const endIdx = Math.min(startIdx + BATCH_SIZE, totalItems);
      const batchItems = items.slice(startIdx, endIdx);
      const batchNumber = batchIndex + 1;

      const batchStartTime = Date.now();

      try {
        const summaryResponse = await processSummaryBatch(batchItems, client);

        for (const item of summaryResponse.items) {
          summaries.set(item.id, {
            id: item.id,
            summary: item.summary,
            analysis: {
              sentiment: item.sentiment,
            },
          });
          processedCount++;
        }

        const batchFailedCount = batchItems.length - summaryResponse.items.length;
        failedCount += batchFailedCount;
      } catch (error) {
        console.error(
          `Batch ${batchNumber}/${totalBatches} failed: ${error instanceof Error ? error.message : String(error)}`
        );
        failedCount += batchItems.length;
      }

      const batchDuration = (Date.now() - batchStartTime) / 1000;
      batchTimes.push(batchDuration);

      // Calculate estimated time remaining
      let etaMessage = '';
      if (batchIndex < totalBatches - 1) {
        const avgBatchTime =
          batchTimes.reduce((a, b) => a + b, 0) / batchTimes.length;
        const remainingBatches = totalBatches - batchNumber;
        const estimatedRemaining = avgBatchTime * remainingBatches;
        etaMessage = ` (ETA: ${formatTimeRemaining(estimatedRemaining)})`;
      }

      console.log(
        `[${batchNumber}/${totalBatches}] Generated summaries for items ${startIdx + 1}-${endIdx}...${etaMessage}`
      );
    }

    console.log(
      `Summary generation complete: ${processedCount}/${totalItems} items processed`
    );

    return {
      summaries,
      processedCount,
      failedCount,
    };
  } catch (error) {
    if (error instanceof ProcessorError) {
      throw error;
    }

    if (error instanceof ClaudeClientError) {
      throw new ProcessorError(
        `Claude API error during summary generation: ${error.message}`,
        `SUMMARY_CLAUDE_${error.code}`,
        error
      );
    }

    throw new ProcessorError(
      `Unexpected error during summary generation: ${error instanceof Error ? error.message : String(error)}`,
      'SUMMARY_UNKNOWN_ERROR',
      error instanceof Error ? error : undefined
    );
  }
}
