import { defineStore } from 'pinia'
import { nextTick, ref } from 'vue'
import type { TerminalInfo } from '@shared/types'
import { reviewPrompt, type ReviewComment } from '@/lib/review-comments'
import { terminalBus } from '@/lib/terminal-bus'
import { useTerminalsStore } from './terminals'

/**
 * Comments on lines of changes (a file's or all of a folder's), gathered like a review of a pull
 * request until they go to Claude in one go. They are kept by folder while the app runs, also while
 * the changes are closed.
 */
export const useReviewStore = defineStore('review', () => {
  const terminals = useTerminalsStore()
  const comments = ref<ReviewComment[]>([])
  let count = 0

  const of = (root: string) => comments.value.filter((c) => c.root === root)
  const ofFile = (root: string, path: string) => comments.value.filter((c) => c.root === root && c.path === path)
  const get = (id: string | null | undefined) => (id ? comments.value.find((c) => c.id === id) : undefined)

  function add(comment: Omit<ReviewComment, 'id'>): ReviewComment {
    const added = { ...comment, id: `review-${++count}` }
    comments.value = [...comments.value, added]
    return added
  }

  function update(id: string, patch: Partial<Pick<ReviewComment, 'from' | 'to' | 'ref' | 'text'>>): void {
    comments.value = comments.value.map((c) => (c.id === id ? { ...c, ...patch } : c))
  }

  function remove(id: string): void {
    comments.value = comments.value.filter((c) => c.id !== id)
  }

  /** Takes the comments of a folder away, e.g. once they went to Claude; `restore` brings them back. */
  function take(root: string): ReviewComment[] {
    const taken = of(root)
    comments.value = comments.value.filter((c) => c.root !== root)
    return taken
  }

  function restore(list: readonly ReviewComment[]): void {
    const ids = new Set(comments.value.map((c) => c.id))
    comments.value = [...comments.value, ...list.filter((c) => !ids.has(c.id))]
  }

  /** The Claude sessions running in a folder (or its worktree), the one that last had the keyboard first. */
  function targets(root: string): TerminalInfo[] {
    return terminals.terminals
      .filter((t) => t.mode === 'session' && t.status === 'running' && (t.worktree?.path || t.cwd) === root)
      .sort((a, b) => terminals.focusedAt(b.id) - terminals.focusedAt(a.id))
  }

  /**
   * The comments of a folder into the prompt of a session (`terminalId`), shown with the keyboard:
   * not sent yet, Enter sends them, after more words if wanted. Without the session, or its view,
   * they go to the clipboard. Either way they are taken away (`restore` brings them back).
   */
  async function send(root: string, terminalId: string | null): Promise<{ pasted: boolean; taken: ReviewComment[] } | null> {
    const list = of(root)
    if (list.length === 0) return null
    const text = reviewPrompt(list)
    let pasted = false
    if (terminalId && terminals.terminals.some((t) => t.id === terminalId)) {
      terminals.activate(terminalId)
      await nextTick()
      pasted = terminalBus.paste(terminalId, text)
    }
    if (!pasted) await navigator.clipboard.writeText(text)
    return { pasted, taken: take(root) }
  }

  return { comments, of, ofFile, get, add, update, remove, take, restore, targets, send }
})
