import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexAppServerRequestError } from '../../codex/app-server/codex-app-server-request-error'
import { withProviderRequestTimeout } from '../../provider-process/provider-request-timeout'
import { AgentSessionAcquisitionRefusal } from './structured-agent-session-adapter'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  CALLER,
  HOST_STOPPED,
  accept,
  acquire,
  closeSession,
  dispatch,
  eventually,
  heldBehindStart,
  host,
  proveOpen,
  publishFirst,
  registerStartupAttemptHostTests,
  restartWith,
  setStartupLimits,
  setSupportsGoals,
  stop,
  submission
} from './structured-agent-session-startup-attempt-host-test-support'

registerStartupAttemptHostTests()

describe('one logical start across physical attempts', () => {
  beforeEach(() => {
    setSupportsGoals(true)
  })
  async function endAttempt() {
    const session = host.collaboratorsForTests().sessions.get(SESSION)!
    const child = session.child!
    if (child.generation === null) {
      throw new Error('expected a published child generation')
    }
    const event = {
      type: 'ended' as const,
      sessionId: SESSION,
      fence: child.fence,
      acquisitionGeneration: child.generation,
      reason: 'exited while starting',
      cause: 'unexpected-exit' as const
    }
    await host.handleAdapterEvent(event)
    await eventually(() => expect(session.child).toBeNull())
    return event
  }

  function goal() {
    const change = { kind: 'set' as const, objective: 'finish startup' }
    return host.changeThreadGoal(CALLER, {
      envelope: {
        sessionId: SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: null,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.threadGoal',
          sessionId: SESSION,
          fields: { change }
        })
      },
      change
    })
  }

  it('holds both sends and a joining operation across retry without status or transcript churn', async () => {
    await restartWith(publishFirst)
    const phases: (string | undefined)[] = []
    host.subscribeStatus({
      id: 'retry-observer',
      emit: (event) => {
        if (event.type === 'status') {
          phases.push(event.session.hostExecutionPhase)
        }
      }
    })
    const ran = vi.fn<NonNullable<StructuredAgentSessionAdapter['changeThreadGoal']>>(async () => ({
      ok: true as const
    }))
    host.deps.adapter.changeThreadGoal = ran
    const artifacts: unknown[] = []
    await host.subscribe({
      id: 'retry-transcript',
      sessionId: SESSION,
      emit: (frame) => {
        if (frame.type === 'batch') {
          artifacts.push(...frame.batch.items.filter((item) => item.body.kind === 'status'))
        }
      }
    })
    const first = await heldBehindStart('first')
    phases.length = 0
    const operation = goal()
    const stale = await endAttempt()
    const second = await accept('second')
    expect(await submission(first)).toMatchObject({ dispatchState: 'pending' })
    expect((await host.readStatusSummary(SESSION))?.hostExecutionPhase).toBe('starting')
    const reconnect: (string | undefined)[] = []
    host.subscribeStatus({
      id: 'during-backoff',
      emit: (event) => {
        if (event.type === 'snapshot') {
          reconnect.push(...event.sessions.map((row) => row.hostExecutionPhase))
        }
      }
    })
    expect(reconnect).toContain('starting')
    const during = await host.journalSnapshot(SESSION)
    expect(during.items.filter((item) => item.body.kind === 'status')).toEqual([])
    expect(
      host.collaboratorsForTests().sessions.get(SESSION)?.journal.stopMarks.latest()
    ).toBeNull()
    await eventually(() => expect(acquire).toHaveBeenCalledTimes(2))
    await proveOpen()
    await host.handleAdapterEvent(stale)
    await eventually(async () => expect((await submission(second))?.dispatchState).toBe('accepted'))
    expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([first, second])
    expect(phases.filter((phase) => phase !== 'starting' && phase !== 'ready')).toEqual([])
    expect(artifacts).toEqual([])
    expect((await host.readStatusSummary(SESSION))?.hostExecutionPhase).toBe('ready')
    expect(await operation).toMatchObject({ ok: true })
    expect(ran).toHaveBeenCalledTimes(1)
    expect(ran.mock.calls[0]?.[0]).toMatchObject({
      fence: host.collaboratorsForTests().sessions.get(SESSION)?.child?.fence
    })
    expect(acquire).toHaveBeenCalledTimes(2)
  })

  it('keeps a typed refusal or an unproven close final without respawning', async () => {
    await restartWith(async () => {
      throw new AgentSessionAcquisitionRefusal('sign in', 'notSignedIn')
    })
    const first = await accept('needs login')
    await eventually(async () => expect((await submission(first))?.dispatchState).toBe('rejected'))
    expect(acquire).toHaveBeenCalledTimes(1)
    acquire.mockClear()
    await restartWith(publishFirst)
    closeSession.mockResolvedValue(false)
    const second = await heldBehindStart('unproven process')
    const child = host.collaboratorsForTests().sessions.get(SESSION)!.child!
    const { lifetime } = host.collaboratorsForTests()
    await expect(
      lifetime.failStartingChild(
        SESSION,
        child,
        new CodexAppServerRequestError('thread/start', -1, 'refused'),
        1
      )
    ).rejects.toThrow('eviction failed')
    await eventually(async () => expect((await submission(second))?.dispatchState).toBe('rejected'))
    expect(host.collaboratorsForTests().sessions.get(SESSION)?.child).toBe(child)
    expect(acquire).toHaveBeenCalledTimes(1)
    closeSession.mockResolvedValue(true)
  })

  it('keeps a starting child journal sink fault final for its requester without respawning', async () => {
    await restartWith(publishFirst)
    const first = await heldBehindStart('journal fails while starting')
    const { sessions, runtimeState } = host.collaboratorsForTests()
    const session = sessions.get(SESSION)!
    const sink = runtimeState.currentEventSink(SESSION)!
    const writes = vi.spyOn(session.journal, 'appendLifecycleBatch')
    vi.spyOn(session.journal, 'appendItem').mockRejectedValueOnce(new Error('journal unavailable'))
    sink.sink.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-starting', ordinal: 1 },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'starting' }] },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await eventually(async () => expect((await submission(first))?.dispatchState).toBe('rejected'))
    expect(session.lastEndedChild).toMatchObject({
      cause: 'exit',
      duringStartup: true,
      rootGone: true,
      failure: { kind: 'hostFault' }
    })
    const failures = writes.mock.calls.filter(([input]) =>
      input.settlementId.startsWith('start-failure:')
    )
    expect(failures).toHaveLength(1)
    expect(failures[0]![0].dispatches).toEqual([
      expect.objectContaining({
        clientMessageId: first,
        state: 'rejected',
        rejection: { kind: 'hostFault' }
      })
    ])
    const snapshot = await host.journalSnapshot(SESSION)
    expect(snapshot.items.filter((item) => item.body.kind === 'status')).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ failure: { kind: 'hostFault' } }) })
    ])
    expect(closeSession).toHaveBeenCalledTimes(1)
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('ends a backoff on Stop and keeps the original ceiling across attempts', async () => {
    setStartupLimits({ ceilingMs: 1000 })
    await restartWith(publishFirst)
    const first = await heldBehindStart('stop in backoff')
    await endAttempt()
    expect(await stop()).toMatchObject({ ok: true })
    await vi.advanceTimersByTimeAsync(500)
    expect(acquire).toHaveBeenCalledTimes(1)
    expect((await host.readStatusSummary(SESSION))?.hostExecutionPhase).toBeUndefined()
    expect(await submission(first)).toMatchObject({ dispatchState: 'rejected' })
    acquire.mockClear()
    const second = await heldBehindStart('one clock')
    await vi.advanceTimersByTimeAsync(400)
    await endAttempt()
    await eventually(() => expect(acquire).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(500)
    await eventually(
      async () => expect((await submission(second))?.dispatchState).toBe('rejected'),
      50
    )
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(await submission(second)).toMatchObject(HOST_STOPPED)
  })

  it('keeps an elapsed provider-step deadline final and preserves its words', async () => {
    await restartWith(publishFirst)
    const first = await heldBehindStart('initialize deadline')
    const { sessions, lifetime } = host.collaboratorsForTests()
    const requestTimeout = { method: 'initialize', timeoutMs: 60_000 }
    await vi.advanceTimersByTimeAsync(60_000)
    await lifetime.failStartingChild(
      SESSION,
      sessions.get(SESSION)!.child!,
      withProviderRequestTimeout(
        new CodexAppServerRequestError('initialize', -1, 'deadline'),
        requestTimeout
      ),
      60_000
    )
    await eventually(async () => expect((await submission(first))?.dispatchState).toBe('rejected'))
    expect(await submission(first)).toMatchObject(
      agentSessionFailureWords(agentSessionFailureFact('startFailed', { requestTimeout }), {
        agentName: 'Codex',
        surface: 'rejection'
      })
    )
    expect(acquire).toHaveBeenCalledTimes(1)
  })

  it('delivers a later message after a delivery step throws', async () => {
    await restartWith(publishFirst)
    const first = await heldBehindStart('failed preparation')
    vi.spyOn(
      host.collaboratorsForTests().runtimeState.deliveryOrder,
      'beforeSend'
    ).mockImplementationOnce(() => {
      throw new Error('delivery preparation failed')
    })
    await proveOpen()
    await eventually(async () => expect((await submission(first))?.dispatchState).toBe('rejected'))
    const later = await accept('after preparation failed')
    await eventually(async () => expect((await submission(later))?.dispatchState).toBe('accepted'))
    expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual([later])
  })

  it.each([
    { joins: false, failsWrite: false },
    { joins: true, failsWrite: false },
    { joins: true, failsWrite: true }
  ])(
    'settles an operation start without rejecting a later message (joins: $joins, write fails: $failsWrite)',
    async ({ joins, failsWrite }) => {
      await restartWith(publishFirst)
      host.deps.adapter.changeThreadGoal = vi.fn(async () => ({ ok: true as const }))
      const operation = goal()
      let later: string | undefined
      let restoreWrite: (() => void) | undefined
      for (let number = 1; number <= 5; number++) {
        await eventually(() => expect(acquire).toHaveBeenCalledTimes(number))
        await eventually(() =>
          expect(host.collaboratorsForTests().sessions.get(SESSION)?.child).toBeTruthy()
        )
        if (number === 5 && failsWrite) {
          const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
          const append = journal.appendLifecycleBatch.bind(journal)
          const write = vi.spyOn(journal, 'appendLifecycleBatch').mockImplementation((input) => {
            if (input.settlementId.startsWith('start-failure:')) {
              return Promise.reject(new Error('failure write unavailable'))
            }
            return append(input)
          })
          restoreWrite = () => write.mockRestore()
        }
        await endAttempt()
        if (number === 1 && joins) {
          later = await accept('my own start')
        }
      }
      expect(await operation).toMatchObject({ ok: false })
      const snapshot = await host.journalSnapshot(SESSION)
      expect(
        snapshot.items.filter((item) => item.body.kind === 'status' && item.body.tone === 'error')
      ).toHaveLength(failsWrite ? 0 : 1)
      if (later) {
        const expectedMessages = [later]
        expect(await submission(later)).toMatchObject({ dispatchState: 'pending' })
        if (failsWrite) {
          await eventually(() =>
            expect(host.collaboratorsForTests().conversationDelivery.loop.isRunning(SESSION)).toBe(
              false
            )
          )
          expect(await submission(later)).toMatchObject({ dispatchState: 'pending' })
          restoreWrite?.()
          expectedMessages.push(await accept('after the journal recovered'))
        }
        await eventually(() => expect(acquire).toHaveBeenCalledTimes(6))
        await proveOpen()
        await eventually(async () =>
          expect((await submission(later))?.dispatchState).toBe('accepted')
        )
        await eventually(() =>
          expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toEqual(
            expectedMessages
          )
        )
      }
    }
  )
})
