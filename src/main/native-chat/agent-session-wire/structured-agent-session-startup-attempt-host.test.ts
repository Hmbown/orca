import { describe, expect, it, vi } from 'vitest'
import { AgentSessionAcquisitionRefusal } from './structured-agent-session-adapter'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { DISPATCH_REJECTED_CANCELLED } from '../../../shared/structured-agent-session-dispatch-rejection'
import { NATIVE_CHAT_STOPPED_BEFORE_START_TEXT } from '../../../shared/native-chat-stopped-before-start'
import { projectStructuredAgentSessionMessages } from '../../../shared/structured-agent-session-message-projection'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'
import {
  HOST_STOPPED,
  accept,
  acquire,
  acquisition,
  closeSession,
  dispatch,
  eventually,
  heldBehindStart,
  host,
  proveOpen,
  providerStarted,
  publishFirst,
  recordLiveListing,
  registerStartupAttemptHostTests,
  restartWith,
  setStartupLimits,
  startupAttemptOpen,
  stop,
  store,
  submission
} from './structured-agent-session-startup-attempt-host-test-support'

registerStartupAttemptHostTests()

describe('a send while the agent starts', () => {
  it('keeps a spawned child unopened until required protocol open proves readiness', async () => {
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello')

    expect(await submission(id)).toMatchObject({ dispatchState: 'pending' })
    expect((await submission(id))?.handedOverAt).toBeUndefined()
    expect(dispatch).not.toHaveBeenCalled()

    await proveOpen()

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('hands every message held behind the start over, in order, once', async () => {
    await restartWith(publishFirst)
    const first = await heldBehindStart('first')
    const second = await accept('second')
    await accept('first', first)

    await proveOpen()

    await eventually(async () => expect((await submission(second))?.dispatchState).toBe('accepted'))
    expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([first, second])
  })

  it('tells the model catalog once the start proves itself, never for a child it no longer holds', async () => {
    await restartWith(publishFirst)
    providerStarted.mockClear()
    const id = await heldBehindStart('hello')
    expect(providerStarted).not.toHaveBeenCalled()

    await proveOpen()
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
    expect(providerStarted).toHaveBeenCalledTimes(1)
    expect(providerStarted.mock.calls[0]?.[0]).toMatchObject({ sessionId: SESSION })
  })
})

it.each([false, true])(
  'keeps current-generation reports across readiness (replaced=%s)',
  async (replaced) => {
    await store.replaceSessionOptions({
      sessionId: SESSION,
      fence: store.getRecord(SESSION)!.lease.runtimeFence,
      permissionMode: 'own',
      now: NOW
    })
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello')
    const fence = store.getRecord(SESSION)!.lease.runtimeFence
    const acquisitionGeneration = `generation-${acquire.mock.calls.length}`
    const report = (
      reportedOptions: { reportedPermissionMode?: string | null },
      generation = acquisitionGeneration,
      reportFence = fence
    ) =>
      host.handleAdapterEvent({
        type: 'options-reported',
        sessionId: SESSION,
        fence: reportFence,
        acquisitionGeneration: generation,
        reportedOptions
      })
    const early = report({ reportedPermissionMode: 'accept-edits' })
    expect(host.readStatusSummary(SESSION)?.runtimePermission).toBeNull()
    if (replaced) {
      await host.close(SESSION, 'evict')
      await early
      await proveOpen()
      await host.flushStreamedEvents(SESSION)
      expect(host.readStatusSummary(SESSION)?.runtimePermission).toBeNull()
      return
    }
    await proveOpen()
    await early
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
    const current = () => host.readStatusSummary(SESSION)?.runtimePermission
    expect(current()).toEqual({ fence, mode: 'accept-edits' })
    await report({ reportedPermissionMode: 'full-access' }, 'foreign')
    await report({ reportedPermissionMode: 'full-access' }, acquisitionGeneration, fence + 1)
    await report({})
    expect(current()).toEqual({ fence, mode: 'accept-edits' })
    await report({ reportedPermissionMode: null })
    expect(current()).toEqual({ fence, mode: null })
    expect(store.getRecord(SESSION)?.permissionMode).toBe('own')
    expect(dispatch).toHaveBeenCalledTimes(1)
    await host.close(SESSION, 'evict')
    expect(current()).toBeNull()
  }
)

describe('a start that ends before it proves itself', () => {
  it.each([false, true])(
    'settles only its own message after startup failure (acquisition refusal: %s)',
    async (refused) => {
      await restartWith(publishFirst)
      const id = await heldBehindStart('hello')
      let later: string | undefined

      const physicalAttempts = refused ? 1 : 5
      for (let attempt = 1; attempt <= physicalAttempts; attempt++) {
        await eventually(() => expect(acquire).toHaveBeenCalledTimes(attempt))
        await eventually(() =>
          expect(host.collaboratorsForTests().sessions.get(SESSION)?.child).toBeTruthy()
        )
        if (attempt === physicalAttempts) {
          later = await accept('a later message')
          if (refused) {
            acquire.mockRejectedValueOnce(
              new AgentSessionAcquisitionRefusal('sign in', 'notSignedIn')
            )
          }
        }
        await host.handleAdapterEvent({
          type: 'ended',
          sessionId: SESSION,
          fence: store.getRecord(SESSION)!.lease.runtimeFence,
          acquisitionGeneration: `generation-${acquire.mock.calls.length}`,
          reason: 'exited with code 1',
          cause: 'unexpected-exit'
        })
      }

      await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
      expect(await submission(id)).toMatchObject(
        agentSessionFailureWords(
          agentSessionFailureFact(refused ? 'notSignedIn' : 'providerStartFailed'),
          { agentName: 'Codex', surface: 'rejection' }
        )
      )
      expect((await submission(id))?.handedOverAt).toBeUndefined()
      expect(dispatch).not.toHaveBeenCalled()
      await eventually(() => expect(acquire).toHaveBeenCalledTimes(refused ? 3 : 6))
      await proveOpen()
      await eventually(async () =>
        expect((await submission(later!))?.dispatchState).toBe('accepted')
      )
      expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([later])
      expect(startupAttemptOpen()).toBe(false)
    }
  )

  it('withdraws what it held on a Stop, without waiting on the handshake', async () => {
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello')

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })

    expect(await submission(id)).toMatchObject({
      dispatchState: 'rejected',
      reason: DISPATCH_REJECTED_CANCELLED
    })
    expect((await submission(id))?.handedOverAt).toBeUndefined()
    expect(closeSession).toHaveBeenCalled()
    // The taken-back send carries its stopped result, and the accepted Stop its one request row.
    const snapshot = await host.journalSnapshot(SESSION)
    expect(
      projectStructuredAgentSessionMessages(snapshot.items, [], snapshot.submissions)
    ).toMatchObject([
      { role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      { blocks: [{ type: 'text', text: NATIVE_CHAT_STOPPED_BEFORE_START_TEXT }] },
      { blocks: [{ type: 'text', text: 'Cancellation requested.' }] }
    ])
    expect(dispatch).not.toHaveBeenCalled()
    expect(startupAttemptOpen()).toBe(false)
  })

  it('keeps what it held for the chat on a close, without waiting on the handshake', async () => {
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello')

    await host.close(SESSION, 'user-close')

    await host.revealSession(SESSION)
    expect(await submission(id)).toMatchObject({
      dispatchState: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('chatClosed'), { surface: 'rejection' })
    })
    expect((await submission(id))?.handedOverAt).toBeUndefined()
    expect(dispatch).not.toHaveBeenCalled()
    expect(startupAttemptOpen()).toBe(false)
  })

  it('stops a published start that never readies at the ceiling, not before, and fails what it held', async () => {
    setStartupLimits({ ceilingMs: 400 })
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello')
    await vi.advanceTimersByTimeAsync(200)
    expect(closeSession).not.toHaveBeenCalled()
    expect(startupAttemptOpen()).toBe(true)

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'), 50)
    expect(await submission(id)).toMatchObject(HOST_STOPPED)
    expect((await submission(id))?.handedOverAt).toBeUndefined()
    expect(closeSession).toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(startupAttemptOpen()).toBe(false)
  })

  it('aborts an acquire still in its handshake at the ceiling and fails what it held', async () => {
    setStartupLimits({ ceilingMs: 50 })
    await restartWith(
      (input) =>
        new Promise((_resolve, reject) => {
          void input.onSpawned?.(acquisition(input).process)
          input.signal?.addEventListener('abort', () => reject(input.signal?.reason))
        })
    )
    const id = await accept('hello')

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'), 50)
    expect(await submission(id)).toMatchObject(HOST_STOPPED)
    expect(dispatch).not.toHaveBeenCalled()
    await eventually(() => expect(startupAttemptOpen()).toBe(false))
  })

  it('ends a start whose acquire is still running when the chat closes', async () => {
    let land = (): void => {}
    const landed = new Promise<void>((resolve) => {
      land = resolve
    })
    await restartWith(async (input) => {
      await landed
      return acquisition(input)
    })
    const id = await accept('hello')
    await eventually(() => expect(acquire).toHaveBeenCalled())

    const closing = host.close(SESSION, 'evict')
    land()
    await expect(closing).resolves.toBeUndefined()

    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
    expect((await submission(id))?.rejection).toMatchObject({ kind: 'chatClosed' })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('is not ended by the limit once it proved itself', async () => {
    setStartupLimits({ ceilingMs: 50 })
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello')
    await proveOpen()
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))

    await vi.advanceTimersByTimeAsync(100)

    expect(closeSession).not.toHaveBeenCalled()
    expect((await host.readStatusSummary(SESSION))?.hostExecutionPhase).toBe('ready')
    expect(startupAttemptOpen()).toBe(false)
  })
})

describe('what a started child reports', () => {
  it('keeps provider reports out of the saved next-message choice', async () => {
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello')
    await proveOpen('reported')
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
    await host.handleAdapterEvent({
      type: 'options-reported',
      sessionId: SESSION,
      fence: store.getRecord(SESSION)!.lease.runtimeFence,
      acquisitionGeneration: `generation-${acquire.mock.calls.length}`,
      reportedOptions: { model: 'from-settings' }
    })
    await host.flushStreamedEvents(SESSION)
    expect(store.getRecord(SESSION)?.options).toBeUndefined()
  })

  it('preserves a later accepted pick when an older child reports options', async () => {
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello')
    await store.replaceSessionOptions({
      sessionId: SESSION,
      fence: store.getRecord(SESSION)!.lease.runtimeFence,
      options: { model: 'picked' },
      now: NOW
    })
    await proveOpen('reported')
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
    await host.handleAdapterEvent({
      type: 'options-reported',
      sessionId: SESSION,
      fence: store.getRecord(SESSION)!.lease.runtimeFence,
      acquisitionGeneration: `generation-${acquire.mock.calls.length}`,
      reportedOptions: { model: 'from-settings' }
    })
    await host.flushStreamedEvents(SESSION)
    expect(store.getRecord(SESSION)?.options).toEqual({ model: 'picked' })
  })

  it('saves a settings readback that arrives before open proves the start', async () => {
    await restartWith(publishFirst)
    await heldBehindStart('hello')
    const listing = { models: [], configuredDefault: { modelId: 'opus' } }
    const reported = host.handleAdapterEvent({
      type: 'options-reported',
      sessionId: SESSION,
      fence: store.getRecord(SESSION)!.lease.runtimeFence,
      acquisitionGeneration: `generation-${acquire.mock.calls.length}`,
      reportedOptions: { model: 'opus' },
      catalogListing: listing
    })
    await proveOpen()
    await reported

    await eventually(() => expect(recordLiveListing).toHaveBeenCalledWith(SESSION, listing))
  })
})

describe('the attempt an acquire runs under', () => {
  it('is minted by the host with the lease and the pinned launch', async () => {
    await restartWith(publishFirst)
    await heldBehindStart('hello')

    const record = store.getRecord(SESSION)!
    const [input] = acquire.mock.calls.at(-1)!
    expect(input).toMatchObject({
      fence: record.lease.runtimeFence,
      launch: { location: record.location, accountHome: record.accountHome }
    })
    expect(input.attemptId).toEqual(expect.any(String))
    expect(input.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('a chat after startup permission backfill', () => {
  it.each(['ask', 'full-access'] as const)(
    'keeps %s before and after the first start, regardless of later Arguments',
    async (mode) => {
      await host.close(SESSION, 'evict')
      await store.backfillChatPermissionModes(() => mode === 'full-access')
      expect((await host.readOptions(SESSION)).current.permissionMode).toBe(mode)
      await store.backfillChatPermissionModes(() => mode === 'ask')
      await restartWith(publishFirst)
      await heldBehindStart('hello')
      expect(acquire.mock.calls.at(-1)![0].permissionMode).toBe(mode)
      await proveOpen()
      await vi.advanceTimersByTimeAsync(50)
      await host.flushStreamedEvents(SESSION)
      expect(store.getRecord(SESSION)?.permissionMode).toBe(mode)
      await store.backfillChatPermissionModes(() => mode === 'ask')
      expect(store.getRecord(SESSION)?.permissionMode).toBe(mode)
    }
  )
})
