import { randomUUID } from 'node:crypto';
import type { AdapterConfig } from '@quorum/protocol';
import { runCliProcess, type SpawnFn } from './cli-process.js';
import { sanitizeFailureMessage, splitText, toolKindFor, truncateUtf8 } from './event-utils.js';
import { AdapterError, type AgentAdapter } from './types.js';

type PiConfig = Extract<AdapterConfig, { type: 'pi' | 'omp' }>;

/** pi and omp share the message/execution event family; their launch and tool arguments differ. */
export function createPiAdapter(config: PiConfig, options: { spawnFn?: SpawnFn } = {}): AgentAdapter {
  return {
    createSession: async () => ({ nativeId: config.type === 'pi' ? randomUUID() : null }),
    runTurn: async ({ nativeId, cwd, profile, prompt, signal, timeoutMs, onEvent }) => {
      let id = nativeId ?? (config.type === 'pi' ? randomUUID() : null);
      const argv = ['--mode', 'json', '-p', '--no-extensions', '--no-skills'];
      if (config.type === 'pi') {
        argv.push('--session-id', id!, '--no-mcp', '--no-prompt-templates', '--no-themes', '--no-context-files');
      } else {
        // omp exposes no --no-mcp flag. Extension discovery is disabled, but configured MCP
        // servers cannot be disabled through a documented CLI switch in this release.
        argv.push('--no-rules', '--no-lsp', '--no-pty', '--no-title');
        // --auto-approve is author-only. Reviewer/directive use always-ask, the most
        // restrictive --approval-mode (always-ask|write|yolo). Print mode cannot present
        // an approval prompt, and configured MCP servers stay connected, so MCP writes
        // on a lent read-only turn remain unenforced.
        if (profile === 'author') argv.push('--auto-approve');
        else argv.push('--approval-mode', 'always-ask');
        if (id !== null) argv.push('--resume', id);
      }
      if (profile !== 'author') argv.push('--tools', config.type === 'pi' ? 'read,grep,find,ls' : 'read,grep,glob');
      if (config.model !== undefined) argv.push('--model', config.model);
      argv.push('--', prompt);

      const turnId = randomUUID();
      let messageNumber = 0;
      let messageId: string | undefined;
      let thinkingIndexes = new Set<number>();
      const countedMessages = new Set<string>();
      let text = '';
      let agentText = '';
      let finalMessage = false;
      let ended = false;
      let aborted = false;
      let turnError = '';
      let contextTokens = 0;
      const usage = { inputTokens: 0, outputTokens: 0 };
      const startMessage = () => {
        messageId = `${turnId}:${++messageNumber}`;
        thinkingIndexes = new Set();
      };
      const thinking = (value: string, index: number) => {
        thinkingIndexes.add(index);
        for (const chunk of splitText(value)) onEvent?.({ kind: 'thinking', text: chunk, messageId });
      };

      const result = await runCliProcess({
        binary: config.binaryPath ?? config.type, argv, cwd, signal, timeoutMs, spawnFn: options.spawnFn,
        onJson: (value) => {
          const event = record(value);
          const message = record(event.message);
          if (event.type === 'session' && typeof event.id === 'string') id = event.id;
          if (event.type === 'agent_end') ended = event.willRetry !== true;
          if (event.type === 'agent_settled' && event.aborted === true) aborted = true;
          if (event.type === 'error') turnError = typeof event.message === 'string' ? event.message : JSON.stringify(event.error ?? event);
          if (event.type === 'message_start' && message.role === 'assistant') startMessage();
          if (event.type === 'message_update' && (message.role === undefined || message.role === 'assistant')) {
            if (messageId === undefined) startMessage();
            const update = record(event.assistantMessageEvent);
            const index = typeof update.contentIndex === 'number' ? update.contentIndex : 0;
            if (update.type === 'text_delta' && typeof update.delta === 'string') {
              agentText += update.delta;
              for (const chunk of splitText(update.delta)) onEvent?.({ kind: 'text', mode: 'delta', text: chunk, messageId });
            }
            if (update.type === 'thinking_delta' && typeof update.delta === 'string') thinking(update.delta, index);
            if (update.type === 'thinking_end' && typeof update.content === 'string' && !thinkingIndexes.has(index)) thinking(update.content, index);
          }
          if (event.type === 'message_end' && message.role === 'assistant') {
            if (messageId === undefined) startMessage();
            const key = typeof message.responseId === 'string' ? message.responseId : messageId!;
            if (countedMessages.has(key)) return;
            countedMessages.add(key);
            const content = Array.isArray(message.content) ? message.content.map(record) : [];
            const snapshot = textContent(content);
            agentText += snapshot;
            if (content.some((part) => part.type === 'text')) {
              for (const chunk of splitText(snapshot)) onEvent?.({ kind: 'text', mode: 'final', text: chunk, messageId });
            }
            content.forEach((part, index) => {
              if (part.type === 'thinking' && typeof part.thinking === 'string' && !thinkingIndexes.has(index)) thinking(part.thinking, index);
            });
            if (message.stopReason === 'stop') {
              text = snapshot;
              finalMessage = true;
            }
            if (message.stopReason === 'aborted') aborted = true;
            if (message.stopReason === 'error') turnError = typeof message.errorMessage === 'string' ? message.errorMessage : 'Assistant message failed.';
            const counters = record(message.usage);
            const inputTokens = tokens(counters.input);
            const outputTokens = tokens(counters.output);
            const totalTokens = tokens(counters.totalTokens);
            usage.inputTokens += inputTokens ?? 0;
            usage.outputTokens += outputTokens ?? 0;
            // Latest model call estimates context; summing these totals would count history repeatedly.
            if (totalTokens !== undefined) contextTokens = totalTokens;
            if (inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined) {
              onEvent?.({ kind: 'usage', inputTokens, outputTokens, contextTokens: totalTokens });
            }
          }
          if (event.type === 'tool_execution_start' && typeof event.toolCallId === 'string' && typeof event.toolName === 'string') {
            const args = record(event.args);
            // omp edits use args.input (hash-line text), while pi edits use args.path/edits.
            const summary = typeof args.command === 'string' ? args.command
              : typeof args.path === 'string' ? args.path : typeof args.input === 'string' ? args.input : '';
            const paths = typeof args.path === 'string' && args.path.length > 0 ? [args.path.slice(0, 1024)] : undefined;
            onEvent?.({
              kind: 'tool_call', id: event.toolCallId, name: event.toolName.slice(0, 100),
              toolKind: toolKindFor(event.toolName), argsSummary: summary.slice(0, 256), ...(paths === undefined ? {} : { paths }),
            });
          }
          if (event.type === 'tool_execution_end' && typeof event.toolCallId === 'string') {
            const toolResult = record(event.result);
            const structured = record(toolResult.structuredContent);
            const exitCode = typeof structured.exit_code === 'number' && Number.isInteger(structured.exit_code) ? structured.exit_code : undefined;
            onEvent?.({
              kind: 'tool_result', id: event.toolCallId, ok: event.isError !== true,
              output: truncateUtf8(textContent(toolResult.content)), ...(exitCode === undefined ? {} : { exitCode }),
            });
          }
        },
      });
      if (aborted) throw new AdapterError('CANCELLED');
      const detail = [turnError, result.stderr, agentText].filter(Boolean).join('\n');
      if (/rate limit|usage limit|429/i.test(detail)) throw new AdapterError('RATE_LIMITED', sanitizeFailureMessage(detail));
      if (result.code !== 0 || !ended || !finalMessage || id === null || id.length === 0 || turnError !== '') {
        throw new AdapterError('ADAPTER_ERROR', sanitizeFailureMessage(`${config.type} turn did not complete (exit ${result.code}, signal ${result.signal}). ${detail}\n${result.malformedLines.join('\n')}`));
      }
      return { nativeId: id, text, usage, contextTokens };
    },
    closeSession: async () => {},
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textContent(value: unknown): string {
  return Array.isArray(value)
    ? value.map(record).filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text as string).join('')
    : '';
}

function tokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
