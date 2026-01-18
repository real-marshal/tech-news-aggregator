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

function parseClaudeResponse(responseText: string): ClaudeResponse {
  // Try to extract JSON from the response
  let jsonStr = responseText.trim();

  // Handle markdown code blocks
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

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
    throw new ProcessorError(
      `Failed to parse Claude response: ${error instanceof Error ? error.message : String(error)}`,
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
  config: ClaudeProcessorConfig = {}
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
2. An extended analysis paragraph with deeper context and significance
3. A community sentiment summary based on the provided comments

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
      "extended_summary": "Extended analysis paragraph...",
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
  extended_summary: string;
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
  let jsonStr = responseText.trim();

  // Handle markdown code blocks
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

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
      if (!item.extended_summary || typeof item.extended_summary !== 'string') {
        throw new Error('Item missing extended_summary');
      }
      if (!item.sentiment || typeof item.sentiment !== 'string') {
        throw new Error('Item missing sentiment');
      }
    }

    return parsed;
  } catch (error) {
    throw new ProcessorError(
      `Failed to parse summary response: ${error instanceof Error ? error.message : String(error)}`,
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
  config: ClaudeProcessorConfig = {}
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
              extended_summary: item.extended_summary,
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
