export type Question = { type: "choice"; instructions: string; criteria: Record<string, string> }

export type JevRequest = { state: string; questions: Record<string, Question> }

export type JevAnswer = Record<string, string | undefined>

export type Endpoint = { url: string; model: string }

export type Credential = { token: string; orgID?: string }

/** Structural subset of the resolved credential the plugin needs. */
export type ResolvedCredential = {
  type: string
  key?: string
  access?: string
  metadata?: Record<string, unknown>
}

export const CONSOLE: Endpoint = {
  url: "https://opencode.ai/inference/systemone/v1/systemone",
  model: "jev-1.13",
}

export const OPENROUTER: Endpoint = {
  url: "https://openrouter.ai/api/v1/systemone",
  model: "typesafe/jev-1.14",
}

export const JEV_TIMEOUT = 10_000
export const MAX_STATE = 8_000

export function endpointFor(kind: "console" | "openrouter"): Endpoint {
  return kind === "console" ? CONSOLE : OPENROUTER
}

export function toCredential(value: ResolvedCredential | undefined): Credential | undefined {
  if (!value || value.type === "external") return
  const token = value.type === "oauth" ? value.access : value.key
  if (!token) return
  const orgID = value.metadata?.orgID
  return { token, orgID: typeof orgID === "string" ? orgID : undefined }
}

export async function askAny(
  deciders: { endpoint: Endpoint; credential: Credential }[],
  request: JevRequest,
  options: { sessionID?: string; timeout?: number } = {},
): Promise<JevAnswer> {
  let last: unknown
  for (const decider of deciders) {
    try {
      return await ask(decider.endpoint, decider.credential, request, options)
    } catch (error) {
      last = error
    }
  }
  throw last instanceof Error ? last : new Error("no Jev decider answered")
}

export async function ask(
  endpoint: Endpoint,
  credential: Credential,
  request: JevRequest,
  options: { sessionID?: string; timeout?: number } = {},
): Promise<JevAnswer> {
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${credential.token}`,
      ...(options.sessionID ? { "x-opencode-session": options.sessionID } : {}),
      ...(credential.orgID ? { "x-opencode-org-id": credential.orgID } : {}),
    },
    body: JSON.stringify({
      model: endpoint.model,
      state: request.state.slice(0, MAX_STATE),
      questions: request.questions,
    }),
    signal: AbortSignal.timeout(options.timeout ?? JEV_TIMEOUT),
  })
  if (!response.ok) throw new Error(`Jev returned ${response.status}: ${await response.text()}`)
  const data = (await response.json()) as { answers?: Record<string, { choice?: unknown } | undefined> }
  const answers: JevAnswer = {}
  for (const [id, answer] of Object.entries(data.answers ?? {})) {
    const choice = answer?.choice
    if (typeof choice === "string") answers[id] = choice
  }
  return answers
}
