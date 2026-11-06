/** Splits a command line into arguments, honouring double and single quotes. */
export function parseArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const char of input) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) {
        args.push(current)
        current = ''
        started = false
      }
    } else {
      current += char
      started = true
    }
  }
  if (started) args.push(current)
  return args
}

/** Inverse of parseArgs for display in an input field: parsing the result gives `args` back. */
export function formatArgs(args: string[]): string {
  return args.map(quoteArg).join(' ')
}

function quoteArg(arg: string): string {
  if (arg !== '' && !/[\s"']/.test(arg)) return arg
  if (!arg.includes('"')) return `"${arg}"`
  if (!arg.includes("'")) return `'${arg}'`
  // Both kinds: double-quoted runs with each " single-quoted in between; parseArgs joins adjacent quotes.
  return arg
    .split('"')
    .map((part) => `"${part}"`)
    .join(`'"'`)
}
