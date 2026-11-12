import { describe, expect, it } from 'vitest'
import { createDefaultSettings } from '@shared/defaults'
import type { ClaudeSettings } from '@shared/types'
import { SENSITIVE_BROWSER_TOOLS } from './browser-tools'
import { allowedToolNames, askedAgain, mcpConfig, mcpLaunchArgs } from './mcp-server'
import { pageCall } from './page-scripts'

describe('mcpLaunchArgs', () => {
  it('passes the config in the = form, so the prompt after it stays the prompt', () => {
    expect(mcpLaunchArgs('C:\\data dir\\browser-mcp\\a.json', [])).toEqual(['--mcp-config=C:\\data dir\\browser-mcp\\a.json'])
  })

  it('allows the given tools of the server by their full names, in one argument', () => {
    expect(mcpLaunchArgs('/tmp/a.json', ['browser_click', 'limits'])).toEqual([
      '--mcp-config=/tmp/a.json',
      '--allowedTools=mcp__claude-manager__browser_click,mcp__claude-manager__limits',
    ])
  })

  it('turns Claude in Chrome off when asked, so Claude takes the browser of the app', () => {
    expect(mcpLaunchArgs('/tmp/a.json', [], true)).toEqual(['--mcp-config=/tmp/a.json', '--no-chrome'])
  })
})

describe('allowedToolNames', () => {
  const claude = (patch: Partial<ClaudeSettings> = {}): ClaudeSettings => ({ ...createDefaultSettings().claude, ...patch })
  const browser = ['browser_navigate', 'browser_click']

  it('allows the browser and the reading tools of the app by default, not the shells', () => {
    expect(allowedToolNames(claude(), browser, true)).toEqual([
      'browser_navigate',
      'browser_click',
      'limits',
      'sessions_search',
      'session_read',
      'themes_list',
    ])
  })

  it('leaves the browser to ask when the settings say so, or when it is off', () => {
    expect(allowedToolNames(claude({ browserToolsAllowed: false }), browser, true)).toEqual(['limits', 'sessions_search', 'session_read', 'themes_list'])
    expect(allowedToolNames(claude({ browserTools: false }), browser, true)).not.toContain('browser_click')
  })

  it('lets the browser tools that reach beyond the page ask, unless they are allowed too', () => {
    const tools = [
      'browser_click',
      'browser_file_upload',
      'browser_storage',
      'browser_evaluate',
      'browser_network_request',
      'browser_clear_site_data',
    ]
    expect(allowedToolNames(claude(), tools, false)).toEqual(['browser_click'])
    expect(allowedToolNames(claude({ browserSensitiveAllowed: true }), tools, false)).toEqual(tools)
    // Asking for every step of the browser asks for these too.
    expect(allowedToolNames(claude({ browserToolsAllowed: false, browserSensitiveAllowed: true }), tools, false)).toEqual([])
  })

  it('counts uploads, cookies, request contents, scripts and deleting site data as reaching beyond the page', () => {
    expect([...SENSITIVE_BROWSER_TOOLS].sort()).toEqual([
      'browser_clear_site_data',
      'browser_evaluate',
      'browser_file_upload',
      'browser_network_request',
      'browser_storage',
    ])
  })

  it('allows the shells only when they are on and allowed', () => {
    expect(allowedToolNames(claude({ shellToolsAllowed: true }), [], true)).not.toContain('shell_input')
    expect(allowedToolNames(claude({ shellTools: true }), [], true)).not.toContain('shell_input')
    expect(allowedToolNames(claude({ shellTools: true, shellToolsAllowed: true }), [], true)).toEqual(
      expect.arrayContaining(['shell_open', 'shell_input', 'shell_output', 'shell_list', 'shell_close']),
    )
  })

  it('leaves out switched off tools of the app, and all of them before the app has them', () => {
    expect(allowedToolNames(claude({ limitsTool: false, sessionsTool: false, themesTool: false }), [], true)).toEqual([])
    expect(allowedToolNames(claude(), browser, false)).toEqual(browser)
  })
})

describe('askedAgain', () => {
  it('asks for a tool allowed at the start of the session that the settings no longer allow', () => {
    const atStart = new Set(['browser_click', 'limits'])
    expect(askedAgain('browser_click', atStart, ['limits'])).toBe(true)
    expect(askedAgain('browser_click', atStart, ['browser_click', 'limits'])).toBe(false)
    // Claude Code asks for it itself.
    expect(askedAgain('shell_input', atStart, [])).toBe(false)
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
