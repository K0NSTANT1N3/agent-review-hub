import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import type { ApiResponse, ApiRouteName, TaskView } from '@quorum/protocol';
import { App, initialView, type StreamFactory } from '../src/app.js';
import { ClientError, OWNER_TOKEN_HELP, type CallOptions, type QuorumApi } from '../src/api-client.js';
import { Screen } from '../src/components/screen.js';
import { widthOf } from '../src/text.js';
import type { StreamHandlers } from '../src/ws-stream.js';
import { agentView, detail, fixtureState, taskView, transcripts } from './fixtures.js';

afterEach(cleanup);

class FakeClient implements QuorumApi {
  calls: { route: ApiRouteName; options: CallOptions }[] = [];
  tasks = [taskView()];
  error?: { route: ApiRouteName; value: Error };
  async call<R extends ApiRouteName>(route: R, options: CallOptions = {}): Promise<ApiResponse<R>> {
    this.calls.push({ route, options });
    if (this.error?.route === route) throw this.error.value;
    const current = this.tasks.find((task) => task.id === options.id) ?? this.tasks[0]!;
    let response: unknown;
    switch (route) {
      case 'listTasks': response = { tasks: this.tasks }; break;
      case 'listAgents': response = { agents: fixtureState().agents }; break;
      case 'listSessions': response = { sessions: fixtureState().sessions }; break;
      case 'teamActivity': response = { activities: [], queue: [] }; break;
      case 'getTask': response = detail({ task: current }); break;
      case 'getTaskTranscript': response = { sessions: transcripts() }; break;
      case 'createDirective': response = { id: 'directive', createdAt: 9000, state: 'queued', resultText: null, error: null }; break;
      case 'getDirective': response = { id: 'directive', requester: 'tazo', agentId: 'claude@bob', sessionId: null, text: 'Why this TTL?', state: 'done', resultText: 'Recovered answer.', error: null, createdAt: 9000, finishedAt: 10000 }; break;
      default: {
        const state = route === 'pauseTask' ? 'PAUSED' : route === 'resumeTask' ? 'IN_REVIEW' : route === 'cancelTask' ? 'CANCELLED' : current.state;
        const next: TaskView = route === 'createTask' ? taskView({ id: 13, title: (options.body as { title: string }).title, state: 'QUEUED', updatedAt: 9000 }) : { ...current, state, updatedAt: current.updatedAt + 1000 };
        this.tasks = route === 'createTask' ? [next, ...this.tasks] : this.tasks.map((task) => task.id === next.id ? next : task);
        response = next;
      }
    }
    return response as ApiResponse<R>;
  }
}

async function harness(client = new FakeClient(), onAttach?: Parameters<typeof App>[0]['onAttach']) {
  let handlers: StreamHandlers | undefined;
  const start = vi.fn();
  const stop = vi.fn();
  const createStream: StreamFactory = (callbacks) => { handlers = callbacks; return { start, stop }; };
  const app = render(<App onAttach={onAttach} client={client} url="https://leader.test" token="test-token" createStream={createStream} seed={{ ...fixtureState(), tasks: client.tasks }} columns={80} rows={24} noColor />);
  await vi.waitFor(() => expect(app.lastFrame()).toContain('Rate-limit failed logins'));
  const key = async (text: string) => { app.stdin.write(text); await new Promise((resolve) => setTimeout(resolve, 100)); };
  const action = (route: ApiRouteName) => client.calls.filter((call) => call.route === route);
  return { ...app, client, key, action, start, stop, get handlers() { return handlers!; } };
}

describe('keyboard actions', () => {
  it('requires t then y to attach; n, Escape and input keep control in Ink', async () => {
    const attach = vi.fn();
    const app = await harness(new FakeClient(), attach);
    await app.key('t');
    expect(app.lastFrame()).toContain('Attach task #12 session? y/n');
    expect(attach).not.toHaveBeenCalled();
    await app.key('n');
    await app.key('t');
    await app.key('\u001b');
    expect(attach).not.toHaveBeenCalled();
    await app.key('i');
    await app.key('t');
    expect(attach).not.toHaveBeenCalled();
    await app.key('\u001b');
    await app.key('t');
    await app.key('y');
    expect(attach).toHaveBeenCalledWith(12, 'reviewer', expect.objectContaining({ sessions: expect.any(Array) }));
  });

  it('maps approve and pause/resume to the matching routes', async () => {
    const app = await harness();
    await app.key('a');
    expect(app.action('approveTask')).toEqual([{ route: 'approveTask', options: { id: 12 } }]);
    await app.key('p');
    expect(app.action('pauseTask')).toHaveLength(1);
    await app.key('p');
    expect(app.action('resumeTask')).toHaveLength(1);
    app.unmount();
    expect(app.stop).toHaveBeenCalledOnce();
  });

  it('requires y confirmation for cancel; n and escape leave the task intact', async () => {
    const app = await harness();
    await app.key('c');
    expect(app.lastFrame()).toContain('Cancel task #12? y/n');
    expect(app.action('cancelTask')).toHaveLength(0);
    await app.key('n');
    await app.key('c');
    await app.key('\u001b');
    expect(app.action('cancelTask')).toHaveLength(0);
    await app.key('c');
    await app.key('y');
    expect(app.action('cancelTask')).toEqual([{ route: 'cancelTask', options: { id: 12 } }]);
  });

  it('sends comments and author answers; shortcut letters remain literal inside input', async () => {
    const app = await harness();
    await app.key('s');
    await app.key('Fix TTL q?');
    await app.key('\r');
    expect(app.action('sendBackTask')[0]?.options).toEqual({ id: 12, body: { comment: 'Fix TTL q?' } });
    await app.key('m'); // send back -> ask
    await app.key('m'); // ask -> answer
    await app.key('\r');
    await app.key('Use Redis');
    await app.key('\r');
    expect(app.action('answerTask')[0]?.options).toEqual({ id: 12, body: { answer: 'Use Redis' } });
    expect(app.lastFrame()).toContain('Use Redis');
  });

  it('selects an agent with Tab/arrows and sends a directive without a locked session id', async () => {
    const app = await harness();
    await app.key('\t'); // chat -> input
    await app.key('\t'); // input -> agents
    expect(app.lastFrame()).toContain('Agents [2]');
    await app.key('\u001b[B');
    await app.key('\r');
    expect(app.lastFrame()).toContain('Ask an agent · claude@bob');
    await app.key('Why this TTL?');
    await app.key('\r');
    expect(app.action('createDirective')[0]?.options).toEqual({ body: { agentId: 'claude@bob', text: 'Why this TTL?' } });
    app.handlers.onEvent({ type: 'directive.updated', data: { id: 'directive', requester: 'tazo', agentId: 'claude@bob', sessionId: null, text: 'Why this TTL?', state: 'done', resultText: 'It is the required window.', error: null, createdAt: 9000, finishedAt: 10000 } });
    await vi.waitFor(() => expect(app.lastFrame()).toContain('It is the required window.'));
    app.handlers.onConnection('connected');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Recovered answer.'));
  });

  it('creates a task after title and description entry', async () => {
    const app = await harness();
    await app.key('/');
    await app.key('Rate');
    await app.key('\r');
    await app.key('n');
    await app.key('Add audit log');
    await app.key('\r');
    expect(app.lastFrame()).toContain('New task · description');
    await app.key('Log failed login attempts');
    await app.key('\r');
    expect(app.action('createTask')[0]?.options).toEqual({ body: { title: 'Add audit log', description: 'Log failed login attempts' } });
    expect(app.lastFrame()).toContain('#13 Chat');
  });

  it('filters/selects tasks, opens chat, and toggles help and follow mode', async () => {
    const client = new FakeClient();
    client.tasks.push(taskView({ id: 11, title: 'Audit log' }));
    const app = await harness(client);
    await vi.waitFor(() => expect(client.calls.some((call) => call.route === 'listTasks')).toBe(true));
    await app.key('\u001b[B');
    expect(app.lastFrame()).toContain('#11 Chat');
    await app.key('/');
    await app.key('Rate');
    await app.key('\r');
    expect(app.lastFrame()).toContain('Tasks [1] /Rate');
    await app.key('\r');
    expect(app.lastFrame()).toContain('#12 Chat');
    await app.key('?');
    expect(app.lastFrame()).toContain('Help');
    await app.key('?');
    await app.key('\u001b[5~');
    expect(app.lastFrame()).toContain('follow off');
    await app.key('\u001b[6~');
    expect(app.lastFrame()).toContain('follow on');
  });

  it('keeps HTTP errors and full owner token guidance readable inline', async () => {
    const client = new FakeClient();
    client.error = { route: 'approveTask', value: new ClientError(403, 'FORBIDDEN', `HTTP 403: Requester token. ${OWNER_TOKEN_HELP}`) };
    const app = await harness(client);
    await app.key('a');
    expect(app.lastFrame()).toContain('Error · Esc dismiss');
    expect(app.lastFrame()).toContain('owner token');
    expect(app.lastFrame()).toContain('quorum-leader add-token --scope owner');
    await app.key('\u001b');
    expect(app.lastFrame()).not.toContain('Error · Esc dismiss');
  });

  it('falls back to messages on old Leaders and avoids probing unsupported transcript routes again', async () => {
    const client = new FakeClient();
    client.error = { route: 'getTaskTranscript', value: new ClientError(404, 'NOT_FOUND', 'Not found') };
    const app = await harness(client);
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Transcripts unavailable on this Leader; messages only.'));
    const count = app.action('getTaskTranscript').length;
    app.handlers.onConnection('connected');
    await vi.waitFor(() => expect(app.action('getTask').length).toBeGreaterThan(1));
    expect(app.action('getTaskTranscript')).toHaveLength(count);
    expect(app.lastFrame()).toContain('submitted');
    expect(app.lastFrame()).not.toContain('Added a Redis counter');
  });

  it('shows connection/auth changes and catches up REST data on reconnect', async () => {
    const app = await harness();
    app.handlers.onConnection('reconnecting');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('reconnecting'));
    const count = app.action('listTasks').length;
    app.handlers.onConnection('connected');
    await vi.waitFor(() => expect(app.action('listTasks').length).toBeGreaterThan(count));
    app.handlers.onConnection('auth-error');
    app.handlers.onAuthError('revoked');
    await vi.waitFor(() => expect(app.lastFrame()).toContain('authentication failed: revoked'));
  });

  it('quits with q and cleans up the stream', async () => {
    const app = await harness();
    await app.key('q');
    expect(app.stop).toHaveBeenCalledOnce();
  });

  it('handles bracketed paste in task filters without treating text as shortcuts', async () => {
    const app = await harness();
    await app.key('/');
    await app.key('\u001b[200~Rate\u001b[201~');
    await app.key('\r');
    expect(app.lastFrame()).toContain('Tasks [1] /Rate');
    expect(app.action('approveTask')).toHaveLength(0);
  });

  it('refreshes selected task details after live task events and shows an escalated question', async () => {
    const app = await harness();
    const before = app.action('getTask').length;
    const task = taskView({ state: 'ESCALATED', escalationReason: 'author_blocked: Which database?', updatedAt: 11000 });
    app.client.tasks = [task];
    app.handlers.onEvent({ type: 'task.updated', data: task });
    await vi.waitFor(() => expect(app.action('getTask').length).toBeGreaterThan(before));
    await vi.waitFor(() => expect(app.lastFrame()).toContain('Needs a decision: Which database?'));
  });

  it('keeps the current task selected when a newer task arrives live', async () => {
    const app = await harness();
    await app.key('?');
    await app.key('?');
    app.handlers.onEvent({ type: 'task.updated', data: taskView({ id: 13, title: 'Another task', updatedAt: 12000 }) });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await vi.waitFor(() => expect(app.lastFrame()).toContain('#12 Chat'));
    await app.key('\u001b[B');
    await app.key('\u001b[A');
    expect(app.lastFrame()).toContain('#13 Chat');
  });
});

describe('fixed terminal rendering', () => {
  it('renders the 80×24 fixture with no ANSI colors', () => {
    const app = render(<Screen state={fixtureState()} view={initialView} columns={80} rows={24} team="leader.test" noColor />);
    const frame = app.lastFrame()!;
    expect(frame.split('\n')).toHaveLength(24);
    expect(frame.split('\n').every((line) => widthOf(line) <= 80)).toBe(true);
    expect(frame).not.toContain('\u001b');
    expect(frame).toMatchSnapshot();
  });

  it('collapses to tab panes, displays missing trust as unknown, and handles resize', async () => {
    const state = fixtureState();
    state.agents[0] = { ...state.agents[0]!, trust: undefined };
    const app = render(<Screen state={state} view={{ ...initialView, pane: 'agents' }} columns={80} rows={24} team="leader.test" noColor />);
    expect(app.lastFrame()).toContain('[unknown]');
    expect(app.lastFrame()).toContain('[codex]');
    expect(app.lastFrame()).not.toContain('#12 Chat');
    app.rerender(<Screen state={state} view={initialView} columns={120} rows={32} team="leader.test" noColor />);
    await vi.waitFor(() => expect(app.lastFrame()).toContain('1 Agents'));
    const frame = app.lastFrame()!;
    expect(frame).toContain('2 Tasks');
    expect(frame).toContain('#12 Chat');
    expect(frame.split('\n')).toHaveLength(32);
    expect(frame.split('\n').every((line) => widthOf(line) <= 120)).toBe(true);
  });

  it('shows the active adapter type and truncates extra CLIs at a word boundary', () => {
    const state = fixtureState();
    state.agents[0] = agentView({
      adapterType: 'claude-code',
      detectedAgents: [
        { type: 'claude-code', version: '2.1.305', trust: 'enforced' },
        { type: 'codex', version: '0.163.0', trust: 'sandboxed' },
        { type: 'pi', version: '1.3.0', trust: 'low' },
        { type: 'opencode', version: '0.15.0', trust: 'sandboxed' },
      ],
    });
    const app = render(<Screen state={state} view={{ ...initialView, pane: 'agents' }} columns={40} rows={24} team="leader.test" noColor />);
    const frame = app.lastFrame()!;
    expect(frame).toContain('[claude-code]');
    expect(frame).not.toMatch(/\[claude-code,/);
    expect(frame).toContain('also: codex 0.163.0');
    expect(frame).toMatch(/also: .+\.\.\.|also: .+…/);
    expect(frame).not.toContain('opencod');
    app.rerender(<Screen state={{ ...state, agents: [agentView({ adapterType: undefined, detectedAgents: [] })] }} view={{ ...initialView, pane: 'agents' }} columns={40} rows={24} team="leader.test" noColor />);
    expect(app.lastFrame()).toContain('[unknown]');
  });
});
