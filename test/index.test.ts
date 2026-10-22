import { afterEach, expect, test } from "bun:test"
import {
  effortCriteria,
  effortOptions,
  nearestEffort,
  resolveCandidates,
  resolveEffort,
  unionEffortOptions,
  type ModelInfo,
} from "../src/candidates"
import { EFFORT_LADDER, parseOptions, parseRef, sameRef } from "../src/options"
import { toCredential } from "../src/jev"

const model = (
  providerID: string,
  id: string,
  variants: string[] = [],
  context = 200_000,
): ModelInfo => ({
  id,
  providerID,
  name: id,
  variants: variants.map((variant) => ({ id: variant })),
  limit: { context },
})

const catalog = () => [
  model("anthropic", "claude-opus-5-5", ["low", "medium", "high", "xhigh", "max"]),
  model("anthropic", "claude-haiku-4-5"),
  model("openai", "gpt-6-luna", ["none", "low", "medium"]),
  model("opencode-go", "deepseek-v4.1-flash", ["low", "high", "max"]),
]

test("parseRef reads provider/model and provider/model#variant", () => {
  expect(parseRef("openai/gpt-6-luna")).toEqual({ providerID: "openai", id: "gpt-6-luna" })
  expect(parseRef("openai/gpt-6-luna#high")).toEqual({ providerID: "openai", id: "gpt-6-luna", variant: "high" })
  expect(parseRef("openai/gpt-6-luna#")).toBeUndefined()
  expect(parseRef("nope")).toBeUndefined()
  expect(parseRef("/leading")).toBeUndefined()
  expect(parseRef(42)).toBeUndefined()
})

test("sameRef compares provider and id, ignoring the variant", () => {
  expect(sameRef({ providerID: "a", id: "b", variant: "high" }, { providerID: "a", id: "b" })).toBe(true)
  expect(sameRef({ providerID: "a", id: "b" }, { providerID: "a", id: "c" })).toBe(false)
  expect(sameRef(undefined, { providerID: "a", id: "b" })).toBe(false)
})

test("parseOptions reads the worker whitelist", () => {
  const options = parseOptions({
    models: {
      "opencode-go/gpt-6-luna": "Cheap and fast.",
      "anthropic/claude-opus-5-5": "Expensive but strong.",
    },
  })
  expect(options.models).toEqual([
    { key: "opencode-go/gpt-6-luna", description: "Cheap and fast." },
    { key: "anthropic/claude-opus-5-5", description: "Expensive but strong." },
  ])
  expect(options.warnings).toEqual([])
})

test("parseOptions drops malformed model keys and says so", () => {
  const options = parseOptions({ models: { "no-slash": "x", "openai/gpt-6-luna": "y" } })
  expect(options.models).toEqual([{ key: "openai/gpt-6-luna", description: "y" }])
  expect(options.warnings).toEqual([`models: ignoring "no-slash", expected provider/model`])
})

test("parseOptions only accepts Jev deciders", () => {
  expect(parseOptions({ decider: "opencode/jev-1.14" }).decider).toEqual({ endpoint: "console", model: "jev-1.14" })
  expect(parseOptions({ decider: "openrouter/typesafe/jev-1.13" }).decider).toEqual({
    endpoint: "openrouter",
    model: "typesafe/jev-1.13",
  })
  const rejected = parseOptions({ decider: "openai/gpt-6-luna" })
  expect(rejected.decider).toBeUndefined()
  expect(rejected.warnings).toHaveLength(1)
})

test("parseOptions defaults the recalc interval to 30 and allows downgrade", () => {
  expect(parseOptions({}).steps).toBe(30)
  expect(parseOptions({}).allowDowngrade).toBe(true)
  expect(parseOptions({ recalc: { steps: 10 } }).steps).toBe(10)
  expect(parseOptions({ recalc: { steps: 10, allowDowngrade: false } }).allowDowngrade).toBe(false)
  expect(parseOptions({ recalc: { steps: 0 } }).steps).toBe(30)
  expect(parseOptions({ recalc: { steps: 0 } }).warnings).toHaveLength(1)
})

test("effortOptions keeps only ladder variants, in ladder order", () => {
  expect(effortOptions(model("openai", "gpt-6-luna", ["medium", "none", "low"]))).toEqual(["none", "low", "medium"])
  expect(effortOptions(model("anthropic", "claude-haiku-4-5", ["toggle"]))).toEqual([])
  expect(effortOptions(model("anthropic", "claude-opus-5-5", ["low", "medium", "high", "xhigh", "max"]))).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ])
})

test("unionEffortOptions merges candidates in ladder order", () => {
  expect(unionEffortOptions([model("a", "m1", ["high"]), model("b", "m2", ["none", "low"])])).toEqual([
    "none",
    "low",
    "high",
  ])
})

test("nearestEffort maps an effort onto the closest variant the model has", () => {
  expect(nearestEffort(model("openai", "gpt-6-luna", ["none", "low", "medium"]), "xhigh")).toBe("medium")
  expect(nearestEffort(model("openai", "gpt-6-luna", ["none", "low", "medium"]), "low")).toBe("low")
  expect(nearestEffort(model("anthropic", "claude-haiku-4-5"), "high")).toBeUndefined()
  expect(nearestEffort(model("openai", "gpt-6-luna", ["none"]), "high")).toBe("none")
})

test("effort descriptions are relative to the rungs the model offers", () => {
  const three = effortCriteria(["low", "high", "max"])
  expect(three.low).toMatch(/^Trivial only/)
  expect(three.high).toMatch(/^Ordinary work, and most requests belong here/)
  expect(three.max).toMatch(/^Genuinely hard/)

  const six = effortCriteria(["none", "low", "medium", "high", "xhigh", "max"])
  expect(six.none).toMatch(/^Trivial only/)
  expect(six.low).toMatch(/^Ordinary work, and most requests belong here/)
  expect(six.medium).toMatch(/^Harder work/)
  expect(six.xhigh).toMatch(/^Very hard/)
  expect(six.max).toMatch(/^Genuinely hard/)

  expect(effortCriteria(["low", "high"])).toEqual({
    low: expect.stringMatching(/^Trivial only/),
    high: expect.stringMatching(/^Ordinary work/),
  })
})

test("resolveCandidates drops models that are not in the catalog and reports them", () => {
  const { candidates, missing } = resolveCandidates(catalog(), [
    { key: "openai/gpt-6-luna", description: "cheap" },
    { key: "openai/gpt-9", description: "does not exist" },
    { key: "anthropic/claude-opus-5-5", description: "" },
  ])
  expect(candidates.map((candidate) => candidate.key)).toEqual(["openai/gpt-6-luna", "anthropic/claude-opus-5-5"])
  expect(missing).toEqual(["openai/gpt-9"])
  expect(candidates[1]?.description).toBe("claude-opus-5-5. 200k context.")
})

test("resolveEffort upgrades always and downgrades only when allowed", () => {
  const offered = [...EFFORT_LADDER]
  expect(resolveEffort("high", "low", offered, false)).toBe("high")
  expect(resolveEffort("low", "high", offered, false)).toBe("high")
  expect(resolveEffort("low", "high", offered, true)).toBe("low")
  expect(resolveEffort("low", undefined, offered, false)).toBe("low")
  expect(resolveEffort("low", "high", offered, true)).toBe("low")
})

test("resolveEffort rejects answers outside the offered options", () => {
  expect(resolveEffort("bogus", "low", ["low", "high"], true)).toBeUndefined()
  expect(resolveEffort(undefined, "low", ["low", "high"], true)).toBeUndefined()
})

test("toCredential pulls a token and org id, and refuses external credentials", () => {
  expect(toCredential({ type: "oauth", access: "token", metadata: { orgID: "org_1" } })).toEqual({
    token: "token",
    orgID: "org_1",
  })
  expect(toCredential({ type: "key", key: "sk-or" })).toEqual({ token: "sk-or", orgID: undefined })
  expect(toCredential({ type: "external" })).toBeUndefined()
  expect(toCredential(undefined)).toBeUndefined()
  expect(toCredential({ type: "oauth" })).toBeUndefined()
})
