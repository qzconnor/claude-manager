/**
 * JSON schemas (OpenAPI 3.1) of the objects the local API returns. They mirror the types in
 * src/shared/types.ts — keep both in sync when a shared type changes.
 */

type Schema = Record<string, unknown>

export const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` })
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] })
const str: Schema = { type: 'string' }
const int: Schema = { type: 'integer' }
const num: Schema = { type: 'number' }
const bool: Schema = { type: 'boolean' }
const dateTime: Schema = { type: 'string', format: 'date-time' }
const arrayOf = (items: Schema): Schema => ({ type: 'array', items })
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({
  type: 'object',
  properties,
  required,
})

export const schemas: Record<string, Schema> = {
  Error: object({
    error: object({ status: int, message: str }),
  }),
  AccountIdentity: object({
    email: nullable(str),
    displayName: nullable(str),
    organizationUuid: nullable(str),
    organizationName: { ...nullable(str), description: 'Persönliche Organisationen heißen „<E-Mail>\'s Organization“' },
    organizationType: { ...nullable(str), description: 'z. B. claude_pro, claude_max, claude_team' },
    subscriptionType: { ...nullable(str), description: 'z. B. pro, max, team' },
    rateLimitTier: nullable(str),
  }),
  ExpectedLogin: object({
    email: str,
    accountUuid: nullable(str),
    organizationUuid: nullable(str),
    organizationName: nullable(str),
  }),
  Account: object({
    id: str,
    name: str,
    kind: { type: 'string', enum: ['system', 'oauth', 'token', 'apiKey'] },
    color: { type: 'string', description: 'Hex-Farbe, z. B. #d97757' },
    configDir: { type: 'string', description: 'CLAUDE_CONFIG_DIR des Accounts' },
    customConfigDir: bool,
    defaultCwd: nullable(str),
    extraArgs: arrayOf(str),
    createdAt: dateTime,
    hasSecret: bool,
    secretHint: { ...nullable(str), description: 'Maskierte Vorschau, nie das Secret selbst' },
    authState: { type: 'string', enum: ['ok', 'expired', 'missing'] },
    identity: ref('AccountIdentity'),
    tokenExpiresAt: nullable(dateTime),
    expectedLogin: {
      ...nullable(ref('ExpectedLogin')),
      description: 'Wer sich hier anmelden soll, z. B. nach dem Import aus cswap',
    },
  }),
  UsageWindow: object({
    key: str,
    label: str,
    percent: { type: 'number', minimum: 0, maximum: 100 },
    resetsAt: nullable(dateTime),
    severity: nullable(str),
  }),
  ExtraUsage: object({
    enabled: bool,
    usedCredits: nullable(num),
    monthlyLimit: nullable(num),
    percent: nullable(num),
    currency: nullable(str),
  }),
  AccountUsage: object({
    accountId: str,
    status: {
      type: 'string',
      enum: ['ok', 'unsupported', 'no-credentials', 'expired', 'unauthorized', 'rate-limited', 'error'],
    },
    source: { type: 'string', enum: ['live', 'claude-cache', 'none'] },
    fetchedAt: nullable(dateTime),
    message: nullable(str),
    fiveHour: nullable(ref('UsageWindow')),
    sevenDay: nullable(ref('UsageWindow')),
    scoped: arrayOf(ref('UsageWindow')),
    extra: nullable(ref('ExtraUsage')),
    breakdown: arrayOf(object({ key: str, label: str, percent: num })),
    nextRefreshAt: nullable(dateTime),
  }),
  TokenCounts: object({ input: int, output: int, cacheCreation: int, cacheRead: int, messages: int }),
  AccountTokenStats: object({
    accountId: str,
    days: arrayOf({
      allOf: [ref('TokenCounts'), object({ date: { type: 'string', format: 'date' } })],
    }),
    models: arrayOf({ allOf: [ref('TokenCounts'), object({ model: str })] }),
    totals: ref('TokenCounts'),
    sessionCount: int,
    computedAt: dateTime,
  }),
  SessionSummary: object({
    id: { type: 'string', format: 'uuid' },
    accountId: str,
    projectKey: str,
    cwd: nullable(str),
    title: str,
    firstPrompt: nullable(str),
    lastPrompt: nullable(str),
    gitBranch: nullable(str),
    model: nullable(str),
    messageCount: int,
    messageCountExact: bool,
    createdAt: dateTime,
    updatedAt: dateTime,
    sizeBytes: int,
    version: nullable(str),
  }),
  SessionGroup: object({
    accountId: str,
    sessions: arrayOf(ref('SessionSummary')),
    error: nullable(str),
  }),
  TranscriptMessage: object({
    uuid: str,
    role: { type: 'string', enum: ['user', 'assistant', 'system'] },
    timestamp: nullable(dateTime),
    text: { type: 'string', description: 'Markdown' },
    tools: arrayOf(
      object({
        id: nullable(str),
        name: str,
        summary: str,
        status: { anyOf: [{ type: 'string', enum: ['ok', 'error'] }, { type: 'null' }] },
      }),
    ),
    model: nullable(str),
  }),
  SessionDetail: object({
    summary: ref('SessionSummary'),
    messages: arrayOf(ref('TranscriptMessage')),
    truncated: { type: 'boolean', description: 'true, wenn nur die neuesten Nachrichten enthalten sind' },
  }),
  SessionLimit: object({
    type: { ...nullable(str), description: 'z. B. five_hour, seven_day' },
    resetsAt: nullable(dateTime),
    message: { type: 'string', description: 'Meldung von Claude Code' },
  }),
  Terminal: object({
    id: str,
    accountId: { type: 'string', description: 'Account, in dessen Ordner die Session liegt' },
    authAccountId: { type: 'string', description: 'Account, dessen Login, Token oder API-Key der Prozess verwendet' },
    sessionId: { ...nullable(str), description: 'Claude-Code-Session, die gerade im Tab läuft' },
    limit: { ...nullable(ref('SessionLimit')), description: 'Gesetzt, solange die Session an einem Nutzungslimit steht' },
    title: str,
    cwd: str,
    mode: { type: 'string', enum: ['session', 'login', 'shell'] },
    resumeSessionId: nullable(str),
    status: { type: 'string', enum: ['running', 'exited'] },
    exitCode: nullable(int),
    pid: int,
    createdAt: dateTime,
    commandLine: str,
  }),
  TerminalCreate: object(
    {
      accountId: { type: 'string', description: 'ID aus GET /accounts' },
      authAccountId: {
        ...nullable(str),
        description: 'Token- oder API-Key-Account, mit dessen Limits die Session läuft (Standard: accountId)',
      },
      cwd: { ...nullable(str), description: 'Arbeitsordner; Standard des Accounts bzw. der App, wenn leer' },
      resumeSessionId: { ...nullable(str), format: 'uuid', description: 'Bestehende Session fortsetzen' },
      forkSession: { type: 'boolean', description: 'Mit resumeSessionId: als neue Session abzweigen' },
      mode: { type: 'string', enum: ['session', 'login', 'shell'], default: 'session' },
      args: { ...arrayOf(str), description: 'Zusätzliche Argumente für claude' },
      title: nullable(str),
      cols: { type: 'integer', minimum: 20, maximum: 500 },
      rows: { type: 'integer', minimum: 5, maximum: 300 },
      activate: { type: 'boolean', description: 'Tab in der App anzeigen und Fenster in den Vordergrund holen' },
    },
    ['accountId'],
  ),
  TerminalOutput: object({
    data: { type: 'string', description: 'Rohausgabe inkl. ANSI-Escape-Sequenzen' },
    start: { type: 'integer', description: 'Stream-Offset des ersten Zeichens von data' },
    end: { type: 'integer', description: 'Stream-Offset nach data – als since für den nächsten Abruf verwenden' },
    truncated: { type: 'boolean', description: 'Ältere Ausgabe ist nicht mehr im Puffer' },
  }),
}
