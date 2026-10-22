export const EFFORT_LADDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const
export type Effort = (typeof EFFORT_LADDER)[number]

export const DEFAULT_STEPS = 30

export type Ref = { providerID: string; id: string; variant?: string }

export type ModelSpec = { key: string; description: string }

export type Decider = { endpoint: "console" | "openrouter"; model: string }

export type Options = {
  models: ModelSpec[]
  fallback?: Ref
  decider?: Decider
  steps: number
  allowDowngrade: boolean
  warnings: string[]
}

export function parseRef(value: unknown): Ref | undefined {
  if (typeof value !== "string") return
  const input = value.trim()
  const slash = input.indexOf("/")
  if (slash <= 0) return
  const hash = input.indexOf("#", slash + 1)
  const id = input.slice(slash + 1, hash === -1 ? undefined : hash)
  const variant = hash === -1 ? undefined : input.slice(hash + 1)
  if (!id || variant === "") return
  return { providerID: input.slice(0, slash), id, ...(variant ? { variant } : {}) }
}

export function formatRef(ref: Ref): string {
  return `${ref.providerID}/${ref.id}`
}

export function sameRef(a: Ref | undefined, b: Ref | undefined): boolean {
  if (!a || !b) return false
  return a.providerID === b.providerID && a.id === b.id
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function parseOptions(raw: unknown): Options {
  const warnings: string[] = []
  const input = record(raw)

  const models: ModelSpec[] = []
  const rawModels = input.models
  if (rawModels !== undefined) {
    if (typeof rawModels === "object" && rawModels !== null && !Array.isArray(rawModels)) {
      for (const [key, value] of Object.entries(rawModels)) {
        const ref = parseRef(key)
        if (!ref) {
          warnings.push(`models: ignoring "${key}", expected provider/model`)
          continue
        }
        const description = typeof value === "string" ? value.trim() : ""
        models.push({ key: formatRef(ref), description })
      }
    } else {
      warnings.push("models: expected an object of provider/model -> description")
    }
  }

  let fallback: Ref | undefined
  if (input.default !== undefined) {
    fallback = parseRef(input.default)
    if (!fallback) warnings.push(`default: ignoring "${String(input.default)}", expected provider/model`)
  }

  let decider: Decider | undefined
  if (input.decider !== undefined) {
    const ref = parseRef(input.decider)
    if (!ref) {
      warnings.push("decider: expected opencode/jev-<version> or openrouter/typesafe/jev-<version>")
    } else if (ref.providerID === "opencode" && ref.id.startsWith("jev-")) {
      decider = { endpoint: "console", model: ref.id }
    } else if (ref.providerID === "openrouter" && ref.id.startsWith("typesafe/jev-")) {
      decider = { endpoint: "openrouter", model: ref.id }
    } else {
      warnings.push(`decider: ignoring "${formatRef(ref)}", only Jev is supported`)
    }
  }

  const recalc = record(input.recalc)
  let steps = DEFAULT_STEPS
  if (recalc.steps !== undefined) {
    if (typeof recalc.steps === "number" && Number.isFinite(recalc.steps) && recalc.steps >= 1) {
      steps = Math.floor(recalc.steps)
    } else {
      warnings.push(`recalc.steps: ignoring ${String(recalc.steps)}, expected a number >= 1`)
    }
  }

  const allowDowngrade = typeof recalc.allowDowngrade === "boolean" ? recalc.allowDowngrade : true

  return { models, fallback, decider, steps, allowDowngrade, warnings }
}
