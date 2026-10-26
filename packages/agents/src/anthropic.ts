import Anthropic from '@anthropic-ai/sdk';
import type { CompletionRequest, LlmProvider } from './provider';

export interface AnthropicProviderOptions {
  /** Defaults to ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login` profile. */
  client?: Anthropic;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export class RefusalError extends Error {
  constructor(public category: string | null, explanation?: string | null) {
    super(`Model declined the request (category: ${category ?? 'unknown'})${explanation ? `: ${explanation}` : ''}`);
  }
}

/** Claude API backend. Streams, because shot/set JSON can be long, and uses adaptive thinking. */
export class AnthropicProvider implements LlmProvider {
  readonly name: string;
  private client: Anthropic;
  private model: string;
  private effort: NonNullable<AnthropicProviderOptions['effort']>;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? 'claude-opus-5-5';
    this.effort = opts.effort ?? 'medium';
    this.name = `anthropic:${this.model}`;
  }

  async complete(req: CompletionRequest): Promise<string> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: req.maxTokens ?? 32000,
      thinking: { type: 'adaptive' },
      output_config: { effort: this.effort },
      system: req.system,
      messages: req.messages,
    });
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') {
      throw new RefusalError(message.stop_details?.category ?? null, message.stop_details?.explanation);
    }
    if (message.stop_reason === 'max_tokens') {
      throw new Error('Model output was cut off at max_tokens; raise maxTokens or simplify the request');
    }
    return message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  }
}
