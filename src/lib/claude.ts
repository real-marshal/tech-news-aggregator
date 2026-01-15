import Anthropic from '@anthropic-ai/sdk';
import type {
  Message,
  MessageParam,
  Tool,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages';

const MODEL = 'claude-3-opus-20240229';
const MAX_TOKENS = 4096;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

export interface ClaudeClientConfig {
  apiKey?: string;
  maxRetries?: number;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchToolInput {
  query: string;
}

export type WebSearchHandler = (query: string) => Promise<WebSearchResult[]>;

export class ClaudeClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'ClaudeClientError';
  }
}

export const webSearchTool: Tool = {
  name: 'web_search',
  description:
    'Search the web for current information. Use this tool selectively for top stories or when additional context is needed to understand a news item.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query to look up',
      },
    },
    required: ['query'],
  },
};

function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === 'text';
}

function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use';
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ClaudeClient {
  private client: Anthropic;
  private maxRetries: number;
  private webSearchHandler: WebSearchHandler | null = null;

  constructor(config: ClaudeClientConfig = {}) {
    const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new ClaudeClientError(
        'ANTHROPIC_API_KEY is required',
        'MISSING_API_KEY'
      );
    }

    this.client = new Anthropic({
      apiKey,
      maxRetries: 0, // We handle retries ourselves for better control
    });

    this.maxRetries = config.maxRetries ?? MAX_RETRIES;
  }

  setWebSearchHandler(handler: WebSearchHandler): void {
    this.webSearchHandler = handler;
  }

  async sendMessage(
    messages: MessageParam[],
    options: {
      systemPrompt?: string;
      enableWebSearch?: boolean;
      maxTokens?: number;
    } = {}
  ): Promise<Message> {
    const { systemPrompt, enableWebSearch = false, maxTokens = MAX_TOKENS } = options;

    const tools: Tool[] = enableWebSearch ? [webSearchTool] : [];

    let attempt = 0;
    let lastError: Error | undefined;

    while (attempt < this.maxRetries) {
      try {
        const response = await this.client.messages.create({
          model: MODEL,
          max_tokens: maxTokens,
          messages,
          ...(systemPrompt && { system: systemPrompt }),
          ...(tools.length > 0 && { tools }),
        });

        // Handle tool use if web search was called
        if (
          enableWebSearch &&
          this.webSearchHandler &&
          response.stop_reason === 'tool_use'
        ) {
          return this.handleToolUse(response, messages, options);
        }

        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        attempt++;

        if (this.isRetryableError(error) && attempt < this.maxRetries) {
          const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          await sleep(delay);
          continue;
        }

        throw this.wrapError(error);
      }
    }

    throw new ClaudeClientError(
      `Failed after ${this.maxRetries} retries`,
      'MAX_RETRIES_EXCEEDED',
      lastError
    );
  }

  private async handleToolUse(
    response: Message,
    originalMessages: MessageParam[],
    options: {
      systemPrompt?: string;
      enableWebSearch?: boolean;
      maxTokens?: number;
    }
  ): Promise<Message> {
    const toolUseBlocks = response.content.filter(isToolUseBlock);
    const toolResults: MessageParam['content'] = [];

    for (const toolUse of toolUseBlocks) {
      if (toolUse.name === 'web_search' && this.webSearchHandler) {
        const input = toolUse.input as WebSearchToolInput;
        try {
          const results = await this.webSearchHandler(input.query);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(results),
          });
        } catch (error) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Error performing web search: ${error instanceof Error ? error.message : String(error)}`,
            is_error: true,
          });
        }
      }
    }

    // Continue the conversation with tool results
    const updatedMessages: MessageParam[] = [
      ...originalMessages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResults },
    ];

    return this.sendMessage(updatedMessages, {
      ...options,
      enableWebSearch: false, // Prevent infinite loops
    });
  }

  async extractText(response: Message): Promise<string> {
    const textBlocks = response.content.filter(isTextBlock);
    return textBlocks.map((block) => block.text).join('\n');
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof Anthropic.APIError) {
      // Retry on rate limits and server errors
      return (
        error instanceof Anthropic.RateLimitError ||
        error instanceof Anthropic.InternalServerError ||
        error.status === 529 // Overloaded
      );
    }

    if (error instanceof Anthropic.APIConnectionError) {
      return true;
    }

    return false;
  }

  private wrapError(error: unknown): ClaudeClientError {
    if (error instanceof Anthropic.AuthenticationError) {
      return new ClaudeClientError(
        'Invalid API key',
        'AUTHENTICATION_ERROR',
        error
      );
    }

    if (error instanceof Anthropic.RateLimitError) {
      return new ClaudeClientError(
        'Rate limit exceeded',
        'RATE_LIMIT_ERROR',
        error
      );
    }

    if (error instanceof Anthropic.BadRequestError) {
      return new ClaudeClientError(
        `Invalid request: ${error.message}`,
        'BAD_REQUEST_ERROR',
        error
      );
    }

    if (error instanceof Anthropic.APIConnectionError) {
      return new ClaudeClientError(
        'Failed to connect to Claude API',
        'CONNECTION_ERROR',
        error
      );
    }

    if (error instanceof Anthropic.InternalServerError) {
      return new ClaudeClientError(
        'Claude API server error',
        'SERVER_ERROR',
        error
      );
    }

    if (error instanceof Anthropic.APIError) {
      return new ClaudeClientError(
        `API error: ${error.message}`,
        'API_ERROR',
        error
      );
    }

    if (error instanceof Error) {
      return new ClaudeClientError(
        `Unexpected error: ${error.message}`,
        'UNKNOWN_ERROR',
        error
      );
    }

    return new ClaudeClientError(
      'An unknown error occurred',
      'UNKNOWN_ERROR'
    );
  }
}

let clientInstance: ClaudeClient | null = null;

export function getClaudeClient(config?: ClaudeClientConfig): ClaudeClient {
  if (!clientInstance) {
    clientInstance = new ClaudeClient(config);
  }
  return clientInstance;
}

export function resetClaudeClient(): void {
  clientInstance = null;
}

export type { Message, MessageParam, Tool, ContentBlock, TextBlock, ToolUseBlock };
