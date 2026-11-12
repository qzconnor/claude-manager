/**
 * What Claude's answers cost at the prices of Anthropic's API (US dollars per million tokens, from
 * https://platform.claude.com/docs/en/about-claude/pricing). With a subscription nobody pays these
 * prices: they show what the usage is worth and where it goes.
 */

/** Writing the prompt cache costs 1.25 times the input for five minutes, twice the input for an hour. */
export interface ModelPrice {
  input: number
  output: number
  /** Reading the prompt cache. */
  cacheRead: number
  /** Fast mode costs this many times as much. */
  fast?: number
  /** Prompts over `tokens` (input and cache together) cost these prices instead. */
  long?: { tokens: number; price: ModelPrice }
}

const price = (input: number, output: number, cacheRead: number, extra: Partial<ModelPrice> = {}): ModelPrice => ({
  input,
  output,
  cacheRead,
  ...extra,
})

/** By family and version, as `modelKey` names them. */
const PRICES: Record<string, ModelPrice> = {
  'fable-5.2': price(8, 40, 0.2, { fast: 2 }),
  'mythos-5.2': price(8, 40, 0.2, { fast: 2 }),
  'fable-5.1': price(10, 50, 0.25),
  'mythos-5.1': price(10, 50, 0.25),
  'fable-5': price(10, 50, 1),
  'mythos-5': price(10, 50, 1),
  'opus-5.5': price(4, 20, 0.2, { fast: 2 }),
  'opus-5': price(5, 25, 0.5, { fast: 2 }),
  'opus-4.8': price(5, 25, 0.5, { fast: 2 }),
  'opus-4.7': price(5, 25, 0.5),
  'opus-4.6': price(5, 25, 0.5),
  'opus-4.5': price(5, 25, 0.5),
  'opus-4.1': price(15, 75, 1.5),
  'opus-4': price(15, 75, 1.5),
  'opus-3': price(15, 75, 1.5),
  'sonnet-5.5': price(2, 10, 0.1),
  'sonnet-5': price(2, 10, 0.2),
  'sonnet-4.6': price(3, 15, 0.3),
  'sonnet-4.5': price(3, 15, 0.3),
  'sonnet-4': price(3, 15, 0.3),
  'sonnet-3.7': price(3, 15, 0.3),
  'sonnet-3.5': price(3, 15, 0.3),
  'haiku-5.5': price(0.1, 0.5, 0.01, { long: { tokens: 100_000, price: price(0.5, 2.5, 0.05) } }),
  'haiku-4.5': price(1, 5, 0.1),
  'haiku-3.5': price(0.8, 4, 0.08),
  'haiku-3': price(0.25, 1.25, 0.03),
}

/**
 * Family and version of a model ID, e.g. `opus-4.1` for `claude-opus-4-1-20250805`, `sonnet-3.7` for
 * `claude-3-7-sonnet-20250219`; also with the prefixes and suffixes of Bedrock and Vertex. Null for
 * IDs that aren't Claude's.
 */
export function modelKey(model: string): string | null {
  const id = model.toLowerCase()
  // claude-opus-4-1-20250805, claude-opus-4-20250514, claude-fable-5-2, us.anthropic.claude-opus-4-6-v1:0
  const modern = /claude-(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d))?(?=$|[^\d])/.exec(id)
  if (modern) return `${modern[1]}-${modern[2]}${modern[3] ? `.${modern[3]}` : ''}`
  // claude-3-7-sonnet-20250219, claude-3-haiku-20240307
  const older = /claude-(\d)(?:-(\d))?-(opus|sonnet|haiku)/.exec(id)
  if (older) return `${older[3]}-${older[1]}${older[2] ? `.${older[2]}` : ''}`
  return null
}

/** The prices of a model; null when the app doesn't know them. */
export function modelPrice(model: string): ModelPrice | null {
  const key = modelKey(model)
  return key ? (PRICES[key] ?? null) : null
}

export interface PricedTokens {
  input: number
  output: number
  /** All cache writes, `cacheCreation1h` of them for an hour. */
  cacheCreation: number
  cacheCreation1h: number
  cacheRead: number
  /** Answered in fast mode. */
  fast: boolean
}

/** What one answer costs in US dollars; null for a model without a known price. */
export function answerCost(model: string, tokens: PricedTokens): number | null {
  let p = modelPrice(model)
  if (!p) return null
  const prompt = tokens.input + tokens.cacheCreation + tokens.cacheRead
  if (p.long && prompt > p.long.tokens) p = p.long.price
  const factor = tokens.fast ? (p.fast ?? 1) : 1
  const fiveMinutes = Math.max(0, tokens.cacheCreation - tokens.cacheCreation1h)
  const hour = Math.min(tokens.cacheCreation, tokens.cacheCreation1h)
  return (
    (factor *
      (tokens.input * p.input +
        tokens.output * p.output +
        fiveMinutes * p.input * 1.25 +
        hour * p.input * 2 +
        tokens.cacheRead * p.cacheRead)) /
    1_000_000
  )
}
