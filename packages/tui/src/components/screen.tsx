import { Box, Text } from 'ink';
import type { AgentView, TaskView } from '@quorum/protocol';
import { buildChat, transcriptUsage } from '../chat-model.js';
import type { MessageMode } from '../actions.js';
import { emptyTaskData, filteredTasks, type State } from '../store.js';
import { editorLine, fit, wrap, type Editor } from '../text.js';
import { chatLines, viewport } from './chat.js';
import { Panel, type DisplayLine } from './panel.js';

export type Pane = 'agents' | 'tasks' | 'chat' | 'input';
export type InputMode = 'message' | 'filter' | 'new-title' | 'new-description';
export interface ViewState {
  pane: Pane;
  taskId?: number;
  agentIndex: number;
  filter: string;
  mode: MessageMode;
  editor: Editor;
  inputMode: InputMode;
  chatTop: number | null;
  help: boolean;
  confirmCancel: boolean;
  busy: boolean;
}

export function selectedTask(state: State, view: ViewState): TaskView | undefined {
  const tasks = filteredTasks(state.tasks, view.filter);
  return tasks.find((task) => task.id === view.taskId) ?? tasks[0];
}

export function activeSids(state: State, task: TaskView | undefined): Set<string> {
  if (!task || !['AUTHORING', 'IN_REVIEW', 'SYNCING'].includes(task.state)) return new Set();
  const matching = state.sessions.filter((session) => session.state === 'locked' && session.lockKind === 'task' && session.lockRef === String(task.id) && session.lockRole === (task.state === 'IN_REVIEW' ? 'reviewer' : 'author'));
  const activity = state.activities.filter((item) => item.taskId === task.id && item.activityState === 'working' && item.sessionId !== null);
  const sids = [...matching.map((session) => session.id), ...activity.map((item) => item.sessionId!)];
  if (sids.length === 0 && task.state !== 'IN_REVIEW' && task.authorSessionId) sids.push(task.authorSessionId);
  if (sids.length === 0 && task.state === 'IN_REVIEW') {
    const conversation = state.data[task.id]?.detail?.conversations.find((item) => item.state === 'active');
    if (conversation) sids.push(conversation.reviewerSessionId);
  }
  return new Set(sids);
}

export function taskChatLines(state: State, view: ViewState, width: number, tick = 0): DisplayLine[] {
  const task = selectedTask(state, view);
  if (!task) return [{ text: 'No tasks. Press n to create a task.', dim: true }];
  const data = state.data[task.id] ?? emptyTaskData();
  const active = activeSids(state, task);
  const entries = buildChat({ ...data, issues: data.detail?.issues, activeSids: active });
  if (task.state === 'ESCALATED' && task.escalationReason) entries.push({ id: 'escalation', at: task.updatedAt, speaker: 'Leader', kind: 'event', text: `Needs a decision: ${task.escalationReason.replace(/^author_blocked:\s*/, '')}` });
  if (task.state === 'PAUSED' && task.pauseReason) entries.push({ id: 'paused', at: task.updatedAt, speaker: 'Leader', kind: 'event', text: `Paused: ${task.pauseReason}` });
  for (const sid of active) {
    if (entries.some((entry) => entry.sid === sid && entry.kind === 'status')) continue;
    const session = state.sessions.find((item) => item.id === sid);
    const transcript = data.transcripts.find((item) => item.sid === sid);
    entries.push({ id: `working:${sid}`, at: task.updatedAt, speaker: `${transcript?.agentId ?? session?.agentId ?? task.authorAgentId ?? 'Agent'} [${task.state === 'IN_REVIEW' ? 'reviewer' : 'author'}]`, kind: 'status', text: 'working', sid });
  }
  return entries.length ? chatLines(entries, width - 4, tick) : [{ text: data.detail ? task.description : 'Loading task…', dim: true }];
}

export function chatHeight(state: State, view: ViewState, rows: number): number {
  const task = selectedTask(state, view);
  return Math.max(1, rows - 12 - (task && state.data[task.id]?.transcriptSupported === false ? 1 : 0));
}

export const HELP = [
  '↑/↓ Select task; in Agents, select directive target',
  'Tab / Shift+Tab Switch Agents, Tasks, Chat, Input',
  'Enter Open chat / ask selected agent / send input',
  'i Answer author (focus input); Esc Leave input / close help',
  'm Cycle answer author / send back / ask an agent',
  'a Approve task; s Send back with a comment',
  'p Pause / resume task; c Cancel (y/n confirmation)',
  'n New task: enter title, then description (own mode)',
  '/ Filter tasks by id, title or state; Esc Finish filter',
  'PgUp Stop following and scroll up; PgDn Scroll / follow',
  'Home / End Move cursor; ←/→ Edit message',
  '? Toggle help; q Quit (outside input); Ctrl+C Quit',
  'Chat timestamps are UTC. Tool details stay on the Node.',
  'Ask creates a read-only directive on the selected agent.',
];

function agentLines(agents: AgentView[], selected: number, height: number): DisplayLine[] {
  const start = Math.max(0, selected - Math.max(0, Math.floor(height / 3) - 1));
  return agents.slice(start).flatMap((agent, index) => {
    const detected = agent.detectedAgents ?? [];
    const chosen = index + start === selected;
    return [
      { text: `${chosen ? '›' : ' '} ${agent.status === 'online' ? agent.lockedSessions ? '✻' : '●' : '○'} ${agent.id} [${detected.map((item) => item.type).join(',') || 'unknown'}]`, selected: chosen },
      { text: `  ${detected.map((item) => `${item.type} ${item.version}`).join(' · ') || 'version unknown'}`, dim: true },
      { text: `  [${agent.trust ?? 'unknown'}] · ${agent.ownerName} · ${agent.paused ? 'paused' : agent.status}`, dim: true },
    ];
  });
}

function testState(state: State, task?: TaskView): string {
  if (!task) return 'tests unknown';
  const messages = state.data[task.id]?.messages ?? [];
  const last = messages.filter((message) => message.type === 'author.submitted' || message.type === 'author.synced').sort((a, b) => b.createdAt - a.createdAt)[0];
  if (last && typeof last.payload === 'object' && last.payload !== null && 'tests' in last.payload) {
    const tests: unknown = last.payload.tests;
    if (tests && typeof tests === 'object' && 'passed' in tests && typeof tests.passed === 'boolean') return tests.passed ? 'tests passed' : 'tests failed';
  }
  return 'tests unknown';
}

export function Screen({ state, view, columns, rows, team, warning, tick = 0, noColor = false }: {
  state: State; view: ViewState; columns: number; rows: number; team: string; warning?: string; tick?: number; noColor?: boolean;
}) {
  const width = Math.max(20, columns);
  const height = Math.max(16, rows);
  const bodyHeight = height - 9;
  const compact = width < 110 || height < 28;
  const sideWidth = compact ? width : Math.min(42, Math.floor(width * 0.32));
  const chatWidth = compact ? width : width - sideWidth;
  const task = selectedTask(state, view);
  const tasks = filteredTasks(state.tasks, view.filter);
  const selected = tasks.findIndex((item) => item.id === task?.id);
  const start = Math.max(0, selected - Math.max(0, Math.floor((bodyHeight - 2) / 2) - 1));
  const taskLines = tasks.slice(start).flatMap((item) => [
    { text: `${item.id === task?.id ? '›' : ' '} #${item.id} ${item.state}`, selected: item.id === task?.id },
    { text: `  ${item.title}`, selected: item.id === task?.id },
  ]);
  const taskPanel = (panelHeight: number) => <Panel title={`2 Tasks [${tasks.length}]${view.filter ? ` /${view.filter}` : ''}`} width={sideWidth} height={panelHeight} focused={view.pane === 'tasks'} lines={taskLines} noColor={noColor} />;
  const agentsPanel = (panelHeight: number) => <Panel title={`1 Agents [${state.agents.length}]`} width={sideWidth} height={panelHeight} focused={view.pane === 'agents'} lines={agentLines(state.agents, view.agentIndex, panelHeight - 2)} noColor={noColor} />;
  const unsupported = task && state.data[task.id]?.transcriptSupported === false;
  const chat = taskChatLines(state, view, chatWidth, tick);
  const chatPanel = <Panel title={`3 ${task ? `#${task.id} Chat` : 'Chat'} · follow ${view.chatTop === null ? 'on' : 'off'}`} width={chatWidth} height={bodyHeight} focused={view.pane === 'chat'} noColor={noColor} lines={[
    { text: task ? `${task.title} · ${task.state}` : 'Team task chat', bold: true },
    ...(unsupported ? [{ text: 'Transcripts unavailable on this Leader; messages only.', dim: true }] : []),
    ...viewport(chat, chatHeight(state, view, height), view.chatTop),
  ]} />;
  const agent = state.agents[Math.min(view.agentIndex, state.agents.length - 1)];
  const mode = view.mode === 'answer' ? `Answer author · ${task?.authorAgentId ?? 'unassigned'}` : view.mode === 'send-back' ? 'Send back' : `Ask an agent · ${agent?.id ?? 'select agent'}`;
  const inputTitle = view.confirmCancel ? `Cancel task #${task?.id}? y/n` : view.inputMode === 'filter' ? 'Filter tasks' : view.inputMode === 'new-title' ? 'New task · title' : view.inputMode === 'new-description' ? 'New task · description' : mode;
  const input = view.confirmCancel ? 'Press y to cancel, n to keep task.' : view.busy ? 'Sending…' : view.pane === 'input' ? editorLine(view.editor, width - 6) : 'Enter: write message · m: change mode';
  const usage = task ? transcriptUsage(state.data[task.id]?.transcripts ?? []) : '';
  return (
    <Box width={width} height={height} flexDirection="column" overflow="hidden">
      <Text bold={!noColor}>{fit(`QUORUM · ${team} · ${state.connection} · ${view.pane}`, width)}</Text>
      <Text>{fit(`branch ${task?.branch ?? '—'} · head ${(task?.headCommit ?? '—').slice(0, 7)} · ${testState(state, task)}`, width)}</Text>
      <Box height={bodyHeight} flexShrink={0}>
        {state.error ? <Panel title="Error · Esc dismiss" width={width} height={bodyHeight} lines={wrap(state.error, width - 4).map((text) => ({ text, failed: true }))} focused noColor={noColor} />
          : view.help ? <Panel title="Help" width={width} height={bodyHeight} lines={HELP.map((text) => ({ text }))} focused noColor={noColor} />
          : compact ? view.pane === 'agents' ? agentsPanel(bodyHeight) : view.pane === 'tasks' ? taskPanel(bodyHeight) : chatPanel
            : <><Box width={sideWidth} flexDirection="column">{agentsPanel(Math.ceil(bodyHeight / 2))}{taskPanel(Math.floor(bodyHeight / 2))}</Box>{chatPanel}</>}
      </Box>
      <Panel title={inputTitle} width={width} height={3} focused={view.pane === 'input' || view.confirmCancel} lines={[{ text: `› ${input}` }]} noColor={noColor} />
      <Text color={!noColor && state.error ? 'redBright' : undefined}>{fit(state.error ?? warning ?? '', width)}</Text>
      <Text>{fit('↑/↓ select  tab pane  enter open/send  a approve  s send back  p pause/resume', width)}</Text>
      <Text>{fit('c cancel(y/n)  n new  / filter  m mode  PgUp/PgDn scroll  ? help  q quit', width)}</Text>
      <Text dimColor={!noColor}>{fit(usage || `${task ? `Task #${task.id} · round ${task.reviewRound}` : `${tasks.length} tasks`} · ${state.connection}`, width)}</Text>
    </Box>
  );
}
