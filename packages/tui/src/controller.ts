import type { QuorumApi } from './api-client.js';
import type { TranscriptSession } from '@quorum/protocol';
import { ClientError, loadTranscript } from './api-client.js';
import type { StoreAction } from './store.js';

export type Dispatch = (action: StoreAction) => void;
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export async function refreshDetail(client: QuorumApi, taskId: number, dispatch: Dispatch): Promise<void> {
  try { dispatch({ type: 'detail', detail: await client.call('getTask', { id: taskId }) }); }
  catch (error) { dispatch({ type: 'error', error: errorMessage(error) }); }
}

export async function refreshDirectives(client: QuorumApi, ids: string[], dispatch: Dispatch): Promise<void> {
  await Promise.all(ids.map(async (id) => {
    try { dispatch({ type: 'ui', event: { type: 'directive.updated', data: await client.call('getDirective', { id }) } }); }
    catch (error) { dispatch({ type: 'error', error: errorMessage(error) }); }
  }));
}

export async function refreshTeam(client: QuorumApi, dispatch: Dispatch, revision?: number): Promise<void> {
  const requests = [
    client.call('listTasks').then(({ tasks }) => dispatch({ type: 'tasks', tasks })),
    client.call('listAgents').then(({ agents }) => dispatch({ type: 'agents', agents, revision })),
    client.call('listSessions').then(({ sessions }) => dispatch({ type: 'sessions', sessions, revision })),
    client.call('teamActivity').then(({ activities }) => dispatch({ type: 'activities', activities, revision })).catch((error: unknown) => {
      // Requester tokens can read tasks and sessions but cannot read team activity.
      if (!(error instanceof ClientError && error.status === 403)) throw error;
    }),
  ];
  const results = await Promise.allSettled(requests);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') dispatch({ type: 'error', error: errorMessage(failed.reason) });
}

export async function refreshTask(client: QuorumApi, taskId: number, dispatch: Dispatch, supported?: boolean, transcripts: TranscriptSession[] = []): Promise<void> {
  const afterSeq = Object.fromEntries(transcripts.map((session) => [session.sid, session.events.at(-1)?.seq ?? 0]));
  const results = await Promise.allSettled([
    client.call('getTask', { id: taskId }).then((detail) => dispatch({ type: 'detail', detail })),
    ...(supported === false ? [] : [loadTranscript(client, taskId).then((result) => dispatch({ type: 'transcript', taskId, afterSeq, ...result }))]),
  ]);
  for (const result of results) if (result.status === 'rejected') dispatch({ type: 'error', error: errorMessage(result.reason) });
}
