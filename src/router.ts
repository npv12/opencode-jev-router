import type { Plugin } from "@opencode/plugin"
import {
  effortCriteria,
  effortOptions,
  findModel,
  nearestEffort,
  resolveCandidates,
  resolveEffort,
  unionEffortOptions,
  type ModelInfo,
} from "./candidates"
import { CONSOLE, OPENROUTER, askAny, endpointFor, toCredential, type Endpoint, type Question, type ResolvedCredential } from "./jev"
import { sameRef, type Options, type Ref } from "./options"
import { StateStore } from "./session-state"

/** Structural subset of the session info the router reads. */
type SessionInfo = {
  id: string
  parentID?: string
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
  cost?: number
}

type Decider = { endpoint: Endpoint; credential: { token: string; orgID?: string } }

type Snapshot = { steps: number; failures: number; errors: string[] }

const CATALOG_TTL = 30_000

export function createRouter(ctx: Plugin.Context, options: Options) {
  const states = new StateStore()
  const warned = new Set<string>()
  let catalog: { at: number; models: ModelInfo[] } | undefined

  function warnOnce(key: string, message: string): void {
    if (warned.has(key)) return
    warned.add(key)
    console.error("opencode-jev-router:", message)
  }

  async function available(): Promise<ModelInfo[]> {
    const now = Date.now()
    if (!catalog || now - catalog.at > CATALOG_TTL) {
      catalog = { at: now, models: (await ctx.model.list()).data }
    }
    return catalog.models
  }

  async function credentialFor(integrationID: string) {
    const connection = await ctx.integration.connection.active(integrationID).catch(() => undefined)
    if (!connection) return undefined
    const value = (await ctx.integration.connection.resolve(connection).catch(() => undefined)) as
      | ResolvedCredential
      | undefined
    return toCredential(value)
  }

  // A pinned decider is a data policy, not a preference: it is used alone so a failure never falls
  // through to an endpoint that may train on prompt data.
  async function resolveDeciders(): Promise<Decider[]> {
    if (options.decider) {
      const integration = options.decider.endpoint === "console" ? "opencode" : "openrouter"
      const credential = await credentialFor(integration)
      if (!credential) {
        warnOnce(`decider:${integration}`, `no ${integration} credential for the configured decider, routing is disabled`)
        return []
      }
      return [{ endpoint: { ...endpointFor(options.decider.endpoint), model: options.decider.model }, credential }]
    }

    const deciders: Decider[] = []
    const consoleCredential = await credentialFor("opencode")
    if (consoleCredential) deciders.push({ endpoint: CONSOLE, credential: consoleCredential })
    const openrouterCredential = await credentialFor("openrouter")
    if (openrouterCredential) deciders.push({ endpoint: OPENROUTER, credential: openrouterCredential })
    return deciders
  }

  async function currentRef(session: SessionInfo): Promise<Ref | undefined> {
    if (session.model) {
      const ref: Ref = { providerID: session.model.providerID, id: session.model.id }
      if (session.model.variant) ref.variant = session.model.variant
      return ref
    }
    const fallback = (await ctx.model.default()).data
    if (!fallback) return undefined
    return { providerID: fallback.providerID, id: fallback.id }
  }

  function effortState(
    messages: string[],
    ref: Ref,
    model: ModelInfo,
    request: string | undefined,
    snapshot: Snapshot,
    trigger: "message" | "steps",
  ): string {
    const lines: string[] = []
    if (trigger === "message") lines.push(`Request: ${request ?? ""}`)
    lines.push(`Agent steps since the last check: ${snapshot.steps}`)
    lines.push(`Failed steps and tool calls since the last check: ${snapshot.failures}`)
    if (snapshot.errors.length) lines.push(`Recent failures:\n${snapshot.errors.map((e) => `- ${e}`).join("\n")}`)
    lines.push(`Model: ${model.name}`)
    lines.push(`Current effort: ${ref.variant ?? "unset"}`)
    // Earlier requests go last so truncation drops the oldest context, never the decision inputs.
    const earlier = trigger === "message" ? messages.slice(0, -1) : messages
    if (earlier.length) lines.push(`Earlier requests:\n${earlier.map((m) => `- ${m}`).join("\n")}`)
    return lines.join("\n")
  }

  async function askEffort(
    sessionID: string,
    efforts: string[],
    state: string,
  ): Promise<string | undefined> {
    const deciders = await resolveDeciders()
    if (deciders.length === 0) {
      warnOnce("decider", "no Jev credential found, the effort stays unchanged")
      return undefined
    }
    const questions: Record<string, Question> = {
      effort: {
        type: "choice",
        instructions:
          "How much reasoning effort should the agent use now? Repeated failures mean the current effort is not working, so choose a higher one.",
        criteria: effortCriteria(efforts),
      },
    }
    const answers = await askAny(deciders, { state, questions }, { sessionID })
    return answers.effort
  }

  async function applyEffort(
    sessionID: string,
    ref: Ref,
    model: ModelInfo,
    efforts: string[],
    answer: string | undefined,
  ): Promise<void> {
    const target = resolveEffort(answer, ref.variant, efforts, options.allowDowngrade)
    if (!target || target === ref.variant) return
    await ctx.session.switchModel({ sessionID, model: { ...ref, variant: target } })
    states.get(sessionID).variant = target
  }

  async function routeMain(sessionID: string, session: SessionInfo, text: string): Promise<void> {
    const ref = await currentRef(session)
    if (!ref) return
    const model = findModel(await available(), ref)
    if (!model) return
    const efforts = effortOptions(model)
    if (efforts.length <= 1) return
    const state = states.get(sessionID)
    const snapshot: Snapshot = { steps: state.steps, failures: state.failures, errors: [...state.errors] }
    state.managed = true
    states.resetCheck(sessionID)
    const answer = await askEffort(
      sessionID,
      efforts,
      effortState([...state.messages], ref, model, text, snapshot, "message"),
    ).catch((error) => {
      console.error("opencode-jev-router:", error)
      return undefined
    })
    if (!answer) return
    await applyEffort(sessionID, ref, model, efforts, answer)
  }

  async function isExplicit(session: SessionInfo): Promise<boolean> {
    if (session.agent) {
      const agent = await ctx.agent.get({ agentID: session.agent }).catch(() => undefined)
      if (agent?.data?.model) return true
    }
    if (session.model) {
      if (!session.parentID) return true
      const parent = await ctx.session.get({ sessionID: session.parentID }).catch(() => undefined)
      if (!parent?.model) return true
      if (!sameRef(parent.model, session.model)) return true
    }
    return false
  }

  async function routeWorker(sessionID: string, session: SessionInfo, text: string): Promise<void> {
    if (await isExplicit(session)) return
    if (options.models.length === 0) {
      warnOnce("worker-models", "no worker models configured, workers keep their inherited model")
      return
    }
    const models = await available()
    const { candidates, missing } = resolveCandidates(models, options.models)
    if (missing.length) {
      warnOnce(`worker-missing:${missing.join(",")}`, `worker models are not in the catalog, ignoring: ${missing.join(", ")}`)
    }
    if (candidates.length === 0) return
    const deciders = await resolveDeciders()
    if (deciders.length === 0) {
      warnOnce("decider", "no Jev credential found, workers keep their inherited model")
      return
    }
    const efforts = unionEffortOptions(candidates.map((candidate) => candidate.model))
    const questions: Record<string, Question> = {
      model: {
        type: "choice",
        instructions: "Pick the cheapest model that can do this job well.",
        criteria: Object.fromEntries(candidates.map((candidate) => [candidate.key, candidate.description])),
      },
    }
    if (efforts.length > 1) {
      questions.effort = {
        type: "choice",
        instructions: "How much reasoning effort does this task need?",
        criteria: effortCriteria(efforts),
      }
    }
    const answers = await askAny(deciders, { state: text, questions }, { sessionID }).catch((error) => {
      console.error("opencode-jev-router:", error)
      return undefined
    })
    const picked = candidates.find((candidate) => candidate.key === answers?.model)
    const fallback = options.fallback ? findModel(models, options.fallback) : undefined
    const model = picked?.model ?? fallback
    if (!model) return
    const variant = picked
      ? answers?.effort
        ? nearestEffort(model, answers.effort)
        : undefined
      : options.fallback?.variant
    const next: Ref = { providerID: model.providerID, id: model.id }
    if (variant) next.variant = variant
    await ctx.session.switchModel({ sessionID, model: next })
    const state = states.get(sessionID)
    state.managed = true
    state.variant = variant
    states.resetCheck(sessionID)
  }

  async function recalc(sessionID: string, snapshot: Snapshot): Promise<void> {
    const session = await ctx.session.get({ sessionID })
    const ref = await currentRef(session)
    if (!ref) return
    const model = findModel(await available(), ref)
    if (!model) return
    const efforts = effortOptions(model)
    if (efforts.length <= 1) return
    const answer = await askEffort(
      sessionID,
      efforts,
      effortState([...states.get(sessionID).messages], ref, model, undefined, snapshot, "steps"),
    ).catch((error) => {
      console.error("opencode-jev-router:", error)
      return undefined
    })
    if (!answer) return
    await applyEffort(sessionID, ref, model, efforts, answer)
  }

  return {
    async onPrompt(sessionID: string, text: string): Promise<void> {
      const session = await ctx.session.get({ sessionID })
      states.noteMessage(sessionID, text)
      if (session.parentID) {
        await routeWorker(sessionID, session, text)
        return
      }
      await routeMain(sessionID, session, text)
    },

    /** Counted from the model request hook, so it tracks agent steps rather than messages. */
    onStep(sessionID: string): void {
      const state = states.get(sessionID)
      if (!state.managed) return
      state.steps += 1
      if (state.steps < options.steps) return
      if (state.pending) return
      const snapshot: Snapshot = { steps: state.steps, failures: state.failures, errors: [...state.errors] }
      state.steps = 0
      state.failures = 0
      state.errors = []
      state.pending = recalc(sessionID, snapshot)
        .catch((error) => {
          console.error("opencode-jev-router:", error)
        })
        .finally(() => {
          states.get(sessionID).pending = undefined
        })
    },

    noteFailure(sessionID: string, text: string | undefined): void {
      states.noteFailure(sessionID, text)
    },
  }
}
