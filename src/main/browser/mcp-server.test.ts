import { describe, expect, it } from 'vitest'
import { mcpConfig, mcpLaunchArgs, MCP_SERVER_NAME } from './mcp-server'
import { pageCall } from './page-scripts'

describe('mcpLaunchArgs', () => {
  it('passes the config in the = form, so the prompt after it stays the prompt', () => {
    expect(mcpLaunchArgs('C:\\data dir\\browser-mcp\\a.json', false)).toEqual(['--mcp-config=C:\\data dir\\browser-mcp\\a.json'])
  })

  it('allows all tools of the server when the browser may be driven without asking', () => {
    expect(mcpLaunchArgs('/tmp/a.json', true)).toEqual(['--mcp-config=/tmp/a.json', `--allowedTools=mcp__${MCP_SERVER_NAME}`])
  })

  it('turns Claude in Chrome off when asked, so Claude takes the browser of the app', () => {
    expect(mcpLaunchArgs('/tmp/a.json', false, true)).toEqual(['--mcp-config=/tmp/a.json', '--no-chrome'])
  })
})

describe('mcpConfig', () => {
  it('names the server with its address and token', () => {
    expect(mcpConfig('http://127.0.0.1:4000/mcp', 'secret')).toEqual({
      mcpServers: {
        'claude-manager': { type: 'http', url: 'http://127.0.0.1:4000/mcp', headers: { Authorization: 'Bearer secret' } },
      },
    })
  })
})

describe('pageCall', () => {
  it('is valid JavaScript, also with arguments that need quoting', () => {
    expect(() => new Function(pageCall('snapshot', 40_000))).not.toThrow()
    expect(() => new Function(pageCall('selectOptions', 'e1', ['a "b"', "c'd", '`e`']))).not.toThrow()
  })
})
