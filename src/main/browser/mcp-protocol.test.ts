import { describe, expect, it, vi } from 'vitest'
import { handleRpc, INVALID_PARAMS, INVALID_REQUEST, isRequest, METHOD_NOT_FOUND, PROTOCOL_VERSIONS, type McpServerSpec } from './mcp-protocol'

function spec(callTool: McpServerSpec['callTool'] = async () => ({ content: [{ type: 'text', text: 'done' }] })): McpServerSpec {
  return {
    name: 'test-server',
    version: '1.2.3',
    instructions: 'Use it well.',
    tools: [{ name: 'echo', description: 'Echoes.', inputSchema: { type: 'object', properties: {} } }],
    callTool,
  }
}

describe('handleRpc', () => {
  it('initializes with the version the client asks for when it knows it', async () => {
    const answer = await handleRpc(spec(), { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
    expect(answer).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'test-server', version: '1.2.3' },
        instructions: 'Use it well.',
      },
    })
  })

  it('offers its newest version for one it does not know', async () => {
    const answer = await handleRpc(spec(), { jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocolVersion: '1999-01-01' } })
    expect((answer as { result: { protocolVersion: string } }).result.protocolVersion).toBe(PROTOCOL_VERSIONS[0])
  })

  it('answers nothing to notifications and responses', async () => {
    expect(await handleRpc(spec(), { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(await handleRpc(spec(), { jsonrpc: '2.0', id: 3, result: {} })).toBeNull()
  })

  it('lists the tools and answers pings', async () => {
    expect(await handleRpc(spec(), { jsonrpc: '2.0', id: 2, method: 'tools/list' })).toMatchObject({ result: { tools: [{ name: 'echo' }] } })
    expect(await handleRpc(spec(), { jsonrpc: '2.0', id: 4, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 4, result: {} })
  })

  it('calls a tool with its arguments', async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'hi' }] }))
    const answer = await handleRpc(spec(callTool), { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } })
    expect(callTool).toHaveBeenCalledWith('echo', { a: 1 })
    expect(answer).toEqual({ jsonrpc: '2.0', id: 5, result: { content: [{ type: 'text', text: 'hi' }] } })
  })

  it('turns a failing tool into a result the model sees', async () => {
    const answer = await handleRpc(
      spec(async () => {
        throw new Error('The page is gone.')
      }),
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'echo' } },
    )
    expect(answer).toEqual({ jsonrpc: '2.0', id: 6, result: { content: [{ type: 'text', text: 'The page is gone.' }], isError: true } })
  })

  it('rejects unknown tools, methods and malformed messages', async () => {
    expect(await handleRpc(spec(), { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'nope' } })).toMatchObject({
      error: { code: INVALID_PARAMS },
    })
    expect(await handleRpc(spec(), { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'echo', arguments: [1] } })).toMatchObject({
      error: { code: INVALID_PARAMS },
    })
    expect(await handleRpc(spec(), { jsonrpc: '2.0', id: 9, method: 'resources/list' })).toMatchObject({ error: { code: METHOD_NOT_FOUND } })
    expect(await handleRpc(spec(), { id: 10, method: 'ping' })).toMatchObject({ id: null, error: { code: INVALID_REQUEST } })
    expect(await handleRpc(spec(), { jsonrpc: '2.0', id: {}, method: 'ping' })).toMatchObject({ error: { code: INVALID_REQUEST } })
  })

  it('answers a batch, leaving out its notifications', async () => {
    const answer = await handleRpc(spec(), [
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 11, method: 'ping' },
    ])
    expect(answer).toEqual([{ jsonrpc: '2.0', id: 11, result: {} }])
    expect(await handleRpc(spec(), [{ jsonrpc: '2.0', method: 'notifications/initialized' }])).toBeNull()
  })
})

describe('isRequest', () => {
  it('tells requests from notifications', () => {
    expect(isRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call' })).toBe(true)
    expect(isRequest({ jsonrpc: '2.0', method: 'notifications/cancelled' })).toBe(false)
    expect(isRequest([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).toBe(false)
  })
})
