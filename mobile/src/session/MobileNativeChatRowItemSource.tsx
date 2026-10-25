import { useMemo, type ReactNode } from 'react'
import { MobileNativeChatItemSourceContext } from './mobile-native-chat-item-read'
import type { MobileNativeChatVisualSource } from './mobile-native-chat-visual-read'
import type { MobileNativeChatMessageDetail } from './use-mobile-native-chat-message-detail'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

export type MobileNativeChatRowItemSource = MobileNativeChatVisualSource & {
  details: {
    id: string
    raw: NativeChatMessage | undefined
    state: ReturnType<MobileNativeChatMessageDetail['state']>
  }[]
}

// Keep item recovery context local to the row, including thoughts folded into its tool run.
export function MobileNativeChatRowItemSource({
  source,
  load,
  children
}: {
  source: MobileNativeChatRowItemSource | null
  load: (id: string) => Promise<void>
  children: ReactNode
}) {
  const value = useMemo(() => {
    if (!source) {
      return null
    }
    const details = new Map(source.details.map((detail) => [detail.id, detail]))
    return {
      client: source.client,
      sessionId: source.sessionId,
      messageDetail: {
        raw: (id: string) => details.get(id)?.raw,
        state: (id: string) => details.get(id)?.state ?? null,
        load
      }
    }
  }, [source, load])
  return (
    <MobileNativeChatItemSourceContext.Provider value={value}>
      {children}
    </MobileNativeChatItemSourceContext.Provider>
  )
}
