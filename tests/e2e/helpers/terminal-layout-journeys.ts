/** Terminal layout journeys shared by the layout parity scenarios and the layout oracle. */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import {
  countVisibleTerminalPanes,
  focusActiveTerminalInput,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './terminal'
import { ensureTerminalVisible, waitForSessionReady } from './store'
import { SORTABLE_TAB } from './terminal-tab-menu'

export type FolderWorkspaceSetup = {
  worktreeId: string
  pathLabels: Record<string, string>
  cleanup: () => void
}

/** Human pacing: the next gesture waits until every pane of the active tab has a bound PTY. */
export async function waitForBoundPanes(page: Page, count: number): Promise<void> {
  await waitForPaneCount(page, count, 30_000)
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const state = window.__store!.getState()
          const manager = state.activeTabId ? window.__paneManagers?.get(state.activeTabId) : null
          const bound = state.activeTabId
            ? state.terminalLayoutsByTabId[state.activeTabId]?.ptyIdsByLeafId
            : undefined
          return (manager?.getPanes() ?? []).every((pane) => {
            const leafId = manager!.getLeafId(pane.id)
            return leafId !== null && Boolean(bound?.[leafId])
          })
        }),
      { timeout: 30_000, message: 'A pane never bound its PTY' }
    )
    .toBe(true)
}

export async function addFolderWorkspace(page: Page): Promise<FolderWorkspaceSetup> {
  const folderPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-parity-folder-')))
  const cleanup = (): void => rmSync(folderPath, { recursive: true, force: true })
  const repoId = await page.evaluate(async (folder) => {
    const result = await window.api.repos.add({ path: folder, kind: 'folder' })
    if ('error' in result) {
      throw new Error(result.error)
    }
    return result.repo.id
  }, folderPath)
  await waitForSessionReady(page)
  let worktreeId: string | null = null
  await expect
    .poll(async () => {
      worktreeId = await page.evaluate(async (id) => {
        const store = window.__store!
        await store.getState().fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
        await store.getState().fetchWorktrees(id)
        const worktree = store.getState().worktreesByRepo[id]?.[0]
        if (worktree) {
          store.getState().setActiveWorktree(worktree.id)
        }
        return worktree?.id ?? null
      }, repoId)
      return worktreeId
    })
    .not.toBeNull()
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page)
  return { worktreeId: worktreeId!, pathLabels: { [folderPath]: '<folder>' }, cleanup }
}

/**
 * The user's close-pane chord, so the close reaches main through the real commit path; driving
 * PaneManager.closePane directly leaves main to learn of it from the PTY exit, which races quit.
 */
export async function closeActivePaneFromKeyboard(page: Page, paneCount: number): Promise<void> {
  await focusActiveTerminalInput(page)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+w' : 'Control+w')
  // A fresh shell can still read as busy, which asks before stopping it.
  const confirm = page.getByRole('button', { name: 'Stop and Close' })
  await expect
    .poll(
      async () => {
        if (await confirm.isVisible().catch(() => false)) {
          await confirm.click()
        }
        return countVisibleTerminalPanes(page)
      },
      { timeout: 10_000, intervals: [50] }
    )
    .toBe(paneCount - 1)
}

/** A real pointer drag of a pane's handle onto the tab strip, past the last tab or before the first, as a user drags a pane out. */
export async function dragPaneOutToTabStrip(
  page: Page,
  worktreeId: string,
  leafId: string,
  position: 'end' | 'start' = 'end'
): Promise<void> {
  const handle = page.locator(`.pane[data-leaf-id="${leafId}"] .pane-drag-handle`)
  const strip = page.locator(`[data-tab-group-strip-id][data-worktree-id="${worktreeId}"]`).first()
  const lastTab = strip.locator(SORTABLE_TAB).last()
  const handleBox = await handle.boundingBox()
  const stripBox = await strip.boundingBox()
  const lastTabBox = await lastTab.boundingBox()
  const firstTabBox = await strip.locator(SORTABLE_TAB).first().boundingBox()
  if (!handleBox || !stripBox || !lastTabBox || !firstTabBox) {
    throw new Error('Pane drag handle or tab strip is not laid out')
  }
  // TEMP diagnostics
  await page.evaluate(() => {
    const events: string[] = []
    document.body.dataset.dragEvents = ''
    const t0 = performance.now()
    const push = (entry: string) => {
      events.push(`${Math.round(performance.now() - t0)}ms ${entry}`.slice(0, 160))
      document.body.dataset.dragEvents = events.slice(-60).join(' | ')
    }
    const note = (name: string) => (event: Event) =>
      push(`${name}:${event.target instanceof Element ? event.target.className : 'win'}`)
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && node.classList.contains('pane')) {
            push(`mount pane leaf=${node.dataset.leafId}`)
          }
        }
        for (const node of record.removedNodes) {
          if (node instanceof HTMLElement && node.classList.contains('pane')) {
            push(`unmount pane leaf=${node.dataset.leafId}`)
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true })
    const log = console.log.bind(console)
    console.log = (...args: unknown[]) => {
      const text = args.map(String).join(' ')
      if (text.includes('[pty-connect]')) {
        push(text.slice(0, 140))
      }
      log(...args)
    }
    window.addEventListener('blur', note('blur'), true)
    window.addEventListener('pointerdown', note('down'), true)
    window.addEventListener('pointerup', note('up'), true)
    window.addEventListener('pointercancel', note('cancel'), true)
    window.addEventListener('lostpointercapture', note('lost'), true)
    window.addEventListener('gotpointercapture', note('got'), true)
  })
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 4)
  await page.mouse.down()
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 30, { steps: 5 })
  console.log(
    'DRAGMID',
    JSON.stringify(
      await page.evaluate(() => ({
        source: document.querySelectorAll('.is-drag-source').length,
        overlay: document.querySelector<HTMLElement>('.pane-drop-overlay')?.style.display ?? null,
        events: document.body.dataset.dragEvents,
        focus: document.hasFocus()
      }))
    )
  )
  await page.mouse.move(
    position === 'start'
      ? firstTabBox.x + 4
      : Math.min(lastTabBox.x + lastTabBox.width + 24, stripBox.x + stripBox.width - 4),
    stripBox.y + stripBox.height / 2,
    { steps: 20 }
  )
  console.log(
    'DRAGEND',
    JSON.stringify(
      await page.evaluate(() => ({
        source: document.querySelectorAll('.is-drag-source').length,
        overlay: document.querySelector<HTMLElement>('.pane-drop-overlay')?.style.display ?? null,
        events: document.body.dataset.dragEvents
      }))
    )
  )
  await page.mouse.up()
  await page.waitForTimeout(3_000)
  console.log('DRAGAFTER', await page.evaluate(() => document.body.dataset.dragEvents ?? ''))
}
