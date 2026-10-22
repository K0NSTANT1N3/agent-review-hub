import { randomUUID } from 'node:crypto';
import type { AdapterConfig } from '@quorum/protocol';
import { runCliProcess, type SpawnFn } from './cli-process.js';
import { sanitizeFailureMessage, splitText, toolKindFor, truncateUtf8 } from './event-utils.js';
import { AdapterError, type AgentAdapter } from './types.js';

type CustomConfig = Extract<AdapterConfig, { type: 'custom' }>;

/** Dotted own-property paths, including array indexes. Never evaluate configured expressions. */
export function jsonField(value: unknown, path: string | undefined): unknown {
  if (path === undefined) return undefined;
  let current = value;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Low trust: the operator supplies each profile's native permission flags. */
export function createCustomAdapter(config: CustomConfig, options: { spawnFn?: SpawnFn } = {}): AgentAdapter {
  return {
    createSession: async () => ({ nativeId: null }),
    runTurn: async ({ nativeId, cwd, profile, prompt, signal, timeoutMs, onEvent }) => {
      const template = config.profiles[profile];
      const selected = nativeId === null ? template : template.resume ?? template;
      // A callback keeps $&, $', braces and other prompt content literal and avoids recursive substitution.
      const expand = (arg: string) => arg.replace(/\{(prompt|sessionId)\}/g, (_, key: string) => key === 'prompt' ? prompt : nativeId ?? '');
      const argv = selected.args.map(expand);
      const turnId = randomUUID();
      let id = nativeId;
      let text = '';
      let ended = false;
      let receivedText = false;
      let textMessageId: string | undefined;
      let messageNumber = 0;
      const usage = { inputTokens: 0, outputTokens: 0 };
      let contextTokens = 0;
      const mapping = config.mapping;
      const result = await runCliProcess({
        binary: selected.command, argv, cwd, signal, timeoutMs, spawnFn: options.spawnFn,
        onJson: (event) => {
          const session = jsonField(event, config.sessionIdPath);
          if (typeof session === 'string' && session.length > 0) id = session;
          const type = jsonField(event, config.eventTypePath);
          if (type === mapping.turn_end.event) ended = true;
          if (type === mapping.text.event) {
            const content = jsonField(event, mapping.text.text);
            if (typeof content === 'string') {
              receivedText = true;
              const message = jsonField(event, mapping.text.messageId);
              const key = typeof message === 'string' ? message : mapping.text.mode === 'delta' ? 'text' : String(++messageNumber);
              const messageId = `${turnId}:${key}`.slice(0, 256);
              text = mapping.text.mode === 'delta' && textMessageId === messageId ? text + content : content;
              textMessageId = messageId;
              for (const chunk of splitText(content)) onEvent?.({ kind: 'text', mode: mapping.text.mode, text: chunk, messageId });
            }
          }
          if (mapping.tool_call !== undefined && type === mapping.tool_call.event) {
            const callId = jsonField(event, mapping.tool_call.id);
            const name = jsonField(event, mapping.tool_call.name);
            const summary = jsonField(event, mapping.tool_call.argsSummary);
            if (typeof callId === 'string' && callId && typeof name === 'string' && name) {
              onEvent?.({ kind: 'tool_call', id: `${turnId}:${callId}`.slice(0, 256), name: name.slice(0, 100),
                toolKind: toolKindFor(name), argsSummary: typeof summary === 'string' ? summary.slice(0, 256) : '' });
            }
          }
          if (mapping.tool_result !== undefined && type === mapping.tool_result.event) {
            const callId = jsonField(event, mapping.tool_result.id);
            const output = jsonField(event, mapping.tool_result.output);
            const ok = jsonField(event, mapping.tool_result.ok);
            const exitCode = jsonField(event, mapping.tool_result.exitCode);
            if (typeof callId === 'string' && callId && typeof ok === 'boolean') {
              onEvent?.({ kind: 'tool_result', id: `${turnId}:${callId}`.slice(0, 256), ok,
                output: truncateUtf8(typeof output === 'string' ? output : ''),
                ...(typeof exitCode === 'number' && Number.isSafeInteger(exitCode) ? { exitCode } : {}) });
            }
          }
          if (mapping.usage !== undefined && type === mapping.usage.event) {
            const inputTokens = tokenCount(jsonField(event, mapping.usage.inputTokens));
            const outputTokens = tokenCount(jsonField(event, mapping.usage.outputTokens));
            const context = tokenCount(jsonField(event, mapping.usage.contextTokens));
            usage.inputTokens += inputTokens ?? 0;
            usage.outputTokens += outputTokens ?? 0;
            if (context !== undefined) contextTokens = context;
            if (inputTokens !== undefined || outputTokens !== undefined || context !== undefined) {
              onEvent?.({ kind: 'usage', inputTokens, outputTokens, contextTokens: context });
            }
          }
        },
      });
      if (result.code !== 0 || !ended || !receivedText || id === null) {
        const detail = sanitizeFailureMessage(`Custom CLI turn did not complete. ${result.stderr}\n${result.malformedLines.join('\n')}`);
        throw new AdapterError(/rate[ _-]?limit|usage[ _-]?limit|429/i.test(detail) ? 'RATE_LIMITED' : 'ADAPTER_ERROR', detail);
      }
      return { nativeId: id, text, usage, contextTokens: contextTokens || Math.ceil((prompt.length + text.length) / 4) };
    },
    closeSession: async () => {},
  };
}
