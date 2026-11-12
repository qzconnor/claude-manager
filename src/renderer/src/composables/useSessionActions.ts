import { toast } from 'vue-sonner'
import type { SessionSummary } from '@shared/types'
import { attempt } from '@/lib/errors'
import { useSessionsStore } from '@/stores/sessions'
import { useUiStore } from '@/stores/ui'

/** What the list and the history do with a session besides going on with it: pin, tag and export it. */
export function useSessionActions() {
  const sessions = useSessionsStore()
  const ui = useUiStore()

  /** On top of the list under „Angeheftet“, or not any more. */
  function togglePin(session: SessionSummary) {
    void attempt(
      () => sessions.mark(session.id, { pinned: !session.pinned }),
      session.pinned ? 'Lösen fehlgeschlagen' : 'Anheften fehlgeschlagen',
    )
  }

  function editTags(session: SessionSummary) {
    ui.sessionTagsRequest = { sessionId: session.id, title: session.title, tags: [...session.tags] }
  }

  /** The whole history as a Markdown file, where the user saves it. */
  async function exportMarkdown(session: SessionSummary) {
    const path = await attempt(() => window.api.sessions.exportMarkdown(session.accountId, session.id), 'Export fehlgeschlagen')
    if (!path) return
    toast.success('Verlauf exportiert', {
      description: path,
      action: { label: 'Im Ordner zeigen', onClick: () => void attempt(() => window.api.app.showItem(path)) },
    })
  }

  return { togglePin, editTags, exportMarkdown }
}
