import { randomUUID } from 'node:crypto'
import type { AuthInfo, AuthenticationResponseDetails, WebContents } from 'electron'
import type { BrowserCredentials, BrowserLoginRequest } from '@shared/types'
import { TypedEmitter } from '../lib/typed-emitter'
import { loginHost } from './browser-policy'

type Callback = (username?: string, password?: string) => void

interface Pending {
  request: BrowserLoginRequest
  contents: WebContents
  callback: Callback
}

type Events = {
  /** A page asks for a login; its pane shows the question. */
  request: [request: BrowserLoginRequest]
  /** The question is answered, or void because the page went elsewhere or closed. */
  done: [id: string]
}

/**
 * Sites that want a user name and password before they show a page (HTTP authentication, e.g. a
 * staging server behind Basic Auth): the pane of the page asks the user (BrowserPane), and the page
 * waits until they answer. Electron would otherwise cancel such requests right away.
 */
class BrowserLogins extends TypedEmitter<Events> {
  private readonly pending = new Map<string, Pending>()
  private readonly watched = new WeakSet<WebContents>()

  /** From the page's `login` event, which has to be prevented to answer it later. */
  ask(contents: WebContents, details: AuthenticationResponseDetails, info: AuthInfo, callback: Callback): void {
    const request: BrowserLoginRequest = {
      id: randomUUID(),
      contentsId: contents.id,
      host: info.isProxy ? `${info.host}:${info.port}` : loginHost(info, details.url),
      realm: info.realm ?? '',
      proxy: info.isProxy,
      insecure: !info.isProxy && /^http:/i.test(details.url),
    }
    this.watch(contents)
    this.pending.set(request.id, { request, contents, callback })
    this.emit('request', { ...request })
  }

  /**
   * The user's answer (null: cancel). It counts for every question of the same page to the same
   * host and area, which come in a group when several requests of a page need the login.
   */
  answer(id: string, credentials: BrowserCredentials | null): void {
    const asked = this.pending.get(id)
    if (!asked) return
    const { contents, request } = asked
    for (const [key, entry] of [...this.pending]) {
      const same =
        entry.contents === contents &&
        entry.request.host === request.host &&
        entry.request.realm === request.realm &&
        entry.request.proxy === request.proxy
      if (!same) continue
      this.pending.delete(key)
      if (credentials) entry.callback(credentials.username, credentials.password)
      else entry.callback()
      this.emit('done', key)
    }
  }

  /** The questions that wait for an answer, oldest first. */
  list(): BrowserLoginRequest[] {
    return [...this.pending.values()].map((p) => ({ ...p.request }))
  }

  /** The first question of a page that waits for an answer. */
  pendingFor(contents: WebContents): BrowserLoginRequest | null {
    for (const entry of this.pending.values()) if (entry.contents === contents) return { ...entry.request }
    return null
  }

  /** Questions of a page that went elsewhere or closed are void: their requests are gone. */
  private watch(contents: WebContents): void {
    if (this.watched.has(contents)) return
    this.watched.add(contents)
    const drop = () => {
      for (const [key, entry] of [...this.pending]) {
        if (entry.contents !== contents) continue
        this.pending.delete(key)
        if (!contents.isDestroyed()) entry.callback()
        this.emit('done', key)
      }
    }
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) drop()
    })
    contents.once('destroyed', drop)
  }
}

export const browserLogins = new BrowserLogins()
