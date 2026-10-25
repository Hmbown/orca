import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  buildMobileNativeChatTransientData,
  foldMobileNativeChatMessages
} from './mobile-native-chat-render-data'
import { projectMobileNativeChatRows } from './mobile-native-chat-row-projection'
import {
  useMobileNativeChatRowProps,
  type MobileNativeChatRowLookups
} from './use-mobile-native-chat-row-props'
import type { MobileNativeChatTurnRow } from './use-mobile-native-chat-turn-disclosure'

function message(id: string, text = id): NativeChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text }], timestamp: 1, source: 'transcript' }
}

const turn: MobileNativeChatTurnRow = {
  turnStatus: null,
  turnExpanded: false,
  activeTurnIsWorking: false,
  trailingRun: false,
  userMessageOpen: false,
  onToggleUserMessage: () => {},
  mayStillGrow: false,
  reasoningIsLive: false,
  reasoningExpanded: false,
  onToggleReasoning: () => {},
  onToggleSubagentGroup: () => {}
}
const lookups: MobileNativeChatRowLookups = {
  resolveTurnRow: () => turn,
  rowKeyOf: (row) => row.id,
  runOwners: new Map(),
  taskListPredecessors: new Map(),
  unsentNotices: new Map(),
  receipts: null,
  actionablePromptIds: undefined
}

it('reuses rebuilt settled status, work runs, previews and pending echoes together', () => {
  const source = [
    message('image'),
    {
      ...message('tool'),
      role: 'assistant' as const,
      blocks: [{ type: 'tool-call' as const, name: 'Read', input: { path: 'a.ts' } }]
    }
  ]
  const batch = (preview = 'local:photo', pending = 'next', seconds = 4, run = source) => {
    const data = buildMobileNativeChatTransientData({
      messages: source,
      folded: foldMobileNativeChatMessages(source, 'claude'),
      streaming: null,
      imagePreviewsByMessageId: { image: [preview] },
      pending: [{ id: 'pending', text: pending }]
    }).data
    return data.map((row) => ({
      message: row,
      turnStatus: { workedSeconds: seconds },
      workRun: [...run]
    }))
  }
  const before = projectMobileNativeChatRows(batch())
  expect(projectMobileNativeChatRows(batch(), before)).toBe(before)
  expect(projectMobileNativeChatRows(batch('local:changed'), before).byId.get('image')).not.toBe(
    before.byId.get('image')
  )
  expect(
    projectMobileNativeChatRows(batch('local:photo', 'edited'), before).byId.get('pending')
  ).not.toBe(before.byId.get('pending'))
  expect(
    projectMobileNativeChatRows(batch('local:photo', 'next', 9), before).rows[0]?.turnStatus
      .workedSeconds
  ).toBe(9)
  const changedRun = [...source, message('new-tool')]
  expect(
    projectMobileNativeChatRows(batch('local:photo', 'next', 4, changedRun), before).rows[0]
      ?.workRun
  ).toEqual(changedRun)
  const changedContent = [
    source[0]!,
    { ...source[1]!, blocks: [{ type: 'text' as const, text: 'new output' }] }
  ]
  expect(
    projectMobileNativeChatRows(batch('local:photo', 'next', 4, changedContent), before).rows[0]
      ?.workRun
  ).toEqual(changedContent)
})

it('retains order and drops removed ids instead of reviving old rows', () => {
  const a = { message: message('a') },
    b = { message: message('b') }
  const before = projectMobileNativeChatRows([a, b])
  const reordered = projectMobileNativeChatRows(
    [{ message: message('b') }, { message: message('a') }],
    before
  )
  expect(reordered.rows).toEqual([b, a])
  expect(reordered.rows[0]).toBe(b)
  const removed = projectMobileNativeChatRows([b], reordered)
  expect(removed.byId.has('a')).toBe(false)
  expect(projectMobileNativeChatRows([{ message: message('a') }, b], removed).rows[0]).not.toBe(a)
})

it('does not hide changed disclosure sets, callbacks, nested inputs or message metadata', () => {
  const row = { message: message('a'), open: new Set<string>(), onToggle: () => {} }
  const before = projectMobileNativeChatRows([row])
  for (const changed of [
    { ...row, open: new Set(['group']) },
    { ...row, onToggle: () => {} },
    { ...row, message: { ...row.message, unsent: true as const } },
    {
      ...row,
      message: {
        ...row.message,
        blocks: [{ type: 'tool-call' as const, name: 'Read', input: { path: 'changed' } }]
      }
    }
  ]) {
    expect(projectMobileNativeChatRows([changed], before).rows[0]).toBe(changed)
  }
})

let renderer: ReactTestRenderer | null = null
let projection: ReturnType<typeof useMobileNativeChatRowProps>
function Harness({
  scope,
  rows,
  props = lookups
}: {
  scope: string
  rows: NativeChatMessage[]
  props?: MobileNativeChatRowLookups
}) {
  projection = useMobileNativeChatRowProps(rows, props, scope)
  return null
}
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})
function show(scope: string, rows: NativeChatMessage[], props = lookups) {
  act(() => {
    const element = createElement(Harness, { scope, rows, props })
    if (renderer) {
      renderer.update(element)
    } else {
      renderer = create(element)
    }
  })
}

it('isolates chats with the same ids and applies changed row lookups', () => {
  const rows = [{ ...message('a'), unsent: true as const }, message('b')]
  show('chat-a', rows)
  const before = projection
  show(
    'chat-a',
    rows.map((row) => ({ ...row }))
  )
  expect(projection).toBe(before)
  show('chat-a', rows, {
    ...lookups,
    unsentNotices: new Map([['a', 'Not sent']]),
    runOwners: new Map([['b', 'a']]),
    actionablePromptIds: ['b']
  })
  expect(projection.rows[0]?.unsentNotice).toBe('Not sent')
  expect(projection.rows[1]).toMatchObject({ runOwner: 'a', awaiting: true })
  show('chat-b', rows)
  expect(projection.rows[0]).not.toBe(before.rows[0])
  expect(projection.rows[0]?.unsentNotice).toBeUndefined()
})
