import {
  getAgentForkArgv,
  getAgentResumeArgv,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent
} from './agent-session-resume'
import type { SessionOptionValue } from './native-chat-session-options'
import { buildSleepingAgentLaunchConfig } from './sleeping-agent-launch-config'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'
import type { AgentStartupPlan } from './tui-agent-startup'
import { resolveStartupShell, type AgentStartupShell } from './tui-agent-startup-shell'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'
import { buildAgentResumeLaunchCommand } from './agent-resume-launch-command'
import { dropRecordedAgentPermissionArgs } from './tui-agent-permission-lift'

export function buildAgentResumeStartupPlan(args: {
  agent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  shell?: AgentStartupShell
  agentArgs?: string | null
  agentEnv?: Record<string, string> | null
  agentCommand?: string | null
  ompResumeFilePath?: string | null
  sessionOptions?: Record<string, SessionOptionValue>
  sessionOptionsOverrideAgentArgs?: boolean
  isRemote?: boolean
  /** The caller chose the terminal folder on purpose, so Codex must not ask for the recorded one. */
  resumeInLaunchCwd?: boolean
  /** Open a copy of the conversation instead of re-entering it; null for agents that cannot. */
  fork?: boolean
}): AgentStartupPlan | null {
  const resumeArgv = args.fork
    ? getAgentForkArgv(args.agent, args.providerSession)
    : getAgentResumeArgv(args.agent, args.providerSession, args.ompResumeFilePath)
  if (!resumeArgv) {
    return null
  }
  // Why: Codex otherwise prompts for the folder, defaulting to the recorded one even once it was
  // deleted (#17745). Kept before `resume` so dropAgentResumeArgvFromCommand strips only that.
  const argv =
    args.agent === 'codex' && args.resumeInLaunchCwd
      ? [resumeArgv[0], '-c', 'tui.resume_cwd=current', ...resumeArgv.slice(1)]
      : resumeArgv
  const shell = resolveStartupShell(args.platform, args.shell)
  // Why: Codex restores a resumed thread's saved permissions unless the launch passes one, so
  // replaying Orca's launch-time flag would undo a change made inside the session (#10886).
  const recorded =
    args.agent === 'codex' && !args.fork
      ? dropRecordedAgentPermissionArgs(args.agent, args, shell)
      : args
  const resolvedAgentCommand = recorded.agentCommand?.trim()
  const baseCommand = resolvedAgentCommand
    ? ({
        ok: true,
        command: resolvedAgentCommand,
        commandWithoutSessionOptions: resolvedAgentCommand,
        appliedSessionOptions: {}
      } as const)
    : resolveAgentLaunchCommand({
        agent: args.agent,
        cmdOverrides: args.cmdOverrides,
        platform: args.platform,
        shell,
        agentArgs: recorded.agentArgs,
        sessionOptions: args.sessionOptions,
        sessionOptionsOverrideAgentArgs: args.sessionOptionsOverrideAgentArgs,
        isRemote: args.isRemote
      })
  if (!baseCommand.ok) {
    return null
  }
  const launchConfig = buildSleepingAgentLaunchConfig({
    ...args,
    agentArgs: recorded.agentArgs,
    agentCommand: baseCommand.commandWithoutSessionOptions
  })
  const launchCommand = buildAgentResumeLaunchCommand(args.agent, baseCommand.command, argv, shell)
  const applied = baseCommand.appliedSessionOptions
  return {
    agent: args.agent,
    launchCommand,
    expectedProcess: TUI_AGENT_CONFIG[args.agent].expectedProcess,
    followupPrompt: null,
    launchConfig,
    ...(args.agent === 'codex' ? { startupCommandDelivery: 'shell-ready' as const } : {}),
    ...(Object.keys(applied).length > 0 ? { sessionOptions: { ...applied } } : {}),
    ...(args.agentEnv ? { env: { ...args.agentEnv } } : {})
  }
}
