/**
 * The JSON-RPC side of a small MCP server (tools only), apart from HTTP so it can be tested alone.
 * See https://modelcontextprotocol.io/specification for the messages.
 */

/** Newest first; a client that asks for another one gets the newest. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const

export type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface McpToolResult {
  content: McpContent[]
  isError?: boolean
}

export interface McpTool {
  name: string
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

/** What the server offers to one client. */
export interface McpServerSpec {
  name: string
  version: string
  /** Shown to the model as the server's instructions. */
  instructions?: string
  tools: McpTool[]
  /** Errors become a result with `isError`, which the model sees. */
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>
}

type Id = string | number | null

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: Id
  result?: unknown
  error?: { code: number; message: string }
}

export const PARSE_ERROR = -32700
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602

export function rpcError(id: Id, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether a message is a request that waits for a result (not a notification or a response). */
export function isRequest(message: unknown): boolean {
  return isObject(message) && typeof message.method === 'string' && 'id' in message
}

/**
 * Answers one message, or a batch of them. Null when there is nothing to answer: notifications and
 * responses of the client (HTTP 202).
 */
export async function handleRpc(spec: McpServerSpec, message: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(message)) {
    if (message.length === 0) return rpcError(null, INVALID_REQUEST, 'Empty batch.')
    const answers = (await Promise.all(message.map((item) => handleOne(spec, item)))).filter((a): a is JsonRpcResponse => a !== null)
    return answers.length > 0 ? answers : null
  }
  return handleOne(spec, message)
}

async function handleOne(spec: McpServerSpec, message: unknown): Promise<JsonRpcResponse | null> {
  if (!isObject(message) || message.jsonrpc !== '2.0') return rpcError(null, INVALID_REQUEST, 'Not a JSON-RPC 2.0 message.')
  const { id, method, params } = message
  // A response to something the server asked; it asks nothing.
  if (typeof method !== 'string') return null
  if (!('id' in message)) return null
  if (typeof id !== 'string' && typeof id !== 'number') return rpcError(null, INVALID_REQUEST, 'Invalid id.')
  if (params !== undefined && !isObject(params)) return rpcError(id, INVALID_PARAMS, 'params must be an object.')

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion
      const version = PROTOCOL_VERSIONS.find((v) => v === asked) ?? PROTOCOL_VERSIONS[0]
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: spec.name, version: spec.version },
          ...(spec.instructions ? { instructions: spec.instructions } : {}),
        },
      }
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: spec.tools } }
    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments ?? {}
      if (typeof name !== 'string' || !spec.tools.some((tool) => tool.name === name)) {
        return rpcError(id, INVALID_PARAMS, `Unknown tool: ${String(name)}`)
      }
      if (!isObject(args)) return rpcError(id, INVALID_PARAMS, 'arguments must be an object.')
      let result: McpToolResult
      try {
        result = await spec.callTool(name, args)
      } catch (error) {
        result = { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
      }
      return { jsonrpc: '2.0', id, result }
    }
    default:
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`)
  }
}
