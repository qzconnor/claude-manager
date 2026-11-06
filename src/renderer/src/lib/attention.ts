import type { AttentionKind } from '@shared/types'

/** How a tab shows news the user hasn't seen yet (`TerminalInfo.attention`). */
export const attentionLook: Record<AttentionKind, { label: string; dot: string; text: string }> = {
  done: { label: 'Antwort fertig, noch nicht angesehen', dot: 'bg-primary', text: 'text-primary' },
  input: { label: 'Claude wartet auf dich', dot: 'bg-warning', text: 'text-warning' },
  limit: { label: 'Limit erreicht', dot: 'bg-warning', text: 'text-warning' },
}
