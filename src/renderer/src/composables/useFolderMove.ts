import { toast } from 'vue-sonner'
import { inFolder } from '@shared/folders'
import { errorMessage } from '@/lib/errors'
import { splitFolder } from '@/lib/recent-folders'
import { useSessionsStore } from '@/stores/sessions'
import { useTerminalsStore } from '@/stores/terminals'
import { useUiStore } from '@/stores/ui'
import { useWorkspacesStore } from '@/stores/workspaces'

function sessionsLabel(count: number): string {
  return count === 1 ? '1 Session' : `${count} Sessions`
}

/** What became of the sessions, for the toast. */
function sessionsMoved(count: number): string | undefined {
  if (count === 0) return undefined
  return count === 1 ? 'Die Session ist mitgezogen.' : `${sessionsLabel(count)} sind mitgezogen.`
}

/** Moves project folders on disk (e.g. into another workspace) after asking, their sessions along. */
export function useFolderMove() {
  const workspaces = useWorkspacesStore()
  const terminals = useTerminalsStore()
  const sessionsStore = useSessionsStore()
  const ui = useUiStore()

  /**
   * The sessions that move along with the folder: all that worked in it or below it, of every account,
   * also those the list's filters hide.
   */
  function sessionsIn(path: string): number {
    return sessionsStore.groups.reduce((sum, g) => sum + g.sessions.filter((s) => s.cwd && inFolder(s.cwd, path)).length, 0)
  }

  /**
   * `ask` false when the user chose the place just now, e.g. a new workspace for it. Resolves to the
   * new path, or null.
   */
  async function move(path: string, into: string, ask = true): Promise<string | null> {
    const name = splitFolder(path).name
    const target = splitFolder(into).name || into
    if (blocked(path)) return null
    const sessions = sessionsIn(path)
    const confirmed = !ask || (await ui.confirm({
      title: `„${name}“ nach „${target}“ verschieben?`,
      code: into,
      description: [
        'Der Ordner zieht auf der Festplatte um, mit allem, was darin liegt.',
        sessions > 0
          ? `${sessions === 1 ? 'Seine Session zieht' : `Seine ${sessionsLabel(sessions)} ziehen`} mit und ${sessions === 1 ? 'lässt' : 'lassen'} sich dort fortsetzen, bei jedem Account.`
          : '',
      ]
        .filter(Boolean)
        .join(' '),
      confirmText: 'Verschieben',
    }))
    if (!confirmed) return null

    const id = toast.loading(`„${name}“ wird verschoben…`)
    try {
      const result = await workspaces.move(path, into)
      if (result.leftover) {
        toast.warning(`„${name}“ ist jetzt in „${target}“`, {
          id,
          description: [`Vom alten Ordner ließ sich nicht alles löschen: ${path}`, sessionsMoved(result.sessions)].filter(Boolean).join(' '),
        })
      } else {
        toast.success(`„${name}“ ist jetzt in „${target}“`, { id, description: sessionsMoved(result.sessions) })
      }
      ui.folderToShow = { path: result.path }
      return result.path
    } catch (error) {
      toast.error(`„${name}“ wurde nicht verschoben`, { id, description: errorMessage(error) })
      return null
    }
  }

  /** Tabs are open in the folder: their processes keep it from moving. Says so. */
  function blocked(path: string): boolean {
    const open = terminals.terminals.filter((t) => t.cwd && inFolder(t.cwd, path))
    if (open.length === 0) return false
    const name = splitFolder(path).name
    toast.info(open.length === 1 ? `In „${name}“ ist noch ein Tab offen` : `In „${name}“ sind noch ${open.length} Tabs offen`, {
      description: 'Schließe sie, dann lässt sich der Ordner verschieben.',
    })
    return true
  }

  /** The folder is gone: asks where it is now, and its sessions go there. */
  async function relocate(path: string): Promise<void> {
    const { parent } = splitFolder(path)
    const picked = await window.api.app.pickDirectory(parent || null)
    if (!picked) return
    try {
      const moved = await workspaces.relocate(path, picked)
      if (moved === 0) {
        toast.info('Keine Session ist mitgezogen', {
          description: 'Sie laufen gerade in Claude Code, oder am neuen Ort liegt schon eine Kopie.',
        })
      } else {
        toast.success(moved === 1 ? 'Die Session ist mitgezogen' : `${sessionsLabel(moved)} sind mitgezogen`, {
          description: `${moved === 1 ? 'Sie lässt' : 'Sie lassen'} sich jetzt in ${picked} fortsetzen.`,
        })
      }
      ui.folderToShow = { path: picked }
    } catch (error) {
      toast.error('Sessions nicht zugeordnet', { description: errorMessage(error) })
    }
  }

  return { move, blocked, relocate, sessionsIn }
}
