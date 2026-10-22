import { afterEach, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { createRouter } from "../src/router"
import { parseOptions } from "../src/options"
import type { ModelInfo } from "../src/candidates"

const model = (providerID: string, id: string, variants: string[] = []): ModelInfo => ({
  id,
  providerID,
  name: id,
  variants: variants.map((variant) => ({ id: variant })),
  limit: { context: 200_000 },
})

const CATALOG = [
  model("anthropic", "claude-opus-5-5", ["low", "medium", "high", "xhigh", "max"]),
  model("anthropic", "claude-haiku-4-5"),
  model("openai", "gpt-6-luna", ["none", "low", "medium", "high"]),
  model("opencode-go", "deepseek-v4.1-flash", ["low", "high", "max"]),
]

type Session = {
  id: string
  parentID?: string
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
}

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

type Harness = {
  router: ReturnType<typeof createRouter>
  switched: { sessionID: string; model: { providerID: string; id: string; variant?: string } }[]
  requests: { url: string; body: any }[]
}

function setup(input: {
  options?: Record<string, unknown>
  sessions?: Record<string, Session>
  agents?: Record<string, { model?: { providerID: string; id: string } }>
  defaultModel?: ModelInfo
  answers?: Record<string, string>
  answerSequence?: Record<string, string>[]
  jevStatus?: number
}) {
  const sessions: Record<string, Session> = structuredClone(
    input.sessions ?? { ses_a: { id: "ses_a", model: { providerID: "anthropic", id: "claude-opus-5-5" } } },
  )
  const switched: Harness["switched"] = []
  const requests: Harness["requests"] = []

  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) })
    if (input.jevStatus) return new Response("unavailable", { status: input.jevStatus })
    const choice = input.answerSequence
      ? input.answerSequence[Math.min(requests.length - 1, input.answerSequence.length - 1)]
      : input.answers
    const answers: Record<string, { type: "choice"; choice: string }> = {}
    for (const [id, value] of Object.entries(choice ?? {})) answers[id] = { type: "choice", choice: value }
    return Response.json({ answers })
  }) as typeof fetch

  const ctx = {
    options: input.options ?? {},
    model: {
      list: async () => ({ data: CATALOG }),
      default: async () => ({ data: input.defaultModel ?? null }),
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => sessions[sessionID],
      switchModel: async ({
        sessionID,
        model,
      }: {
        sessionID: string
        model: { providerID: string; id: string; variant?: string }
      }) => {
        switched.push({ sessionID, model })
        sessions[sessionID]!.model = model
      },
    },
    agent: {
      get: async ({ agentID }: { agentID: string }) => ({ data: input.agents?.[agentID] ?? { id: agentID } }),
    },
    integration: {
      connection: {
        active: async (id: string) => (id === "opencode" ? { type: "credential", id } : undefined),
        resolve: async () => ({ type: "oauth", access: "token", metadata: { orgID: "org_1" } }),
      },
    },
  } as unknown as Plugin.Context

  return {
    router: createRouter(ctx, parseOptions(input.options ?? {})),
    switched,
    requests,
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

test("the main session keeps its model and only changes the effort", async () => {
  const harness = setup({ answers: { effort: "high" } })
  await harness.router.onPrompt("ses_a", "debug the failing auth test")
  expect(harness.requests).toHaveLength(1)
  expect(harness.requests[0]?.url).toBe("https://opencode.ai/inference/systemone/v1/systemone")
  expect(harness.requests[0]?.body.model).toBe("jev-1.13")
  expect(harness.requests[0]?.body.questions.effort.criteria).toEqual({
    low: "Trivial only: yes/no answers, a single line or function to read, typo fixes, a single tiny edit. Anything that needs thought should not use this.",
    medium:
      "Ordinary work, and most requests belong here: writing or changing code, adding tests, small refactors, explanations, ordinary debugging.",
    high: "Harder work: multi-file changes, non-obvious debugging, design decisions.",
    xhigh: "Very hard: complex architecture, subtle concurrency, extended debugging after repeated failure.",
    max: "Genuinely hard: architecture and design decisions, subtle concurrency, multi-file refactors, deep debugging after repeated failure, cross-cutting migrations.",
  })
  expect(harness.switched).toEqual([
    { sessionID: "ses_a", model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" } },
  ])
})

test("a model without effort variants is left alone and Jev is never called", async () => {
  const harness = setup({
    sessions: { ses_a: { id: "ses_a", model: { providerID: "anthropic", id: "claude-haiku-4-5" } } },
    answers: { effort: "high" },
  })
  await harness.router.onPrompt("ses_a", "hello")
  expect(harness.requests).toHaveLength(0)
  expect(harness.switched).toHaveLength(0)
})

test("an effort the model does not offer is ignored", async () => {
  const harness = setup({ answers: { effort: "none" } })
  await harness.router.onPrompt("ses_a", "hello")
  expect(harness.requests).toHaveLength(1)
  expect(harness.switched).toHaveLength(0)
})

test("a downgrade lands when it is allowed", async () => {
  const harness = setup({
    sessions: {
      ses_a: { id: "ses_a", model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" } },
    },
    answers: { effort: "low" },
  })
  await harness.router.onPrompt("ses_a", "thanks")
  expect(harness.switched).toEqual([
    { sessionID: "ses_a", model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "low" } },
  ])
})

test("a downgrade is blocked when it is not allowed", async () => {
  const harness = setup({
    options: { recalc: { allowDowngrade: false } },
    sessions: {
      ses_a: { id: "ses_a", model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" } },
    },
    answers: { effort: "low" },
  })
  await harness.router.onPrompt("ses_a", "thanks")
  expect(harness.switched).toHaveLength(0)
})

test("a failing Jev leaves the session untouched", async () => {
  const error = console.error
  console.error = () => {}
  const harness = setup({ jevStatus: 503 })
  await harness.router.onPrompt("ses_a", "hello")
  console.error = error
  expect(harness.switched).toHaveLength(0)
})

test("a worker picks its own model and effort", async () => {
  const harness = setup({
    options: { models: { "openai/gpt-6-luna": "Cheap and fast.", "anthropic/claude-opus-5-5": "Strong." } },
    sessions: {
      ses_parent: { id: "ses_parent", model: { providerID: "anthropic", id: "claude-opus-5-5" } },
      ses_child: { id: "ses_child", parentID: "ses_parent", model: { providerID: "anthropic", id: "claude-opus-5-5" } },
    },
    answers: { model: "openai/gpt-6-luna", effort: "high" },
  })
  await harness.router.onPrompt("ses_child", "explore the repo")
  expect(harness.requests[0]?.body.questions.model.criteria).toEqual({
    "openai/gpt-6-luna": "Cheap and fast.",
    "anthropic/claude-opus-5-5": "Strong.",
  })
  expect(harness.switched).toEqual([
    { sessionID: "ses_child", model: { providerID: "openai", id: "gpt-6-luna", variant: "high" } },
  ])
})

test("a worker with a model on its agent is left alone", async () => {
  const harness = setup({
    options: { models: { "openai/gpt-6-luna": "Cheap and fast." } },
    sessions: {
      ses_parent: { id: "ses_parent", model: { providerID: "anthropic", id: "claude-opus-5-5" } },
      ses_child: {
        id: "ses_child",
        parentID: "ses_parent",
        agent: "explore",
        model: { providerID: "anthropic", id: "claude-opus-5-5" },
      },
    },
    agents: { explore: { model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" } } },
    answers: { model: "openai/gpt-6-luna" },
  })
  await harness.router.onPrompt("ses_child", "explore the repo")
  expect(harness.requests).toHaveLength(0)
  expect(harness.switched).toHaveLength(0)
})

test("a worker whose model differs from its parent counts as explicit", async () => {
  const harness = setup({
    options: { models: { "openai/gpt-6-luna": "Cheap and fast." } },
    sessions: {
      ses_parent: { id: "ses_parent", model: { providerID: "anthropic", id: "claude-opus-5-5" } },
      ses_child: { id: "ses_child", parentID: "ses_parent", model: { providerID: "openai", id: "gpt-6-luna" } },
    },
    answers: { model: "openai/gpt-6-luna" },
  })
  await harness.router.onPrompt("ses_child", "explore the repo")
  expect(harness.requests).toHaveLength(0)
  expect(harness.switched).toHaveLength(0)
})

test("a worker falls back to the default model when Jev picks nothing", async () => {
  const harness = setup({
    options: { models: { "openai/gpt-6-luna": "Cheap and fast." }, default: "openai/gpt-6-luna#low" },
    sessions: {
      ses_parent: { id: "ses_parent", model: { providerID: "anthropic", id: "claude-opus-5-5" } },
      ses_child: { id: "ses_child", parentID: "ses_parent", model: { providerID: "anthropic", id: "claude-opus-5-5" } },
    },
    answers: { model: "something/unknown" },
  })
  await harness.router.onPrompt("ses_child", "explore the repo")
  expect(harness.switched).toEqual([
    { sessionID: "ses_child", model: { providerID: "openai", id: "gpt-6-luna", variant: "low" } },
  ])
})

test("every earlier human message is carried in the state", async () => {
  const harness = setup({ answers: { effort: "low" } })
  for (const text of ["first", "second", "third", "fourth"]) await harness.router.onPrompt("ses_a", text)
  const state = harness.requests.at(-1)?.body.state as string
  expect(state).toContain("Request: fourth")
  expect(state).toContain("Earlier requests:\n- first\n- second\n- third")
  expect(state).not.toContain("- fourth")
})

test("a human message sees the struggle and the counters reset after it", async () => {
  const harness = setup({ answers: { effort: "low" } })
  await harness.router.onPrompt("ses_a", "start")
  harness.router.noteFailure("ses_a", "edit failed: oldString not found")
  harness.router.noteFailure("ses_a", "test suite failed")

  await harness.router.onPrompt("ses_a", "did you fix it?")
  const state = harness.requests[1]?.body.state as string
  expect(state).toContain("Failed steps and tool calls since the last check: 2")
  expect(state).toContain("edit failed: oldString not found")
  expect(harness.requests[1]?.body.questions.effort.instructions).toContain("choose a higher one")

  await harness.router.onPrompt("ses_a", "thanks")
  expect(harness.requests[2]?.body.state).toContain("Failed steps and tool calls since the last check: 0")
})

test("the effort is recalculated once the step interval is reached", async () => {
  const harness = setup({
    options: { recalc: { steps: 3 } },
    answerSequence: [{ effort: "low" }, { effort: "high" }],
  })
  await harness.router.onPrompt("ses_a", "hello")
  expect(harness.switched).toEqual([
    { sessionID: "ses_a", model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "low" } },
  ])

  harness.router.onStep("ses_a")
  harness.router.onStep("ses_a")
  expect(harness.requests).toHaveLength(1)

  harness.router.onStep("ses_a")
  await settle()
  expect(harness.requests).toHaveLength(2)
  expect(harness.requests[1]?.body.state).toContain("Agent steps since the last check: 3")
  expect(harness.switched).toEqual([
    { sessionID: "ses_a", model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "low" } },
    { sessionID: "ses_a", model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" } },
  ])
})

test("a session that the plugin does not manage never triggers a recalculation", async () => {
  const harness = setup({ options: { recalc: { steps: 1 } }, answers: { effort: "high" } })
  harness.router.onStep("ses_a")
  await settle()
  expect(harness.requests).toHaveLength(0)
  expect(harness.switched).toHaveLength(0)
})
