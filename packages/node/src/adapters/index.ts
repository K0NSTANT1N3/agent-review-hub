import { DEFAULT_AUTHOR_BASH_ALLOW, type AdapterConfig } from '@quorum/protocol';
import type { AgentAdapter } from './types.js';
import { createMockAdapter } from './mock.js';

interface ClaudeCodeModule {
  createClaudeCodeAdapter(options: { authorBashAllow: readonly string[]; model?: string }): AgentAdapter | Promise<AgentAdapter>;
}

interface OpencodeModule {
  createOpencodeAdapter(config: Extract<AdapterConfig, { type: 'opencode' }>): AgentAdapter | Promise<AgentAdapter>;
}

/** Load only the selected adapter so mock-only installations need no provider SDK. */
export async function createAdapter(
  config: AdapterConfig,
  options: { authorBashAllow?: readonly string[] } = {},
): Promise<AgentAdapter> {
  switch (config.type) {
    case 'codex':
    case 'pi':
    case 'omp':
    case 'kilo':
      throw new Error(`${config.type} adapter not implemented yet`);
    case 'mock':
      return createMockAdapter(config);
    case 'opencode': {
      const modulePath: string = './opencode.js';
      try {
        const adapterModule = await import(modulePath) as OpencodeModule;
        return adapterModule.createOpencodeAdapter(config);
      } catch (error) {
        throw new Error(`Could not load the opencode adapter: ${message(error)}`, { cause: error });
      }
    }
    case 'claude-code': {
      const modulePath: string = './claude-code.js';
      try {
        const adapterModule = await import(modulePath) as ClaudeCodeModule;
        const adapterOptions = {
          authorBashAllow: options.authorBashAllow ?? DEFAULT_AUTHOR_BASH_ALLOW,
          ...(config.model === undefined ? {} : { model: config.model }),
        };
        return adapterModule.createClaudeCodeAdapter(adapterOptions);
      } catch (error) {
        throw new Error(`Could not load the Claude Code adapter: ${message(error)}`, { cause: error });
      }
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
