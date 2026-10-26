import { spawn } from 'node:child_process';
import type { CompletionRequest, LlmProvider } from './provider';

export interface CliProviderOptions {
  /** Executable, e.g. "claude" or "gemini". */
  command: string;
  /** Arguments that put the CLI in non-interactive print mode, e.g. ["-p"]. The prompt arrives on stdin. */
  args?: string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Flatten a conversation for CLIs that only accept a single prompt. */
export function flattenConversation(req: CompletionRequest): string {
  const parts = [`<instructions>\n${req.system}\n</instructions>`];
  for (const m of req.messages) parts.push(`<${m.role}>\n${m.content}\n</${m.role}>`);
  parts.push('Respond to the final <user> message now. Output only what the instructions ask for.');
  return parts.join('\n\n');
}

/** Local CLI backend (Claude Code, Gemini CLI, anything that reads a prompt on stdin and prints the answer). */
export class CliProvider implements LlmProvider {
  readonly name: string;

  constructor(private opts: CliProviderOptions) {
    this.name = `cli:${opts.command}`;
  }

  complete(req: CompletionRequest): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.command, this.opts.args ?? ['-p'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.opts.env ?? process.env,
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${this.opts.command} timed out after ${this.opts.timeoutMs ?? 600000}ms`));
      }, this.opts.timeoutMs ?? 600000);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`could not run "${this.opts.command}": ${e.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(`${this.opts.command} exited ${code}: ${err.trim().slice(0, 500)}`));
      });
      child.stdin.on('error', () => {}); // CLI may exit before reading everything
      child.stdin.end(flattenConversation(req));
    });
  }
}
