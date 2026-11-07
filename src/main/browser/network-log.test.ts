import { describe, expect, it } from 'vitest'
import { endSockets, markRouted, MESSAGE_LIMIT, networkEvent, type NetworkLog } from './network-log'

function log(): NetworkLog {
  return { network: new Map(), nextRequest: 1, routed: new Map() }
}

describe('networkEvent with WebSockets', () => {
  it('follows a WebSocket from its handshake to its close, with its messages', () => {
    const l = log()
    networkEvent(l, 'Network.webSocketCreated', { requestId: 'W1', url: 'ws://localhost:8080/live' }, undefined)
    networkEvent(l, 'Network.webSocketWillSendHandshakeRequest', { requestId: 'W1', timestamp: 100, wallTime: 1_700_000_000, request: { headers: { Upgrade: 'websocket' } } }, undefined)
    networkEvent(l, 'Network.webSocketHandshakeResponseReceived', { requestId: 'W1', timestamp: 100.05, response: { status: 101, statusText: 'Switching Protocols', headers: {} } }, undefined)
    networkEvent(l, 'Network.webSocketFrameSent', { requestId: 'W1', timestamp: 100.5, response: { opcode: 1, payloadData: '{"hello":1}' } }, undefined)
    networkEvent(l, 'Network.webSocketFrameReceived', { requestId: 'W1', timestamp: 101, response: { opcode: 2, payloadData: 'AAECAw==' } }, undefined)
    const error = networkEvent(l, 'Network.webSocketFrameError', { requestId: 'W1', timestamp: 101.5, errorMessage: 'Invalid frame' }, undefined)
    networkEvent(l, 'Network.webSocketClosed', { requestId: 'W1', timestamp: 103 }, undefined)
    const socket = [...l.network.values()][0]
    expect(socket).toMatchObject({ id: 1, type: 'WebSocket', method: 'GET', url: 'ws://localhost:8080/live', status: 101, closed: true, durationMs: 3000, messageCount: 3 })
    expect(socket.requestHeaders).toEqual({ Upgrade: 'websocket' })
    expect(socket.messages).toEqual([
      { at: 1_700_000_000_500, direction: 'sent', binary: false, data: '{"hello":1}' },
      { at: 1_700_000_001_000, direction: 'received', binary: true, data: '4 bytes' },
      { at: 1_700_000_001_500, direction: 'error', binary: false, data: 'Invalid frame' },
    ])
    expect(error).toBe('WebSocket: Invalid frame (ws://localhost:8080/live)')
  })

  it('keeps the newest messages and counts all of them', () => {
    const l = log()
    networkEvent(l, 'Network.webSocketCreated', { requestId: 'W2', url: 'ws://x' }, undefined)
    for (let i = 0; i < MESSAGE_LIMIT + 5; i++) {
      networkEvent(l, 'Network.webSocketFrameReceived', { requestId: 'W2', response: { opcode: 1, payloadData: `m${i}` } }, undefined)
    }
    const socket = [...l.network.values()][0]
    expect(socket.messageCount).toBe(MESSAGE_LIMIT + 5)
    expect(socket.messages).toHaveLength(MESSAGE_LIMIT)
    expect(socket.messages?.[0].data).toBe('m5')
  })

  it('adds the messages of an event stream to its request', () => {
    const l = log()
    networkEvent(l, 'Network.requestWillBeSent', { requestId: 'E1', type: 'EventSource', timestamp: 5, wallTime: 1000, request: { method: 'GET', url: 'http://x/events' } }, undefined)
    networkEvent(l, 'Network.eventSourceMessageReceived', { requestId: 'E1', timestamp: 6, eventName: 'tick', data: '42' }, undefined)
    networkEvent(l, 'Network.eventSourceMessageReceived', { requestId: 'E1', timestamp: 7, eventName: 'message', data: 'hi' }, undefined)
    const stream = [...l.network.values()][0]
    expect(stream.messages?.map((m) => m.data)).toEqual(['[tick] 42', 'hi'])
    expect(stream.messages?.[0].at).toBe(1_001_000)
  })
})

describe('endSockets', () => {
  it('closes the WebSockets of the document the page left', () => {
    const l = log()
    networkEvent(l, 'Network.webSocketCreated', { requestId: 'W3', url: 'ws://x' }, undefined)
    networkEvent(l, 'Network.requestWillBeSent', { requestId: 'D1', type: 'Document', timestamp: 1, request: { method: 'GET', url: 'http://x/' } }, undefined)
    endSockets(l)
    expect([...l.network.values()].map((e) => e.closed)).toEqual([true, false])
  })
})

describe('markRouted', () => {
  it('notes what a route did, before or after the request is in the log', () => {
    const l = log()
    markRouted(l, undefined, 'R1', 'answered with 500 by route 1')
    networkEvent(l, 'Network.requestWillBeSent', { requestId: 'R1', type: 'Fetch', timestamp: 1, request: { method: 'GET', url: 'http://x/api' } }, undefined)
    expect([...l.network.values()][0].routed).toBe('answered with 500 by route 1')
    expect(l.routed.size).toBe(0)
    networkEvent(l, 'Network.requestWillBeSent', { requestId: 'R2', type: 'Fetch', timestamp: 1, request: { method: 'GET', url: 'http://x/b' } }, undefined)
    markRouted(l, undefined, 'R2', 'delayed 100 ms by route 2')
    expect([...l.network.values()][1].routed).toBe('delayed 100 ms by route 2')
  })
})
