import type { ManagerApi } from '@shared/ipc'

declare global {
  interface Window {
    api: ManagerApi
  }
}

export {}
