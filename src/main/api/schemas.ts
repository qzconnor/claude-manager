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
  UsageWindow: object(
    {
      key: str,
      label: str,
      percent: { type: 'number', minimum: 0, maximum: 100 },
      resetsAt: nullable(dateTime),
      severity: nullable(str),
      forecast: {
        ...nullable(ref('UsageForecast')),
        description: 'Wohin das Fenster beim jetzigen Tempo läuft; fehlt oder null, solange sich das nicht sagen lässt',
      },
    },
    ['key', 'label', 'percent', 'resetsAt', 'severity'],
  ),
  UsageForecast: object({
    exhaustsAt: {
      ...nullable(dateTime),
      description: 'Wann das Limit beim jetzigen Tempo erreicht ist; null, wenn es bis zum Reset reicht',
    },
    atReset: { type: 'number', description: 'Erwartete Auslastung zum Reset in Prozent, kann über 100 liegen' },
    ratePerHour: { type: 'number', description: 'Prozentpunkte pro Stunde' },
    basis: {
      type: 'string',
      enum: ['recent', 'window'],
      description: 'recent = Tempo der letzten Zeit (5-Stunden-Fenster: 1 Stunde, Woche: 1 Tag), window = Schnitt seit Beginn des Fensters',
    },
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
    folders: {
      ...arrayOf({
        allOf: [
          ref('TokenCounts'),
          object({
            path: { ...nullable(str), description: 'Ordner, in dem die Sessions liefen; Worktree-Sessions zählen zu ihrem Repository' },
            projectKey: str,
            sessionCount: int,
          }),
        ],
      }),
      description: 'Nach Ordner, der größte Verbrauch zuerst (Tokens nach API-Preisen gewichtet)',
    },
    totals: ref('TokenCounts'),
    sessionCount: int,
    computedAt: dateTime,
  }),
  SessionWorktree: object({
    name: str,
    branch: nullable(str),
    path: { type: 'string', description: 'Ordner des Worktrees; existiert nicht mehr, wenn er entfernt wurde' },
    originalCwd: { type: 'string', description: 'Ordner, in dem die Session gestartet wurde' },
  }),
  SessionSummary: object({
    id: { type: 'string', format: 'uuid' },
    accountId: str,
    projectKey: str,
    cwd: nullable(str),
    worktree: {
      ...nullable(ref('SessionWorktree')),
      description: 'Git-Worktree, den Claude Code für die Session angelegt hat (claude --worktree)',
    },
    title: { type: 'string', description: 'Was die App zeigt: name, sonst der Titel, den Claude Code der Session gab' },
    name: { ...nullable(str), description: 'Name, den die Session in der App bekam (Tab oder Session umbenannt); gilt vor dem Titel von Claude Code' },
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
    kind: {
      type: 'string',
      enum: ['prompt', 'command', 'shell', 'task', 'summary', 'answer', 'compact'],
      description:
        'prompt: Eingabe (eingefügter Text in <pasted_content>), command: Slash-Befehl, shell: Befehl nach „!“, task: Meldung einer Hintergrundaufgabe, summary: Zusammenfassung einer Komprimierung, answer: Antwort von Claude, compact: Komprimierung',
    },
    timestamp: nullable(dateTime),
    text: { type: 'string', description: 'Markdown' },
    output: { ...nullable(str), description: 'Ausgabe eines Befehls oder Ergebnis einer Hintergrundaufgabe, ohne Terminalfarben' },
    failed: { type: 'boolean', description: 'Der Befehl meldete Fehler oder die Aufgabe ist gescheitert' },
    tools: arrayOf(
      object({
        id: nullable(str),
        name: str,
        summary: str,
        detail: { ...nullable(str), description: 'z. B. „Zeilen 10–59“ bei Read' },
        description: { ...nullable(str), description: 'Wofür Claude den Aufruf macht' },
        command: { ...nullable(str), description: 'Befehl von Bash und PowerShell, bis 4000 Zeichen' },
        status: { anyOf: [{ type: 'string', enum: ['ok', 'error'] }, { type: 'null' }] },
      }),
    ),
    model: nullable(str),
  }),
  SessionDetail: object({
    summary: ref('SessionSummary'),
    messages: arrayOf(ref('TranscriptMessage')),
    truncated: { type: 'boolean', description: 'true, wenn nur die neuesten Nachrichten enthalten sind' },
    total: { type: 'integer', minimum: 0, description: 'Alle Nachrichten der Session, auch die nicht enthaltenen' },
  }),
  SessionLimit: object({
    type: { ...nullable(str), description: 'z. B. five_hour, seven_day' },
    resetsAt: nullable(dateTime),
    message: { type: 'string', description: 'Meldung von Claude Code' },
  }),
  SessionContext: object({
    tokens: {
      ...nullable({ type: 'integer', minimum: 0 }),
      description: 'Tokens im Kontext nach der letzten Antwort; nach einem Compact die Zusammenfassung. null vor der ersten Antwort',
    },
    compactAt: {
      ...nullable(int),
      description: 'Ab hier fasst Claude Code den Verlauf von selbst zusammen (Fenster minus Puffer); null, wenn Auto-Compact aus ist',
    },
    window: { type: 'integer', description: 'Auto-Compact-Fenster: per /autocompact gesetzt, sonst das Kontextfenster des Modells' },
    configured: { type: 'boolean', description: 'Das Fenster ist per /autocompact oder Einstellung gesetzt' },
    model: { ...nullable(str), description: 'z. B. claude-opus-5-5; vor der ersten Antwort das in Claude Code gewählte' },
  }),
  Terminal: object({
    id: str,
    accountId: { type: 'string', description: 'Account, in dessen Ordner die Session liegt' },
    authAccountId: { type: 'string', description: 'Account, dessen Login, Token oder API-Key der Prozess verwendet' },
    sessionId: { ...nullable(str), description: 'Claude-Code-Session, die gerade im Tab läuft' },
    limit: { ...nullable(ref('SessionLimit')), description: 'Gesetzt, solange die Session an einem Nutzungslimit steht' },
    resume: {
      ...nullable(ref('LimitResume')),
      description:
        'Die Session steht an einem Limit und geht von selbst weiter: am Reset oder mit dem automatischen Wechsel, sobald ein ' +
        'anderer Account frei ist. Bleibt nach dem Reset, bis sie weitergeht, auch wenn limit schon null ist',
    },
    context: {
      ...nullable(ref('SessionContext')),
      description: 'Wie voll der Kontext der Session ist, ab ihrem Start; null bei Shells, Logins und Browsern',
    },
    busy: { type: 'boolean', description: 'Claude Code arbeitet gerade an einer Antwort (laut Fenstertitel)' },
    hooks: {
      type: 'boolean',
      description:
        'Claude Code meldet seinen Zustand über Hooks an die App (Einstellung „Zustand über Hooks melden“): Ende einer Antwort ' +
        'und Rückfragen sofort, dazu activity, subagents und compacting. Sonst liest die App ihn aus Fenstertitel und Transcript',
    },
    activity: {
      ...nullable(ref('TerminalActivity')),
      description: 'Werkzeug, das Claude gerade ausführt (nur mit hooks). Gilt nur, solange busy gesetzt ist',
    },
    subagents: { type: 'integer', minimum: 0, description: 'Laufende Subagents der Session (nur mit hooks)' },
    compacting: { type: 'boolean', description: 'Claude Code fasst gerade den Verlauf zusammen (nur mit hooks)' },
    turn: {
      ...nullable(ref('TerminalTurn')),
      description: 'Wie der letzte Turn der Session endete. Bleibt, bis der nächste beginnt, auch wenn der Tab angezeigt wird',
    },
    prompt: { ...nullable(str), description: 'Anfang des letzten Prompts auf einer Zeile (nur mit hooks)' },
    attention: {
      ...nullable({ type: 'string', enum: ['done', 'input', 'limit'] }),
      description:
        'Ungesehene Neuigkeit im Tab: done = Antwort fertig, input = wartet auf Erlaubnis, Antwort oder Freigabe, ' +
        'limit = Nutzungslimit. null, sobald der Tab in der App angezeigt wurde',
    },
    muted: { type: 'boolean', description: 'Keine Benachrichtigungen und kein Blinken der Taskleiste für diesen Tab' },
    title: { type: 'string', description: 'Was der Tab anzeigt: der vergebene Name, sofern fixedTitle gesetzt ist, sonst autoTitle' },
    fixedTitle: { type: 'boolean', description: 'Titel wurde vergeben (umbenannt oder beim Öffnen) und folgt nicht der Session' },
    autoTitle: {
      type: 'string',
      description: 'Titel der Session wie in /resume (bei Browser-Tabs der Seitentitel), auch wenn der Tab umbenannt ist',
    },
    cwd: { type: 'string', description: 'Arbeitsordner; folgt der Session, wenn /cd sie verschiebt; leer bei Browser-Tabs' },
    mode: { type: 'string', enum: ['session', 'login', 'shell', 'browser'], description: 'browser = Webseite im Browser der App, ohne Prozess' },
    url: { ...nullable(str), description: 'Seite, die ein Browser-Tab zeigt; null bei Terminals' },
    resumeSessionId: nullable(str),
    args: {
      ...arrayOf(str),
      description: 'Eigene Argumente für claude, mit denen der Tab gestartet wurde (ohne die aus Einstellungen und Account)',
    },
    restoredFrom: { ...nullable(str), description: 'Beim Start wieder geöffnet: die ID, die der Tab im letzten Lauf hatte' },
    status: { type: 'string', enum: ['running', 'exited'] },
    exitCode: nullable(int),
    pid: int,
    createdAt: dateTime,
    commandLine: str,
    worktree: {
      ...nullable(ref('SessionWorktree')),
      description: 'Git-Worktree, in dem die Session arbeitet (claude --worktree); cwd bleibt der Startordner',
    },
  }),
  LimitResume: object({
    byUser: { type: 'boolean', description: 'Im Tab gewählt („Am Reset fortsetzen“); sonst wartet der automatische Wechsel' },
    at: {
      ...nullable(dateTime),
      description: 'Wann die Session mit ihrem Account weitergeht: eine Minute nach dem Reset; null, wenn er unbekannt ist',
    },
  }),
  TerminalTurn: object({
    kind: {
      type: 'string',
      enum: ['done', 'input', 'limit'],
      description: 'done = Antwort fertig, input = wartet auf Erlaubnis, Antwort oder Freigabe, limit = Nutzungslimit',
    },
    tool: { ...nullable(str), description: 'Bei input, worauf Claude wartet, z. B. Bash, AskUserQuestion, ExitPlanMode' },
    detail: {
      ...nullable(str),
      description: 'Anfang der Antwort als Text, der wartende Befehl oder die Frage, oder die Meldung zum Limit',
    },
    at: { ...dateTime, description: 'Wann der Turn endete' },
  }),
  TerminalActivity: object({
    tool: { type: 'string', description: 'z. B. Bash, Edit oder mcp__claude-manager__browser_click' },
    detail: { ...nullable(str), description: 'Befehl, Datei, Suche … des Werkzeugs' },
    since: dateTime,
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
      muted: { type: 'boolean', description: 'Ohne Benachrichtigungen für diesen Tab starten' },
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
