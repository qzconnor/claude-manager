type DataHandler = (data: string, offset: number) => void
type ExitHandler = (exitCode: number) => void

const dataHandlers = new Map<string, Set<DataHandler>>()
const exitHandlers = new Map<string, Set<ExitHandler>>()
let wired = false

/** One IPC subscription for all terminals; views register per terminal id. */
function wire(): void {
  if (wired) return
  wired = true
  window.api.terminals.onData((id, data, offset) => {
    dataHandlers.get(id)?.forEach((handler) => handler(data, offset))
  })
  window.api.terminals.onExit((id, exitCode) => {
    exitHandlers.get(id)?.forEach((handler) => handler(exitCode))
  })
}

function add<T>(map: Map<string, Set<T>>, id: string, handler: T): () => void {
  wire()
  let set = map.get(id)
  if (!set) {
    set = new Set()
    map.set(id, set)
  }
  set.add(handler)
  return () => {
    set.delete(handler)
    if (set.size === 0) map.delete(id)
  }
}

export const terminalBus = {
  onData: (id: string, handler: DataHandler) => add(dataHandlers, id, handler),
  onExit: (id: string, handler: ExitHandler) => add(exitHandlers, id, handler),
}
