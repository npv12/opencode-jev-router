export type SessionState = {
  /** True once the plugin owns this session's effort. */
  managed: boolean
  /** Last effort the plugin applied. */
  variant?: string
  /** Agent steps since the last check. */
  steps: number
  /** Failed steps and tool calls since the last check. */
  failures: number
  /** Recent human messages, newest last. */
  messages: string[]
  /** Recent failure texts, newest last. */
  errors: string[]
  /** In-flight recalculation, so two checks never overlap. */
  pending?: Promise<void>
}

const MAX_ERRORS = 3

export class StateStore {
  private states = new Map<string, SessionState>()

  get(sessionID: string): SessionState {
    let state = this.states.get(sessionID)
    if (!state) {
      state = { managed: false, steps: 0, failures: 0, messages: [], errors: [] }
      this.states.set(sessionID, state)
    }
    return state
  }

  noteMessage(sessionID: string, text: string): void {
    this.get(sessionID).messages.push(text)
  }

  noteFailure(sessionID: string, text: string | undefined): void {
    const state = this.get(sessionID)
    state.failures += 1
    if (text) {
      state.errors.push(text)
      if (state.errors.length > MAX_ERRORS) state.errors.shift()
    }
  }

  resetCheck(sessionID: string): void {
    const state = this.get(sessionID)
    state.steps = 0
    state.failures = 0
    state.errors = []
  }
}
