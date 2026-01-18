import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';

const MODEL = 'claude-sonnet-4-5';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

export interface ClaudeClientConfig {
  maxRetries?: number;
}

export interface MessageParam {
  role: 'user' | 'assistant';
  content: string;
}

export interface Message {
  content: Array<{ type: 'text'; text: string }>;
}

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

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAssistantMessage(message: SDKMessage): message is SDKAssistantMessage {
  return message.type === 'assistant';
}

function isResultMessage(message: SDKMessage): message is SDKResultMessage {
  return message.type === 'result';
}

export class ClaudeClient {
  private maxRetries: number;

  constructor(config: ClaudeClientConfig = {}) {
    this.maxRetries = config.maxRetries ?? MAX_RETRIES;
  }

  async sendMessage(
    messages: MessageParam[],
    options: {
      systemPrompt?: string;
      enableWebSearch?: boolean;
      maxTokens?: number;
    } = {}
  ): Promise<Message> {
    const { systemPrompt } = options;

    // Build the prompt from messages
    const prompt = messages
      .map((m) => (m.role === 'user' ? m.content : `Assistant: ${m.content}`))
      .join('\n\n');

    let attempt = 0;
    let lastError: Error | undefined;

    while (attempt < this.maxRetries) {
      try {
        const textParts: string[] = [];

        // Use the Claude Agent SDK query function
        // It automatically uses Claude Code's local login if available,
        // otherwise falls back to ANTHROPIC_API_KEY
        const response = query({
          prompt,
          options: {
            model: MODEL,
            systemPrompt: systemPrompt
              ? { type: 'preset', preset: 'claude_code', append: systemPrompt }
              : undefined,
            allowedTools: [], // No tools needed for text generation
            permissionMode: 'bypassPermissions',
          },
        });

        for await (const message of response) {
          if (isAssistantMessage(message) && message.message?.content) {
            for (const block of message.message.content) {
              if ('text' in block && typeof block.text === 'string') {
                textParts.push(block.text);
              }
            }
          } else if (isResultMessage(message)) {
            if (message.subtype !== 'success') {
              throw new ClaudeClientError(
                `Query failed: ${message.subtype}`,
                'QUERY_FAILED'
              );
            }
          }
        }

        return {
          content: [{ type: 'text', text: textParts.join('') }],
        };
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

  async extractText(response: Message): Promise<string> {
    return response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return (
        message.includes('rate limit') ||
        message.includes('overloaded') ||
        message.includes('connection') ||
        message.includes('timeout')
      );
    }
    return false;
  }

  private wrapError(error: unknown): ClaudeClientError {
    if (error instanceof ClaudeClientError) {
      return error;
    }

    if (error instanceof Error) {
      const message = error.message.toLowerCase();

      if (message.includes('authentication') || message.includes('api key')) {
        return new ClaudeClientError(
          'Authentication failed. Please run "claude" to login or set ANTHROPIC_API_KEY.',
          'AUTHENTICATION_ERROR',
          error
        );
      }

      if (message.includes('rate limit')) {
        return new ClaudeClientError(
          'Rate limit exceeded',
          'RATE_LIMIT_ERROR',
          error
        );
      }

      if (message.includes('connection')) {
        return new ClaudeClientError(
          'Failed to connect to Claude',
          'CONNECTION_ERROR',
          error
        );
      }

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
