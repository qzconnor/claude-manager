/**
 * Claude Code's arguments a tab was started with, e.g. `cm -- --model opus "Fix the build"`. When the
 * tab starts again (account switch, restart, moving, the next app start), the options that hold for
 * every start of the session go along. The prompt doesn't: it would be sent once more.
 *
 * Telling an option's value from a prompt needs to know which options take one. The lists follow
 * `claude --help`; an option missing in them takes the next argument, unless that is an option too.
 */

/** Options without a value. `--no-…` ones are such too. */
const FLAGS = new Set([
  '--allow-dangerously-skip-permissions',
  '--ax-screen-reader',
  '--bg',
  '--background',
  '--bare',
  '--brief',
  '--chrome',
  '-c',
  '--continue',
  '--dangerously-skip-permissions',
  '--desktop',
  '--disable-slash-commands',
  '--exclude-dynamic-system-prompt-sections',
  '--fork-session',
  '--forward-subagent-text',
  '-h',
  '--help',
  '--ide',
  '--include-hook-events',
  '--include-partial-messages',
  '-p',
  '--print',
  '--replay-user-messages',
  '--restricted',
  '--safe-mode',
  '--strict-mcp-config',
  '--tmux',
  '--verbose',
  '-v',
  '--version',
])

/** Options whose value may be left out: the next argument is theirs unless it is an option. */
const OPTIONAL_VALUE = new Set([
  '--cloud',
  '-d',
  '--debug',
  '--from-pr',
  '--prompt-suggestions',
  '--remote-control',
  '-r',
  '--resume',
  '--teleport',
  '-w',
  '--worktree',
])

/** Options that take all following arguments up to the next option. */
const VARIADIC = new Set([
  '--add-dir',
  '--allowedTools',
  '--allowed-tools',
  '--betas',
  '--disallowedTools',
  '--disallowed-tools',
  '--file',
  '--mcp-config',
  '--tools',
])

/** Options that need exactly one value, as `claude --help` lists them. */
const KNOWN_WITH_VALUE = new Set([
  '--agent',
  '--agents',
  '--append-system-prompt',
  '--autocompact',
  '--debug-file',
  '--effort',
  '--environment',
  '--fallback-model',
  '--input-format',
  '--json-schema',
  '--max-budget-usd',
  '--model',
  '-n',
  '--name',
  '--output-format',
  '--permission-mode',
  '--permission-prompts',
  '--plugin-dir',
  '--plugin-url',
  '--remote-control-session-name-prefix',
  '--session-id',
  '--setting-sources',
  '--settings',
  '--system-prompt',
  '--system-prompt-snapshot',
])

/**
 * Options for the first start only: which conversation it is (`--continue`, `--resume`, `--session-id`,
 * `--fork-session` …), its name and its worktree. A session that goes on keeps its name and worktree.
 */
const FIRST_START = new Set([
  '-c',
  '--continue',
  '-r',
  '--resume',
  '--session-id',
  '--fork-session',
  '--from-pr',
  '--teleport',
  '--cloud',
  '-n',
  '--name',
  '-w',
  '--worktree',
])

interface ArgGroup {
  /** The option, without an `=value`; null for a prompt. */
  option: string | null
  args: string[]
}

const isOption = (arg: string | undefined): arg is string => arg !== undefined && arg.length > 1 && arg.startsWith('-')

/** Splits the arguments into options with their values and prompts. */
function groups(args: readonly string[]): ArgGroup[] {
  const result: ArgGroup[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') {
      // Everything after it is a prompt.
      result.push({ option: null, args: args.slice(i) })
      break
    }
    if (!isOption(arg)) {
      result.push({ option: null, args: [arg] })
      continue
    }
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1
    const option = equals === -1 ? arg : arg.slice(0, equals)
    const group: ArgGroup = { option, args: [arg] }
    result.push(group)
    if (equals !== -1 || FLAGS.has(option) || option.startsWith('--no-')) continue
    if (VARIADIC.has(option)) {
      while (i + 1 < args.length && args[i + 1] !== '--' && !isOption(args[i + 1])) group.args.push(args[++i])
    } else if (OPTIONAL_VALUE.has(option) || !KNOWN_WITH_VALUE.has(option)) {
      if (i + 1 < args.length && args[i + 1] !== '--' && !isOption(args[i + 1])) group.args.push(args[++i])
    } else if (i + 1 < args.length) {
      // A value it needs is taken as it is, even one that starts with a dash.
      group.args.push(args[++i])
    }
  }
  return result
}

/** The arguments without the prompt: for a session that starts as it was started. */
export function argsWithoutPrompt(args: readonly string[]): string[] {
  return groups(args).flatMap((group) => (group.option === null ? [] : group.args))
}

/** The arguments that hold for every start of the session: without the prompt and without `FIRST_START`. */
export function lastingArgs(args: readonly string[]): string[] {
  return groups(args).flatMap((group) => (group.option === null || FIRST_START.has(group.option) ? [] : group.args))
}
