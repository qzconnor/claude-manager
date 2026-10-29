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

/** Inverse of parseArgs for display in an input field. */
export function formatArgs(args: string[]): string {
  return args.map((arg) => (arg === '' || /[\s"']/.test(arg) ? `"${arg.replace(/"/g, '')}"` : arg)).join(' ')
}
