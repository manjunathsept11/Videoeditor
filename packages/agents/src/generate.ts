import type { z } from 'zod';
import { extractJson } from './json';
import type { ChatMessage, LlmProvider } from './provider';

export class GenerationError extends Error {
  constructor(public what: string, public attempts: string[]) {
    super(`${what}: gave up after ${attempts.length} attempt(s).\nLast problem:\n${attempts[attempts.length - 1]}`);
  }
}

export interface GenerateOptions<T> {
  provider: LlmProvider;
  what: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** Extra semantic checks the schema cannot express. Return problems, or [] when fine. */
  check?: (value: T) => string[];
  maxAttempts?: number;
  maxTokens?: number;
}

/**
 * Ask for JSON, validate against a zod schema (and optional semantic checks), and on failure
 * show the model its own answer plus the exact problems so it can repair rather than restart.
 */
export async function generateValidated<T>(o: GenerateOptions<T>): Promise<T> {
  const messages: ChatMessage[] = [{ role: 'user', content: o.user }];
  const problems: string[] = [];
  const max = o.maxAttempts ?? 3;
  for (let attempt = 1; attempt <= max; attempt++) {
    const text = await o.provider.complete({ system: o.system, messages, maxTokens: o.maxTokens });
    let issues: string[];
    let value: T | undefined;
    try {
      const parsed = o.schema.safeParse(extractJson(text));
      if (parsed.success) {
        value = parsed.data;
        issues = o.check?.(value) ?? [];
      } else {
        issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      }
    } catch (e) {
      issues = [(e as Error).message];
    }
    if (issues.length === 0 && value !== undefined) return value;
    problems.push(issues.join('\n'));
    messages.push(
      { role: 'assistant', content: text },
      { role: 'user', content: `That output has problems:\n- ${issues.join('\n- ')}\n\nFix them and output the complete corrected JSON again, nothing else.` },
    );
  }
  throw new GenerationError(o.what, problems);
}
