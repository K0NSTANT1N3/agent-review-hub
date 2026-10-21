import type { TaskView } from '@quorum/protocol';
import type { QuorumApi } from './api-client.js';
import type { Dispatch } from './controller.js';

export type MessageMode = 'answer' | 'send-back' | 'ask';
export type Command =
  | { kind: 'approve'; task: TaskView }
  | { kind: 'pause'; task: TaskView }
  | { kind: 'cancel'; task: TaskView }
  | { kind: 'message'; task: TaskView; mode: MessageMode; text: string; agentId?: string }
  | { kind: 'create'; title: string; description: string };

export function shortcut(input: string): 'approve' | 'send-back' | 'pause' | 'cancel' | 'create' | undefined {
  const shortcuts: Record<string, 'approve' | 'send-back' | 'pause' | 'cancel' | 'create'> = { a: 'approve', s: 'send-back', p: 'pause', c: 'cancel', n: 'create' };
  return shortcuts[input];
}

export async function executeCommand(client: QuorumApi, command: Command, dispatch: Dispatch): Promise<void> {
  if (command.kind === 'create') {
    const task = await client.call('createTask', { body: { title: command.title, description: command.description } });
    dispatch({ type: 'tasks', tasks: [task] });
    return;
  }
  const id = command.task.id;
  if (command.kind === 'message' && command.mode === 'ask') {
    if (!command.agentId) throw new Error('Select an agent in the Agents pane first');
    const directive = await client.call('createDirective', { body: { agentId: command.agentId, text: command.text } });
    dispatch({ type: 'human', taskId: id, action: { id: `directive:${directive.id}`, at: directive.createdAt, directiveId: directive.id, text: `Asked ${command.agentId}: ${command.text}\nResult: ${directive.resultText ?? directive.error ?? directive.state}` } });
    return;
  }
  const task = command.kind === 'approve' ? await client.call('approveTask', { id })
    : command.kind === 'pause' ? await client.call(command.task.state === 'PAUSED' ? 'resumeTask' : 'pauseTask', { id })
      : command.kind === 'cancel' ? await client.call('cancelTask', { id })
        : command.mode === 'send-back' ? await client.call('sendBackTask', { id, body: { comment: command.text } })
          : await client.call('answerTask', { id, body: { answer: command.text } });
  dispatch({ type: 'tasks', tasks: [task] });
  if (command.kind === 'message') dispatch({ type: 'human', taskId: id, action: { id: `human:${Date.now()}`, at: Date.now(), comment: command.text, text: `${command.mode === 'answer' ? 'Answered author' : 'Sent back'}: ${command.text}` } });
}
