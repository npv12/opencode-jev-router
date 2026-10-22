import type { Plugin } from "@opencode/plugin"
import { parseOptions } from "./options"
import { createRouter } from "./router"

type FailureEvent = { type: string; data?: { sessionID?: string; text?: string } }

// `Plugin.define` is the identity function, so the type-only import keeps the plugin free of a
// runtime dependency and it loads without an install step.
const plugin: Plugin.Plugin = {
  id: "jev-router",
  async setup(ctx) {
    const options = parseOptions(ctx.options)
    for (const warning of options.warnings) console.error("opencode-jev-router:", warning)
    if (options.models.length === 0) {
      console.error("opencode-jev-router: no worker models configured, workers will keep their inherited model")
    }

    const router = createRouter(ctx, options)

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const failure = event as FailureEvent
        if (failure.type !== "session.step.failed" && failure.type !== "session.tool.failed") continue
        if (!failure.data?.sessionID) continue
        router.noteFailure(failure.data.sessionID, failure.data.text)
      }
    })()

    await ctx.session.hook("prompt", async (event) => {
      await router.onPrompt(String(event.sessionID), event.prompt.text)
    })

    await ctx.session.hook("context", async (event) => {
      router.onStep(String(event.sessionID))
    })

    return () => controller.abort()
  },
}

export default plugin
