import { EFFORT_LADDER, formatRef, parseRef, type Effort, type ModelSpec, type Ref } from "./options"

/**
 * Structural subset of the OpenCode model info. The real `Model.Info` is assignable to this, and
 * the tests can build one without the SDK.
 */
export type ModelInfo = {
  id: string
  modelID?: string
  providerID: string
  name: string
  variants: { id: string }[]
  limit: { context: number }
}

export type Candidate = { key: string; model: ModelInfo; description: string }

export function findModel(available: ModelInfo[], ref: Ref): ModelInfo | undefined {
  return available.find(
    (model) => model.providerID === ref.providerID && (model.id === ref.id || model.modelID === ref.id),
  )
}

export function effortOptions(model: ModelInfo): string[] {
  const ids = new Set(model.variants.map((variant) => String(variant.id)))
  return EFFORT_LADDER.filter((effort) => ids.has(effort))
}

export function unionEffortOptions(models: ModelInfo[]): string[] {
  const ids = new Set(models.flatMap((model) => model.variants.map((variant) => String(variant.id))))
  return EFFORT_LADDER.filter((effort) => ids.has(effort))
}

const EFFORT_BANDS = {
  trivial:
    "Trivial only: yes/no answers, a single line or function to read, typo fixes, a single tiny edit. Anything that needs thought should not use this.",
  most: "Ordinary work, and most requests belong here: writing or changing code, adding tests, small refactors, explanations, ordinary debugging.",
  harder: "Harder work: multi-file changes, non-obvious debugging, design decisions.",
  deep: "Very hard: complex architecture, subtle concurrency, extended debugging after repeated failure.",
  hard: "Genuinely hard: architecture and design decisions, subtle concurrency, multi-file refactors, deep debugging after repeated failure, cross-cutting migrations.",
}

/**
 * Descriptions are relative to the rungs the model actually offers, because ladders differ: some
 * models expose three (low/high/max), others six. "Most requests" has to land on the middle rung
 * either way, so a 3-rung ladder cannot reuse a 6-rung ladder's wording.
 */
export function effortCriteria(efforts: string[]): Record<string, string> {
  const count = efforts.length
  if (count === 1) return { [efforts[0]!]: EFFORT_BANDS.most }
  if (count === 2) return { [efforts[0]!]: EFFORT_BANDS.trivial, [efforts[1]!]: EFFORT_BANDS.most }

  const criteria: Record<string, string> = {}
  efforts.forEach((effort, index) => {
    if (index === 0) criteria[effort] = EFFORT_BANDS.trivial
    else if (index === count - 1) criteria[effort] = EFFORT_BANDS.hard
    else if (index === 1) criteria[effort] = EFFORT_BANDS.most
    else if (index === count - 2) criteria[effort] = EFFORT_BANDS.deep
    else criteria[effort] = EFFORT_BANDS.harder
  })
  return criteria
}

export function nearestEffort(model: ModelInfo, effort: string | undefined): string | undefined {
  if (!effort) return
  const target = EFFORT_LADDER.indexOf(effort as Effort)
  if (target < 0) return
  const distance = (id: string) => Math.abs(EFFORT_LADDER.indexOf(id as Effort) - target)
  return model.variants
    .map((variant) => String(variant.id))
    .filter((id) => EFFORT_LADDER.includes(id as Effort))
    .reduce<string | undefined>((best, id) => (best === undefined || distance(id) < distance(best) ? id : best), undefined)
}

export function describe(model: ModelInfo): string {
  return `${model.name}. ${Math.round(model.limit.context / 1000)}k context.`
}

export function resolveCandidates(
  available: ModelInfo[],
  specs: ModelSpec[],
): { candidates: Candidate[]; missing: string[] } {
  const candidates: Candidate[] = []
  const missing: string[] = []
  for (const spec of specs) {
    const ref = parseRef(spec.key)
    if (!ref) {
      missing.push(spec.key)
      continue
    }
    const model = findModel(available, ref)
    if (!model) {
      missing.push(spec.key)
      continue
    }
    candidates.push({ key: formatRef(ref), model, description: spec.description || describe(model) })
  }
  return { candidates, missing }
}

/**
 * Resolves the effort to apply. Upgrades always win; a downgrade only lands when it is allowed.
 * An answer outside the offered options is rejected.
 */
export function resolveEffort(
  answer: string | undefined,
  current: string | undefined,
  offered: string[],
  allowDowngrade: boolean,
): string | undefined {
  if (!answer || !offered.includes(answer)) return undefined
  if (!current) return answer
  const currentIndex = EFFORT_LADDER.indexOf(current as Effort)
  const answerIndex = EFFORT_LADDER.indexOf(answer as Effort)
  if (currentIndex < 0 || answerIndex < 0) return answer
  if (answerIndex >= currentIndex) return answer
  return allowDowngrade ? answer : current
}
