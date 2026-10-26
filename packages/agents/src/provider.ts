/** Anything that can turn a conversation into text. API and CLI backends both implement this. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
}

export interface LlmProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<string>;
}
