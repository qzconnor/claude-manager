import type { McpToolResult } from '../mcp-protocol'
import { optionalBoolean, optionalString } from '../tool-args'
import { generateTest } from './test-code'
import { tool, type ToolDefinition } from './tool'

/** browser_generate_test: what Claude did in the browser, as a Playwright test. */

export const testingTools: ToolDefinition<never>[] = [
  tool({
    name: 'browser_generate_test',
    title: 'Generate a Playwright test',
    description:
      "Turns what you did in the browser in this session into a Playwright test (TypeScript, @playwright/test): navigations, clicks, typing, keys, forms, uploads, drags, dialogs, routes and storage, with locators as Playwright recommends them (getByRole with the accessible name, getByLabel, getByTestId …); browser_wait_for becomes an expect. Save it with your file tools and check it with `npx playwright test`; add assertions of your own. clear: start the next test from here.",
    properties: {
      name: { type: 'string', description: 'The title of the test (default: "recorded by Claude").' },
      clear: { type: 'boolean', description: 'Forget the steps afterwards, so the next test starts from here.' },
    },
    readOnly: true,
    kind: 'test',
    parse: (args) => ({ name: optionalString(args, 'name', 200)?.trim() || 'recorded by Claude', clear: optionalBoolean(args, 'clear') ?? false }),
    label: () => 'Erzeugt einen Playwright-Test',
    session: async (tools, sessionId, p): Promise<McpToolResult> => {
      const steps = tools.control.recording(sessionId)
      if (p.clear) tools.control.clearRecording(sessionId)
      if (steps.length === 0) {
        return { content: [{ type: 'text', text: 'Nothing recorded yet: act in the browser first (browser_navigate, browser_click, browser_type …), then generate the test.' }] }
      }
      const code = generateTest(steps, p.name)
      const cleared = p.clear ? ' The recording starts anew from here.' : ''
      return {
        content: [
          {
            type: 'text',
            text: `A Playwright test of ${steps.length} step(s).${cleared} Locators follow the page as it was; check them where the page changes a lot, and add assertions (expect) for what the test should prove.\n\n\`\`\`ts\n${code}\`\`\``,
          },
        ],
      }
    },
  }),
]
