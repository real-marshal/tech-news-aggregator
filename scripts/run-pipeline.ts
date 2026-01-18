#!/usr/bin/env bun
/**
 * Tech Digest Pipeline Runner
 *
 * Orchestrates the full daily digest generation pipeline:
 * 1. Scrape all sources (HN, Reddit, Lobsters, dev.to)
 * 2. Process with Claude (deduplicate, categorize)
 * 3. Generate summaries with Claude
 * 4. Generate and write daily digest JSON
 *
 * Usage:
 *   bun run scripts/run-pipeline.ts [--date YYYY-MM-DD]
 *
 * Exit codes:
 *   0 - Success
 *   1 - Partial failure (some sources failed, but digest was generated)
 *   2 - Critical failure (no data collected or processing failed)
 */

import {
  scrapeAllSources,
  OrchestratorError,
  type OrchestratorResult,
} from '@/lib/scrapers';
import {
  deduplicateAndCategorize,
  generateSummaries,
  ProcessorError,
  type ProcessedItem,
  type SummaryInput,
  type GeneratedSummary,
} from '@/lib/claude/processor';
import { generateDigest, DigestGeneratorError, formatDate } from '@/lib/digest';

// Exit codes
const EXIT_SUCCESS = 0;
const EXIT_PARTIAL_FAILURE = 1;
const EXIT_CRITICAL_FAILURE = 2;

interface PipelineResult {
  success: boolean;
  partialFailure: boolean;
  date: string;
  scrapeResult?: OrchestratorResult;
  processedCount?: number;
  summaryCount?: number;
  digestPath?: string;
  digestSize?: number;
  errors: string[];
}

function parseArgs(): { date: Date } {
  const args = process.argv.slice(2);
  let date = new Date();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) {
      const dateStr = args[i + 1];
      const parsedDate = new Date(dateStr);
      if (isNaN(parsedDate.getTime())) {
        console.error(`Invalid date format: ${dateStr}. Use YYYY-MM-DD.`);
        process.exit(EXIT_CRITICAL_FAILURE);
      }
      date = parsedDate;
      i++;
    }
  }

  return { date };
}

function logSection(title: string): void {
  const line = '='.repeat(50);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(`${line}\n`);
}

function logStep(step: number, total: number, message: string): void {
  console.log(`[${step}/${total}] ${message}`);
}

function logError(context: string, error: unknown): string {
  const errorMessage =
    error instanceof Error ? error.message : String(error);
  const errorCode =
    error instanceof ProcessorError ||
    error instanceof OrchestratorError ||
    error instanceof DigestGeneratorError
      ? (error as { code: string }).code
      : 'UNKNOWN';

  console.error(`ERROR [${context}] (${errorCode}): ${errorMessage}`);
  return `${context}: ${errorMessage}`;
}

async function runPipeline(date: Date): Promise<PipelineResult> {
  const result: PipelineResult = {
    success: false,
    partialFailure: false,
    date: formatDate(date),
    errors: [],
  };

  const startTime = Date.now();

  logSection(`Tech Digest Pipeline - ${result.date}`);
  console.log(`Started at: ${new Date().toISOString()}`);

  // Step 1: Scrape all sources
  logStep(1, 4, 'Scraping all sources...');

  let scrapeResult: OrchestratorResult;
  try {
    scrapeResult = await scrapeAllSources();
    result.scrapeResult = scrapeResult;

    if (scrapeResult.failedSources.length > 0) {
      result.partialFailure = true;
      const failedMsg = `Some sources failed: ${scrapeResult.failedSources.join(', ')}`;
      console.warn(`WARNING: ${failedMsg}`);
      result.errors.push(failedMsg);
    }

    console.log(
      `Scraped ${scrapeResult.totalItems} items from ${scrapeResult.successfulSources.length} sources`
    );
  } catch (error) {
    result.errors.push(logError('Scrape', error));
    return result;
  }

  if (scrapeResult.totalItems === 0) {
    result.errors.push('No items scraped from any source');
    return result;
  }

  // Step 2: Process with Claude (deduplicate and categorize)
  logStep(2, 4, 'Processing with Claude (deduplication & categorization)...');

  let processedItems: ProcessedItem[];
  try {
    const dedupeResult = await deduplicateAndCategorize(scrapeResult.items);
    processedItems = dedupeResult.items;
    result.processedCount = processedItems.length;

    console.log(
      `Processed: ${dedupeResult.originalCount} -> ${dedupeResult.deduplicatedCount} items`
    );
    console.log(`Duplicate groups merged: ${dedupeResult.duplicateGroups}`);
  } catch (error) {
    result.errors.push(logError('Claude Processing', error));
    return result;
  }

  if (processedItems.length === 0) {
    result.errors.push('No items after processing');
    return result;
  }

  // Step 3: Generate summaries with Claude
  logStep(3, 4, 'Generating summaries with Claude...');

  let summaries: Map<string, GeneratedSummary>;
  try {
    const summaryInputs: SummaryInput[] = processedItems.map((item) => ({
      id: item.id,
      title: item.title,
      url: item.url,
      sources: item.sources,
    }));

    const summaryResult = await generateSummaries(summaryInputs);
    summaries = summaryResult.summaries;
    result.summaryCount = summaryResult.processedCount;

    console.log(
      `Summaries generated: ${summaryResult.processedCount}/${processedItems.length}`
    );

    if (summaryResult.failedCount > 0) {
      result.partialFailure = true;
      const failedMsg = `${summaryResult.failedCount} summaries failed to generate`;
      console.warn(`WARNING: ${failedMsg}`);
      result.errors.push(failedMsg);
    }
  } catch (error) {
    result.errors.push(logError('Summary Generation', error));
    return result;
  }

  // Step 4: Generate and write digest
  logStep(4, 4, 'Generating daily digest JSON...');

  try {
    const digestResult = await generateDigest({
      processedItems,
      summaries,
      date,
    });

    result.digestPath = digestResult.filePath;
    result.digestSize = digestResult.sizeBytes;

    console.log(`Digest written to: ${digestResult.filePath}`);
    console.log(`File size: ${digestResult.sizeBytes} bytes`);
    console.log(`Items included: ${digestResult.itemsIncluded}`);
    if (digestResult.itemsExcluded > 0) {
      console.log(`Items excluded (over limit): ${digestResult.itemsExcluded}`);
    }
  } catch (error) {
    result.errors.push(logError('Digest Generation', error));
    return result;
  }

  // Success!
  result.success = true;

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  logSection('Pipeline Complete');
  console.log(`Status: ${result.partialFailure ? 'PARTIAL SUCCESS' : 'SUCCESS'}`);
  console.log(`Duration: ${duration}s`);
  console.log(`Output: ${result.digestPath}`);

  if (result.errors.length > 0) {
    console.log(`\nWarnings/Errors (${result.errors.length}):`);
    for (const err of result.errors) {
      console.log(`  - ${err}`);
    }
  }

  return result;
}

async function main(): Promise<void> {
  const { date } = parseArgs();

  try {
    const result = await runPipeline(date);

    if (!result.success) {
      console.error('\nPipeline failed. See errors above.');
      process.exit(EXIT_CRITICAL_FAILURE);
    }

    if (result.partialFailure) {
      console.warn('\nPipeline completed with warnings.');
      process.exit(EXIT_PARTIAL_FAILURE);
    }

    process.exit(EXIT_SUCCESS);
  } catch (error) {
    console.error('\nUnexpected pipeline error:', error);
    process.exit(EXIT_CRITICAL_FAILURE);
  }
}

main();
