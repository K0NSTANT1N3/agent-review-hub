import { useEffect, useReducer, useRef, useState } from 'react';
import { useApp, useInput, usePaste, useWindowSize } from 'ink';
import { executeCommand, shortcut, type Command, type MessageMode } from './actions.js';
import { errorMessage, refreshDetail, refreshDirectives, refreshTask, refreshTeam } from './controller.js';
import type { QuorumApi } from './api-client.js';
import { initialState, reducer, filteredTasks, type State } from './store.js';
import { UiStream, type StreamHandlers } from './ws-stream.js';
import { chatHeight, Screen, selectedTask, taskChatLines, type Pane, type ViewState } from './components/screen.js';
import { editText, emptyEditor } from './text.js';

export interface Stream { start(): void; stop(): void }
export type StreamFactory = (handlers: StreamHandlers) => Stream;
export const initialView: ViewState = { pane: 'chat', agentIndex: 0, filter: '', mode: 'answer', editor: emptyEditor, inputMode: 'message', chatTop: null, help: false, confirmCancel: false, busy: false };

export function App({ client, url, token, warning, createStream, seed, columns, rows, noColor = process.env.NO_COLOR !== undefined }: {
  client: QuorumApi;
  url: string;
  token: string;
  warning?: string;
  createStream?: StreamFactory;
  seed?: State;
  columns?: number;
  rows?: number;
  noColor?: boolean;
}) {
  const [state, dispatch] = useReducer(reducer, seed ?? initialState);
  const [view, setView] = useState<ViewState>(initialView);
  const [tick, setTick] = useState(0);
  const size = useWindowSize();
  const { exit } = useApp();
  const task = selectedTask(state, view);
  const taskId = task?.id;
  const stateRef = useRef(state);
  const selectionRef = useRef(taskId);
  const busy = useRef(false);
  const newTitle = useRef('');
  stateRef.current = state;
  selectionRef.current = taskId;
  const width = columns ?? size.columns;
  const height = rows ?? size.rows;

  useEffect(() => {
    let alive = true;
    let detailTimer: ReturnType<typeof setTimeout> | undefined;
    const safeDispatch: typeof dispatch = (action) => { if (alive) dispatch(action); };
    void refreshTeam(client, safeDispatch, stateRef.current.revision);
    const handlers: StreamHandlers = {
      onEvent: (event) => {
        safeDispatch({ type: 'ui', event });
        const id = selectionRef.current;
        if (id !== undefined && (event.type === 'task.updated' && event.data.id === id || event.type === 'task.event' && event.data.taskId === id)) {
          if (detailTimer !== undefined) clearTimeout(detailTimer);
          detailTimer = setTimeout(() => { void refreshDetail(client, id, safeDispatch); }, 100);
        }
      },
      onConnection: (connection) => {
        safeDispatch({ type: 'connection', connection });
        if (connection === 'connected') {
          void refreshTeam(client, safeDispatch, stateRef.current.revision);
          const ids = Object.values(stateRef.current.data).flatMap((data) => data.human.flatMap((action) => action.directiveId ? [action.directiveId] : []));
          void refreshDirectives(client, ids, safeDispatch);
          const id = selectionRef.current;
          if (id !== undefined) void refreshTask(client, id, safeDispatch, stateRef.current.data[id]?.transcriptSupported, stateRef.current.data[id]?.transcripts);
        }
      },
      onAuthError: (reason) => safeDispatch({ type: 'error', error: `WebSocket authentication failed: ${reason}. Check --token or the CLI config.` }),
    };
    const stream = createStream ? createStream(handlers) : new UiStream(url, token, handlers);
    stream.start();
    return () => { alive = false; if (detailTimer !== undefined) clearTimeout(detailTimer); stream.stop(); };
  }, [client, createStream, url, token]);

  useEffect(() => {
    if (taskId === undefined) return;
    let alive = true;
    void refreshTask(client, taskId, (action) => { if (alive) dispatch(action); }, stateRef.current.data[taskId]?.transcriptSupported, stateRef.current.data[taskId]?.transcripts);
    setView((current) => ({ ...current, taskId, chatTop: null, confirmCancel: false }));
    return () => { alive = false; };
  }, [client, taskId]);

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 120);
    return () => clearInterval(timer);
  }, []);

  async function run(command: Command): Promise<void> {
    if (busy.current) return;
    busy.current = true;
    setView((current) => ({ ...current, busy: true }));
    dispatch({ type: 'error' });
    try {
      await executeCommand(client, command, (action) => {
        dispatch(action);
        if (command.kind === 'create' && action.type === 'tasks') setView((current) => ({ ...current, taskId: action.tasks[0]?.id, filter: '' }));
      });
      setView((current) => ({ ...current, editor: emptyEditor, pane: 'chat', inputMode: 'message', confirmCancel: false }));
      const id = command.kind === 'create' ? selectionRef.current : command.task.id;
      if (id !== undefined) await refreshTask(client, id, dispatch, stateRef.current.data[id]?.transcriptSupported, stateRef.current.data[id]?.transcripts);
      if (command.kind === 'message' && command.mode === 'ask') void refreshTeam(client, dispatch, stateRef.current.revision);
    } catch (error) {
      dispatch({ type: 'error', error: errorMessage(error) });
    } finally {
      busy.current = false;
      setView((current) => ({ ...current, busy: false }));
    }
  }

  function changeMode(): void {
    const modes: MessageMode[] = ['answer', 'send-back', 'ask'];
    setView((current) => ({ ...current, mode: modes[(modes.indexOf(current.mode) + 1) % modes.length]! }));
  }

  usePaste((text) => {
    if (view.pane === 'input' && !busy.current) setView((current) => {
      const editor = editText(current.editor, text, {}, current.inputMode === 'new-title' ? 200 : 20_000);
      return { ...current, editor, ...(current.inputMode === 'filter' ? { filter: editor.value, chatTop: null } : {}) };
    });
  });

  useInput((input, key) => {
    if (input === 'c' && key.ctrl) { exit(); return; }
    if (key.escape) {
      dispatch({ type: 'error' });
      setView((current) => ({ ...current, help: false, confirmCancel: false, pane: current.inputMode === 'filter' ? 'tasks' : 'chat', inputMode: 'message', editor: emptyEditor }));
      return;
    }
    if (view.confirmCancel) {
      if (input.toLowerCase() === 'y' && task) void run({ kind: 'cancel', task });
      else if (input.toLowerCase() === 'n') setView((current) => ({ ...current, confirmCancel: false }));
      return;
    }
    if (key.tab) {
      const panes: Pane[] = ['agents', 'tasks', 'chat', 'input'];
      setView((current) => ({ ...current, pane: panes[(panes.indexOf(current.pane) + (key.shift ? 3 : 1)) % 4]!, inputMode: 'message', help: false }));
      return;
    }
    if (busy.current) return;
    if (view.pane === 'input') {
      if (key.return) {
        const text = view.editor.value.trim();
        if (view.inputMode === 'filter') { setView((current) => ({ ...current, pane: 'tasks', inputMode: 'message', editor: emptyEditor })); return; }
        if (!text) return;
        if (view.inputMode === 'new-title') {
          newTitle.current = text;
          setView((current) => ({ ...current, editor: emptyEditor, inputMode: 'new-description' }));
        } else if (view.inputMode === 'new-description') void run({ kind: 'create', title: newTitle.current, description: text });
        else if (task) void run({ kind: 'message', task, mode: view.mode, text, agentId: state.agents[view.agentIndex]?.id });
        else dispatch({ type: 'error', error: 'Select a task first, or press Esc then n to create one.' });
      } else if (!key.ctrl && !key.meta && !key.upArrow && !key.downArrow) {
        setView((current) => {
          const editor = editText(current.editor, input, key, current.inputMode === 'new-title' ? 200 : 20_000);
          return { ...current, editor, ...(current.inputMode === 'filter' ? { filter: editor.value, chatTop: null } : {}) };
        });
      }
      return;
    }
    if (input === 'q') { exit(); return; }
    if (input === '?') { setView((current) => ({ ...current, help: !current.help })); return; }
    if (view.help) return;
    if (key.pageUp || key.pageDown) {
      const compact = width < 110 || height < 28;
      const chatWidth = compact ? width : width - Math.min(42, Math.floor(width * 0.32));
      const count = taskChatLines(state, view, chatWidth).length;
      const page = chatHeight(state, view, height);
      const end = Math.max(0, count - page);
      setView((current) => {
        const top = key.pageUp ? Math.max(0, (current.chatTop ?? end) - page) : (current.chatTop ?? end) + page;
        return { ...current, pane: 'chat', chatTop: key.pageDown && top >= end ? null : top };
      });
      return;
    }
    if (key.upArrow || key.downArrow) {
      const step = key.upArrow ? -1 : 1;
      if (view.pane === 'agents') setView((current) => ({ ...current, agentIndex: Math.max(0, Math.min(state.agents.length - 1, current.agentIndex + step)) }));
      else {
        const tasks = filteredTasks(state.tasks, view.filter);
        const index = tasks.findIndex((item) => item.id === taskId);
        setView((current) => ({ ...current, taskId: tasks[Math.max(0, Math.min(tasks.length - 1, index + step))]?.id, chatTop: null }));
      }
      return;
    }
    if (key.return || input === 'i') {
      setView((current) => ({ ...current, pane: current.pane === 'tasks' && key.return ? 'chat' : 'input', mode: current.pane === 'agents' && key.return ? 'ask' : current.mode, inputMode: 'message', editor: emptyEditor }));
      return;
    }
    if (input === 'm') { changeMode(); return; }
    if (input === '/') { setView((current) => ({ ...current, pane: 'input', inputMode: 'filter', editor: { value: current.filter, cursor: [...current.filter].length } })); return; }
    const action = shortcut(input);
    if (action === 'create') { setView((current) => ({ ...current, pane: 'input', inputMode: 'new-title', editor: emptyEditor })); return; }
    if (!task) return;
    if (action === 'cancel') setView((current) => ({ ...current, confirmCancel: true }));
    else if (action === 'send-back') setView((current) => ({ ...current, pane: 'input', mode: 'send-back', inputMode: 'message', editor: emptyEditor }));
    else if (action) void run({ kind: action, task });
  });

  return <Screen state={state} view={view} columns={width} rows={height} team={new URL(url).host} warning={warning} tick={tick} noColor={noColor} />;
}
