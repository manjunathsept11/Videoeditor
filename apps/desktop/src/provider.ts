import { AnthropicProvider, CliProvider, type LlmProvider } from '@shortstudio/agents';
import type { Settings } from './api';

export const DEFAULT_SETTINGS: Settings = { provider: 'cli', model: 'claude-opus-5-5', cliCommand: 'claude', cliArgs: '-p' };

/** The model backend the settings describe. `apiKey` falls back to the environment (ANTHROPIC_API_KEY or an `ant auth login` profile). */
export function providerFromSettings(s: Settings, apiKey?: string): LlmProvider {
  if (s.provider === 'cli') return new CliProvider({ command: s.cliCommand, args: s.cliArgs.split(/\s+/).filter(Boolean) });
  return new AnthropicProvider({ model: s.model, apiKey });
}
