import type { GitFileStatus } from '@shared/types'
import { attempt } from '@/lib/errors'
import { baseName } from '@/lib/file-tree'
import { useUiStore } from '@/stores/ui'

/**
 * Staging and discarding the changes of a file of a tree, as the tree's menu and the view of a file's
 * changes offer them. Discarding always asks first; the file as it was goes to the recycle bin.
 */
export function useGitActions() {
  const ui = useUiStore()

  /** Runs `action`, with a toast when it fails; whether it went through. */
  async function run(action: () => Promise<void>, title: string): Promise<boolean> {
    const done = await attempt(async () => {
      await action()
      return true
    }, title)
    return done === true
  }

  /** What discarding does to a file, by how git sees it. */
  function discardText(path: string, status: GitFileStatus) {
    const name = baseName(path)
    if (status === 'untracked' || status === 'added') {
      return {
        title: `„${name}“ verwerfen?`,
        description: 'Git hat die Datei noch in keinem Commit. Sie kommt in den Papierkorb.',
        confirmText: 'In den Papierkorb',
      }
    }
    if (status === 'renamed') {
      return {
        title: `Verschieben von „${name}“ verwerfen?`,
        description: 'Die Datei kommt mit dem Stand des letzten Commits an ihren alten Platz zurück. Wie sie jetzt ist, kommt sie in den Papierkorb.',
        confirmText: 'Verwerfen',
      }
    }
    if (status === 'deleted') {
      return {
        title: `„${name}“ wiederherstellen?`,
        description: 'Die gelöschte Datei kommt mit dem Stand des letzten Commits zurück.',
        confirmText: 'Wiederherstellen',
      }
    }
    return {
      title: `Änderungen an „${name}“ verwerfen?`,
      description:
        'Die Datei bekommt wieder den Stand des letzten Commits, auch was davon vorgemerkt ist. Wie sie jetzt ist, kommt sie zur Sicherheit in den Papierkorb.',
      confirmText: 'Verwerfen',
    }
  }

  return {
    stage: (root: string, path: string) => run(() => window.api.files.stage(root, path), 'Nicht vorgemerkt'),
    unstage: (root: string, path: string) => run(() => window.api.files.unstage(root, path), 'Nicht aus dem Vorgemerkten genommen'),
    async discard(root: string, path: string, status: GitFileStatus): Promise<boolean> {
      if (!(await ui.confirm({ ...discardText(path, status), destructive: status !== 'deleted' }))) return false
      return run(() => window.api.files.discard(root, path), 'Nicht verworfen')
    },
    /** `patch`: the changes as the view shows them; `index`: the section of them. */
    stageHunk: (root: string, path: string, patch: string, index: number) =>
      run(() => window.api.files.hunk(root, path, { patch, index, discard: false }), 'Abschnitt nicht vorgemerkt'),
    async discardHunk(root: string, path: string, patch: string, index: number): Promise<boolean> {
      const confirmed = await ui.confirm({
        title: 'Diesen Abschnitt verwerfen?',
        description: 'Seine Zeilen bekommen wieder den Stand des letzten Commits. Die Datei, wie sie jetzt ist, kommt zur Sicherheit in den Papierkorb.',
        confirmText: 'Verwerfen',
        destructive: true,
      })
      if (!confirmed) return false
      return run(() => window.api.files.hunk(root, path, { patch, index, discard: true }), 'Abschnitt nicht verworfen')
    },
  }
}
