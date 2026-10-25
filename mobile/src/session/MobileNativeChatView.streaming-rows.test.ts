import { createElement, useMemo } from 'react'
import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import { projectStructuredAgentSessionMessages } from '../../../src/shared/structured-agent-session-message-projection'
import { agentJournalTurnBody } from '../../../src/shared/agent-session-turn-record'
import { foldMobileNativeChatMessages } from './mobile-native-chat-render-data'
import { useMobileNativeChatFoldReuse } from './mobile-native-chat-fold-reuse'
import { useMobileStructuredAgentTurnTiming } from './use-mobile-structured-agent-turn-timing'
import { MobileNativeChatPageList } from './MobileNativeChatPageList'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatView } from './MobileNativeChatView'

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    FlatList: React.forwardRef((props, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollToEnd: vi.fn(), scrollToOffset: vi.fn() }), [])
      return React.createElement('FlatList', props)
    }),
    ScrollView: 'ScrollView',
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: 'Text',
    View: 'View'
  }
})
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('react-native-gesture-handler', () => {
  const chain = { runOnJS: () => chain, onStart: () => chain, onUpdate: () => chain }
  return {
    Gesture: { Simultaneous: () => ({}), Native: () => ({}), Pinch: () => chain },
    GestureDetector: 'GestureDetector',
    GestureHandlerRootView: 'GestureHandlerRootView'
  }
})
vi.mock('lucide-react-native', () => ({
  ArrowDown: 'ArrowDown',
  ChevronsDownUp: 'ChevronsDownUp',
  ChevronsUpDown: 'ChevronsUpDown',
  Square: 'Square'
}))
const rendered = vi.hoisted(() => new Map<string, number>())
vi.mock('./MobileNativeChatMessage', async () => {
  const React = await import('react')
  return {
    MobileNativeChatMessage: React.memo((props: { message: NativeChatMessage }) => {
      rendered.set(props.message.id, (rendered.get(props.message.id) ?? 0) + 1)
      return React.createElement('ChatMessage', props)
    })
  }
})
vi.mock('./MobileNativeChatPromptCard', () => ({ MobileNativeChatPromptCard: 'PromptCard' }))
vi.mock('./MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./MobileNativeChatPermission', () => ({ MobileNativeChatPermission: 'ChatPermission' }))
vi.mock('./MobileNativeChatQuestion', () => ({ MobileNativeChatQuestion: 'ChatQuestion' }))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('./MobileAgentWorkingIndicator', () => ({
  MobileAgentWorkingIndicator: 'WorkingIndicator'
}))
vi.mock('./MobileNativeChatLiveLine', () => ({ MobileNativeChatLiveLine: 'LiveStatus' }))
vi.mock('./MobileNativeChatComposer', () => ({ MobileNativeChatComposer: 'Composer' }))

type ViewProps = Parameters<typeof MobileNativeChatView>[0]
const stable: Pick<
  ViewProps,
  | 'onSend'
  | 'sendSurfaceId'
  | 'getSendCompletionGeneration'
  | 'getComposerEditGeneration'
  | 'composerText'
  | 'onComposerTextChange'
  | 'pending'
  | 'imagePreviewsByMessageId'
> = {
  onSend: async () => true,
  sendSurfaceId: 'perf-chat',
  getSendCompletionGeneration: () => 0,
  getComposerEditGeneration: () => 0,
  composerText: '',
  onComposerTextChange: () => {},
  pending: [
    {
      id: 'pending',
      text: 'follow up',
      images: ['local:pending'],
      sentAt: 10,
      baselineTailMessageId: 'live-user'
    }
  ],
  imagePreviewsByMessageId: { 'user-0': ['local:preview'] }
}

function Harness({
  items,
  corpus = []
}: {
  items: AgentJournalRenderItem[]
  corpus?: NativeChatMessage[]
}) {
  const messages = useMemo(
    () => [...corpus, ...projectStructuredAgentSessionMessages(items, [], [])],
    [items, corpus]
  )
  const folded = useMobileNativeChatFoldReuse(
    useMemo(() => foldMobileNativeChatMessages(messages, 'claude'), [messages]),
    stable.sendSurfaceId
  )
  const timing = useMobileStructuredAgentTurnTiming(
    { items, submissions: [], working: true },
    'live'
  )
  return createElement(MobileNativeChatView, {
    ...stable,
    ...timing,
    messages,
    folded,
    status: 'ready',
    agent: 'claude',
    streaming: null,
    structuredActivityUi: true,
    agentWorking: true
  })
}

function journal(turns: number, text: string): AgentJournalRenderItem[] {
  const items: AgentJournalRenderItem[] = []
  const add = (itemId: string, body: AgentJournalRenderItem['body']) => {
    items.push({
      itemId,
      body,
      revision: 1,
      sequence: items.length + 1,
      observedAt: 1000 + items.length
    })
  }
  for (let i = 0; i < turns; i++) {
    const turnId = `turn-${i}`
    add(`user-${i}`, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'inspect the code' }]
    })
    add(`tool-${i}`, {
      kind: 'message',
      role: 'assistant',
      blocks: [
        { type: 'tool-call', name: 'Read', callId: `call-${i}`, input: { path: 'index.ts' } },
        { type: 'tool-result', callId: `call-${i}`, output: 'contents' }
      ]
    })
    add(`reason-${i}`, {
      kind: 'message',
      role: 'reasoning',
      blocks: [{ type: 'text', text: 'checking' }]
    })
    add(`answer-${i}`, {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'finished' }]
    })
    add(
      `lifecycle-${i}`,
      agentJournalTurnBody({
        turnId,
        userItemId: `user-${i}`,
        state: 'completed',
        startedAt: 1000,
        completedAt: 5000,
        durationMs: 4000
      })
    )
  }
  add('live-user', { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'continue' }] })
  add(
    'live-turn',
    agentJournalTurnBody({
      turnId: 'live',
      userItemId: 'live-user',
      state: 'running',
      startedAt: 6000
    })
  )
  add('live-answer', { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] })
  return items
}

let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  rendered.clear()
})

function measure(turns: number, corpus: NativeChatMessage[] = []) {
  // Retain every loaded row by reaching the page's scroll-driven draw expansion.
  const scroller = {
    scrollTop: 0,
    scrollHeight: 100,
    clientHeight: 100,
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll: () => []
  }
  const items = journal(turns, 'hello')
  act(() => {
    renderer = create(createElement(Harness, { items, corpus }), {
      createNodeMock: (element) =>
        element.type === 'ScrollView'
          ? { getScrollableNode: () => scroller, getInnerViewNode: () => null }
          : null
    })
  })
  expect(renderer!.root.findAllByType(MobileNativeChatPageList)).toHaveLength(1)
  const mounted = renderer!.root.findAll((node) => Object.is(node.type, 'ChatMessage'))
  expect(mounted.length).toBeGreaterThanOrEqual(turns * 4 + corpus.length)
  expect(mounted.some((node) => node.props.workRun?.length > 1)).toBe(true)
  const preview = mounted.find((node) => node.props.message.id === 'user-0')!
  expect(preview.props.message.blocks).toContainEqual({ type: 'image-ref', url: 'local:preview' })
  expect(mounted.some((node) => node.props.message.id === 'pending')).toBe(true)
  const samples: { renders: number; ms: number; ids: string[] }[] = []
  for (let batch = 0; batch < 20; batch++) {
    rendered.clear()
    const updated = items.map((item) =>
      item.itemId === 'live-answer'
        ? {
            ...item,
            revision: batch + 2,
            body: {
              kind: 'message' as const,
              role: 'assistant' as const,
              blocks: [{ type: 'text' as const, text: 'hello' + '.'.repeat(batch + 1) }]
            }
          }
        : item
    )
    const start = performance.now()
    act(() => renderer!.update(createElement(Harness, { items: updated, corpus })))
    samples.push({
      ms: performance.now() - start,
      renders: [...rendered.values()].reduce((sum, n) => sum + n, 0),
      ids: [...rendered.keys()]
    })
  }
  const result = {
    turns,
    rows: mounted.length,
    renders: samples.map((sample) => sample.renders),
    meanMs: samples.reduce((sum, sample) => sum + sample.ms, 0) / samples.length
  }
  console.log('STREAM_PERF', JSON.stringify(result))
  expect(
    samples.every((sample) => sample.ids.length === 1 && sample.ids[0] === 'live-answer')
  ).toBe(true)
  expect(
    renderer!.root
      .findAll((node) => Object.is(node.type, 'ChatMessage'))
      .find((node) => node.props.message.id === 'live-answer')!.props.message.blocks[0].text
  ).toBe('hello' + '.'.repeat(20))
}

it.each([10, 100])('bounds streaming renders at %i settled turns', (turns) => measure(turns))
it.skipIf(!process.env.ORCA_CHAT_PERF_CORPUS)(
  'measures the private real-scale transcript without committing it',
  () => {
    const corpus: NativeChatMessage[] = JSON.parse(
      readFileSync(process.env.ORCA_CHAT_PERF_CORPUS!, 'utf8')
    )
    measure(10, corpus)
  }
)
