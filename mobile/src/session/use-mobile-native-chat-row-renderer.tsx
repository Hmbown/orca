import { useCallback, useContext, useLayoutEffect, useMemo } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { NativeChatTurnJournal } from '../../../src/shared/native-chat-turn-membership'
import type { NativeChatTaskListPredecessors } from '../../../src/shared/native-chat-task-list-history'
import type { NativeChatResolvedPrompt } from '../../../src/shared/native-chat-resolution-receipt'
import { MobileNativeChatItemSourceContext } from './mobile-native-chat-item-read'
import { MobileNativeChatRowItemSource } from './MobileNativeChatRowItemSource'
import { useMobileNativeChatRowProps } from './use-mobile-native-chat-row-props'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import { mobileNativeChatUnsentNotices } from './mobile-native-chat-unsent-notices'
import type { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'

export function useMobileNativeChatRowRenderer({
  scope,
  rowKeyOf,
  runOwners,
  taskListPredecessors,
  fontScale,
  onOpenFile,
  structuredActivityUi,
  turns,
  turnJournal,
  agent,
  receipts,
  actionablePromptIds
}: {
  scope: string
  rowKeyOf: (message: NativeChatMessage) => string
  runOwners: ReadonlyMap<string, string>
  /** The last plan each task-list tool wrote before each row, by row id. */
  taskListPredecessors: ReadonlyMap<string, NativeChatTaskListPredecessors>
  fontScale: number
  onOpenFile?: (relativePath: string) => void
  structuredActivityUi: boolean
  turns: ReturnType<typeof useMobileNativeChatTurnDisclosure>
  turnJournal: NativeChatTurnJournal | null
  agent: string | null | undefined
  receipts: ReadonlyMap<string, NativeChatResolvedPrompt> | null
  actionablePromptIds: readonly string[] | undefined
}): ({ item, index }: { item: NativeChatMessage; index: number }) => React.JSX.Element {
  const itemSource = useContext(MobileNativeChatItemSourceContext)
  const committedSource = useMemo(
    () => ({ current: itemSource }),
    [itemSource?.client, itemSource?.sessionId]
  )
  useLayoutEffect(() => {
    committedSource.current = itemSource
  }, [committedSource, itemSource])
  const load = useCallback(
    async (id: string) => {
      const detail = committedSource.current?.messageDetail
      if (!detail) {
        throw new Error('Message unavailable')
      }
      await detail.load(id)
    },
    [committedSource]
  )
  const unsentNotices = useMemo(
    () => mobileNativeChatUnsentNotices(turnJournal, agent),
    [turnJournal, agent]
  )
  const { listMessages, waitingRows, resolveRow: resolveTurnRow, onToggleTurn } = turns
  const messages = useMemo(
    () => [...listMessages, ...waitingRows.map(({ item }) => item)],
    [listMessages, waitingRows]
  )
  const lookups = useMemo(
    () => ({
      itemSource,
      rowKeyOf,
      runOwners,
      taskListPredecessors,
      unsentNotices,
      receipts,
      actionablePromptIds,
      resolveTurnRow
    }),
    [
      itemSource,
      rowKeyOf,
      runOwners,
      taskListPredecessors,
      unsentNotices,
      receipts,
      actionablePromptIds,
      resolveTurnRow
    ]
  )
  const { byId } = useMobileNativeChatRowProps(messages, lookups, scope)
  return useCallback(
    ({ item }) => {
      const { itemSource: source, ...rowProps } = byId.get(item.id)!
      return (
        <MobileNativeChatRowItemSource source={source} load={load}>
          <MobileNativeChatMessage
            {...rowProps}
            fontScale={fontScale}
            onOpenFile={onOpenFile}
            structuredActivityUi={structuredActivityUi}
            onToggleTurn={onToggleTurn}
          />
        </MobileNativeChatRowItemSource>
      )
    },
    [byId, load, fontScale, onOpenFile, structuredActivityUi, onToggleTurn]
  )
}
