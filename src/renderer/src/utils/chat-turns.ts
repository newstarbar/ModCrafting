import type { DisplayMessage } from '../types/display-message'

export interface ChatTurn {
  id: string
  user?: DisplayMessage
  assistant?: DisplayMessage
}

export function groupMessagesIntoTurns(messages: DisplayMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = []
  let i = 0
  while (i < messages.length) {
    const msg = messages[i]
    if (msg.role === 'user') {
      const turn: ChatTurn = { id: msg.id, user: msg }
      if (messages[i + 1]?.role === 'assistant') {
        turn.assistant = messages[i + 1]
        i += 2
      } else {
        i += 1
      }
      turns.push(turn)
    } else {
      turns.push({ id: msg.id, assistant: msg })
      i += 1
    }
  }
  return turns
}
