import assert from "node:assert/strict"
import test from "node:test"

const {
  OpenCodeSessionBackend,
  SessionBackendError,
  SessionRunError,
  SessionTimeoutError,
  StructuredOutputError,
} = await import("../src/workflow/backend.ts")

const SESSION_ID = "child-1"

const userMessage = (overrides = {}) => ({
  info: {
    id: "user-1",
    sessionID: SESSION_ID,
    role: "user",
    time: { created: 100 },
    agent: "worker",
    model: { providerID: "anthropic", modelID: "claude" },
    summary: { diffs: [{ file: "src/a.ts", additions: 1, deletions: 0 }] },
    ...overrides,
  },
  parts: [
    { id: "p-user", sessionID: SESSION_ID, messageID: "user-1", type: "text", text: "Do the thing." },
  ],
})

const assistantMessage = (overrides = {}) => ({
  info: {
    id: "assist-1",
    sessionID: SESSION_ID,
    role: "assistant",
    time: { created: 200, completed: 260 },
    parentID: "user-1",
    agent: "worker",
    modelID: "claude",
    providerID: "anthropic",
    path: { cwd: "/base", root: "/base" },
    cost: 0.42,
    tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "done",
    structured: undefined,
    ...overrides,
  },
  parts: [
    { id: "p-assist", sessionID: SESSION_ID, messageID: "assist-1", type: "text", text: "Done." },
  ],
})

const createClient = (overrides = {}) => {
  const calls = {
    create: [],
    status: [],
    messages: [],
    abort: [],
    interrupt: [],
    prompt: [],
    wait: [],
    worktreeCreate: [],
    worktreeRemove: [],
    promptAsync: [],
  }
  let wtCount = 0
  const client = {
    session: {
      create: async (params) => {
        calls.create.push(params)
        return { data: { id: SESSION_ID, directory: params.directory ?? "/base", parentID: params.parentID } }
      },
      status: async (params) => {
        calls.status.push(params)
        return { data: { [SESSION_ID]: { type: "idle" } } }
      },
      messages: async (params) => {
        calls.messages.push(params)
        return { data: [userMessage(), assistantMessage()] }
      },
      abort: async (params) => {
        calls.abort.push(params)
        return { data: true }
      },
      promptAsync: async (params) => {
        calls.promptAsync.push(params)
        return { data: undefined }
      },
    },
    v2: {
      session: {
        prompt: async (params) => {
          calls.prompt.push(params)
          return {
            data: {
              id: "user-1",
              sessionID: SESSION_ID,
              timeCreated: 100,
              admittedSeq: 1,
              delivery: "queue",
              prompt: { text: params.prompt.text },
            },
          }
        },
        wait: async (params) => {
          calls.wait.push(params)
          return { data: undefined }
        },
        interrupt: async (params) => {
          calls.interrupt.push(params)
          return { data: undefined }
        },
      },
    },
    worktree: {
      create: async (params) => {
        calls.worktreeCreate.push(params)
        wtCount += 1
        const name = `wt-${wtCount}`
        return { data: { name, directory: `/base/.opencode/worktrees/${name}` } }
      },
      remove: async (params) => {
        calls.worktreeRemove.push(params)
        return { data: undefined }
      },
    },
    ...overrides,
  }
  return { client, calls }
}

const makeBackend = (client, options = {}) =>
  new OpenCodeSessionBackend(client, { directory: "/base", pollIntervalMs: 5, resultWaitMs: 25, ...options })

test("createSession forwards parentID, agent, model, variant, metadata, and permission", async () => {
  const { client, calls } = createClient()
  const backend = makeBackend(client)

  const handle = await backend.createSession({
    parentID: "parent-1",
    agent: "worker",
    model: "anthropic/claude-sonnet-4-6",
    variant: "high",
    title: "step",
    metadata: { workflowID: "wf-1", stepID: "step-1" },
    permission: [{ permission: "edit", pattern: "**", action: "allow" }],
  })

  assert.equal(handle.sessionID, SESSION_ID)
  assert.equal(handle.directory, "/base")
  assert.equal(handle.worktree, undefined)

  const params = calls.create[0]
  assert.equal(params.parentID, "parent-1")
  assert.equal(params.agent, "worker")
  assert.equal(params.title, "step")
  assert.deepEqual(params.model, {
    id: "claude-sonnet-4-6",
    providerID: "anthropic",
    variant: "high",
  })
  assert.deepEqual(params.metadata, { workflowID: "wf-1", stepID: "step-1" })
  assert.deepEqual(params.permission, [{ permission: "edit", pattern: "**", action: "allow" }])
  assert.equal(params.directory, "/base")
})

test("rejects createSession with a malformed model reference", async () => {
  const { client } = createClient()
  const backend = makeBackend(client)

  await assert.rejects(
    () => backend.createSession({ parentID: "parent-1", agent: "worker", model: "missing-provider" }),
    (error) => {
      assert.ok(error instanceof SessionBackendError)
      assert.match(error.message, /provider\/model-id/)
      return true
    },
  )
})

test("returns structured output, exact usage, session id, and files for a formatted run", async () => {
  const { client, calls } = createClient()
  client.session.messages = async (params) => {
    calls.messages.push(params)
    return { data: [userMessage(), assistantMessage({ structured: { ok: true } })] }
  }
  const backend = makeBackend(client)

  const result = await backend.run({
    sessionID: SESSION_ID,
    prompt: "Summarize",
    format: { type: "object", properties: { ok: { type: "boolean" } } },
  })

  assert.equal(result.sessionID, SESSION_ID)
  assert.deepEqual(result.structured, { ok: true })
  assert.equal(result.text, "Done.")
  assert.equal(result.cost, 0.42)
  assert.deepEqual(result.tokens, { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } })
  assert.deepEqual(result.files, ["src/a.ts"])
  assert.equal(result.finish, "done")

  assert.equal(calls.promptAsync.length, 1)
  assert.equal(calls.prompt.length, 0, "formatted runs must never call v2 session.prompt")
  assert.deepEqual(calls.promptAsync[0].parts, [{ type: "text", text: "Summarize" }])
  assert.deepEqual(calls.promptAsync[0].format, {
    type: "json_schema",
    schema: { type: "object", properties: { ok: { type: "boolean" } } },
  })
  assert.equal(calls.promptAsync[0].directory, "/base")
})

test("a formatted run requires session.promptAsync and rejects without it", async () => {
  const { client } = createClient()
  client.session.promptAsync = undefined
  const backend = makeBackend(client)

  await assert.rejects(
    () => backend.run({ sessionID: SESSION_ID, prompt: "Work", format: { type: "object" } }),
    (error) => {
      assert.ok(error instanceof SessionBackendError)
      assert.match(error.message, /promptAsync/)
      return true
    },
  )
})

test("an unformatted run prefers the durable v2 queue and passes no format", async () => {
  const { client, calls } = createClient()
  const backend = makeBackend(client)

  const result = await backend.run({ sessionID: SESSION_ID, prompt: "Just work" })

  assert.equal(result.text, "Done.")
  assert.equal(result.structured, undefined)
  assert.equal(calls.prompt.length, 1)
  assert.equal(calls.prompt[0].delivery, "queue")
  assert.deepEqual(calls.prompt[0].prompt, { text: "Just work" })
  assert.equal("format" in calls.prompt[0], false, "v2 session.prompt takes no format")
  assert.equal(calls.promptAsync.length, 0)
})

test("a created child runs through promptAsync with its agent, model, and variant", async () => {
  const { client, calls } = createClient()
  const backend = makeBackend(client)
  await backend.createSession({
    parentID: "parent-1",
    agent: "worker",
    model: "opencode-go/deepseek-v4-flash",
    variant: "high",
  })

  const result = await backend.run({ sessionID: SESSION_ID, prompt: "Work" })

  assert.equal(result.text, "Done.")
  assert.equal(calls.prompt.length, 0)
  assert.equal(calls.promptAsync.length, 1)
  assert.equal(calls.promptAsync[0].agent, "worker")
  assert.deepEqual(calls.promptAsync[0].model, {
    providerID: "opencode-go",
    modelID: "deepseek-v4-flash",
  })
  assert.equal(calls.promptAsync[0].variant, "high")
  assert.deepEqual(calls.promptAsync[0].parts, [{ type: "text", text: "Work" }])
})

test("preserves the SDK service binding when reading messages", async () => {
  const { client, calls } = createClient()
  client.session.status = async (params) => {
    calls.status.push(params)
    return { data: {} }
  }
  client.session.messages = async function (params) {
    assert.equal(this, client.session)
    calls.messages.push(params)
    return { data: [userMessage(), assistantMessage()] }
  }
  const backend = makeBackend(client)
  await backend.createSession({ parentID: "parent-1", agent: "worker" })

  const result = await backend.run({ sessionID: SESSION_ID, prompt: "Work" })

  assert.equal(result.text, "Done.")
  assert.ok(calls.messages.length >= 1)
})

test("waits via v2 session.wait without polling session.status", async () => {
  const { client, calls } = createClient()
  const backend = makeBackend(client)

  await backend.run({ sessionID: SESSION_ID, prompt: "Work" })

  assert.equal(calls.wait.length, 1)
  assert.deepEqual(calls.wait[0], { sessionID: SESSION_ID })
  assert.equal(calls.status.length, 0)
})

test("falls back to polling session.status until idle when v2 wait is unavailable", async () => {
  const { client, calls } = createClient()
  delete client.v2.session.wait

  let polls = 0
  client.session.status = async (params) => {
    calls.status.push(params)
    polls += 1
    if (polls < 3) return { data: { [SESSION_ID]: { type: "busy" } } }
    return { data: { [SESSION_ID]: { type: "idle" } } }
  }

  const backend = makeBackend(client)
  const result = await backend.run({ sessionID: SESSION_ID, prompt: "Work" })

  assert.equal(polls, 3)
  assert.equal(calls.wait.length, 0)
  assert.equal(calls.status.length, 3)
  assert.equal(result.text, "Done.")
})

test("falls back to status polling when session.wait is advertised but not implemented", async () => {
  const { client, calls } = createClient()
  client.v2.session.wait = async (params) => {
    calls.wait.push(params)
    return {
      error: { name: "NotImplementedError", data: { message: "Session wait is not available yet" } },
    }
  }

  const backend = makeBackend(client)
  const result = await backend.run({ sessionID: SESSION_ID, prompt: "Work" })

  assert.equal(calls.wait.length, 1)
  assert.equal(calls.status.length, 1)
  assert.equal(result.text, "Done.")
})

test("propagates structured-output errors from the completed message", async () => {
  const { client, calls } = createClient()
  client.session.messages = async (params) => {
    calls.messages.push(params)
    return {
      data: [
        userMessage(),
        assistantMessage({
          error: { name: "StructuredOutputError", data: { message: "schema mismatch", retries: 3 } },
        }),
      ],
    }
  }
  const backend = makeBackend(client)

  await assert.rejects(
    () => backend.run({ sessionID: SESSION_ID, prompt: "Work", format: { type: "object" } }),
    (error) => {
      assert.ok(error instanceof StructuredOutputError)
      assert.equal(error.retries, 3)
      assert.match(error.message, /schema mismatch/)
      return true
    },
  )
})

test("propagates provider errors from the completed message", async () => {
  const { client, calls } = createClient()
  client.session.messages = async (params) => {
    calls.messages.push(params)
    return {
      data: [
        userMessage(),
        assistantMessage({
          error: { name: "ProviderAuthError", data: { providerID: "anthropic", message: "unauthorized" } },
        }),
      ],
    }
  }
  const backend = makeBackend(client)

  await assert.rejects(
    () => backend.run({ sessionID: SESSION_ID, prompt: "Work" }),
    (error) => {
      assert.ok(error instanceof SessionRunError)
      assert.equal(error.code, "ProviderAuthError")
      assert.match(error.message, /unauthorized/)
      return true
    },
  )
})

test("rejects when the completed message reports a failed finish", async () => {
  const { client, calls } = createClient()
  client.session.messages = async (params) => {
    calls.messages.push(params)
    return { data: [userMessage(), assistantMessage({ finish: "error", error: undefined })] }
  }
  const backend = makeBackend(client)

  await assert.rejects(
    () => backend.run({ sessionID: SESSION_ID, prompt: "Work" }),
    (error) => {
      assert.ok(error instanceof SessionRunError)
      assert.equal(error.code, "message-error")
      return true
    },
  )
})

test("times out with AbortController semantics and interrupts the session", async () => {
  const { client, calls } = createClient()
  client.v2.session.wait = () => new Promise(() => {})
  const backend = makeBackend(client)

  await assert.rejects(
    () => backend.run({ sessionID: SESSION_ID, prompt: "Work", timeoutMs: 15 }),
    (error) => {
      assert.ok(error instanceof SessionTimeoutError)
      assert.equal(error.sessionID, SESSION_ID)
      assert.equal(error.timeoutMs, 15)
      return true
    },
  )

  assert.equal(calls.interrupt.length, 1)
  assert.deepEqual(calls.interrupt[0], { sessionID: SESSION_ID })
  assert.equal(calls.abort.length, 0)
})

test("falls back to session.abort when v2 interrupt is unavailable on timeout", async () => {
  const { client, calls } = createClient()
  delete client.v2.session.interrupt
  client.v2.session.wait = () => new Promise(() => {})
  const backend = makeBackend(client)

  await assert.rejects(
    () => backend.run({ sessionID: SESSION_ID, prompt: "Work", timeoutMs: 15 }),
    SessionTimeoutError,
  )

  assert.equal(calls.abort.length, 1)
  assert.deepEqual(calls.abort[0], { sessionID: SESSION_ID, directory: "/base" })
})

test("honors external cancellation and cancels the session", async () => {
  const { client, calls } = createClient()
  client.v2.session.wait = () => new Promise(() => {})
  const backend = makeBackend(client)
  const controller = new AbortController()

  const promise = backend.run({ sessionID: SESSION_ID, prompt: "Work", signal: controller.signal })
  setTimeout(() => controller.abort(), 10)

  await assert.rejects(promise, (error) => {
    assert.equal(error.name, "AbortError")
    return true
  })
  assert.equal(calls.interrupt.length, 1)
})

test("explicit cancel interrupts the session", async () => {
  const { client, calls } = createClient()
  const backend = makeBackend(client)

  await backend.cancel(SESSION_ID)
  assert.equal(calls.interrupt.length, 1)
  assert.deepEqual(calls.interrupt[0], { sessionID: SESSION_ID })
})

test("creates a session in a fresh worktree and removes it on dispose", async () => {
  const { client, calls } = createClient()
  const backend = makeBackend(client)

  const handle = await backend.createSession({
    parentID: "parent-1",
    agent: "worker",
    worktree: { name: "iso" },
  })

  assert.equal(handle.worktree.name, "wt-1")
  assert.equal(handle.worktree.directory, "/base/.opencode/worktrees/wt-1")
  assert.equal(handle.directory, "/base/.opencode/worktrees/wt-1")
  assert.deepEqual(calls.worktreeCreate[0].worktreeCreateInput, { name: "iso" })
  assert.equal(calls.create[0].directory, "/base/.opencode/worktrees/wt-1")

  await backend.dispose()

  assert.equal(calls.worktreeRemove.length, 1)
  assert.deepEqual(calls.worktreeRemove[0].worktreeRemoveInput, {
    directory: "/base/.opencode/worktrees/wt-1",
  })
})

test("removes a created worktree when session creation fails", async () => {
  const { client, calls } = createClient()
  client.session.create = async (params) => {
    calls.create.push(params)
    return { data: undefined, error: { _tag: "BadRequest", message: "boom" } }
  }
  const backend = makeBackend(client)

  await assert.rejects(
    () => backend.createSession({ parentID: "parent-1", agent: "worker", worktree: true }),
    (error) => {
      assert.ok(error instanceof SessionRunError)
      assert.equal(error.code, "BadRequest")
      return true
    },
  )

  assert.equal(calls.worktreeRemove.length, 1)
  assert.equal(calls.worktreeCreate.length, 1)
})

test("dispose is idempotent and never double-removes worktrees", async () => {
  const { client, calls } = createClient()
  const backend = makeBackend(client)

  await backend.createSession({ parentID: "parent-1", agent: "worker", worktree: true })
  await backend.dispose()
  await backend.dispose()

  assert.equal(calls.worktreeRemove.length, 1)
})

test("tracks each session's actual directory for status, messages, and abort", async () => {
  const { client, calls } = createClient()
  delete client.v2.session.wait
  delete client.v2.session.interrupt
  client.session.status = async (params) => {
    calls.status.push(params)
    return { data: { [SESSION_ID]: { type: "idle" } } }
  }
  client.session.messages = async (params) => {
    calls.messages.push(params)
    return { data: [userMessage(), assistantMessage()] }
  }
  const backend = makeBackend(client)

  const handle = await backend.createSession({
    parentID: "parent-1",
    agent: "worker",
    worktree: { name: "iso" },
  })
  const worktreeDir = handle.directory
  assert.equal(worktreeDir, "/base/.opencode/worktrees/wt-1")

  await backend.run({ sessionID: SESSION_ID, prompt: "Work", format: { type: "object" } })

  assert.equal(calls.promptAsync[0].directory, worktreeDir, "promptAsync uses the worktree dir")
  assert.equal(calls.status[0].directory, worktreeDir, "status polling uses the worktree dir")
  assert.equal(calls.messages[0].directory, worktreeDir, "messages use the worktree dir")

  await backend.cancel(SESSION_ID)
  assert.equal(calls.abort[0].directory, worktreeDir, "abort fallback uses the worktree dir")
})

test("releaseSession(handle) removes only that session's worktree without disposing", async () => {
  const { client, calls } = createClient()
  const backend = makeBackend(client)

  const a = await backend.createSession({ parentID: "p1", agent: "worker", worktree: { name: "wt-a" } })
  const b = await backend.createSession({ parentID: "p2", agent: "worker", worktree: { name: "wt-b" } })

  await backend.releaseSession(a)
  assert.equal(calls.worktreeRemove.length, 1)
  assert.deepEqual(calls.worktreeRemove[0].worktreeRemoveInput, { directory: a.worktree.directory })

  await backend.dispose()
  assert.equal(calls.worktreeRemove.length, 2)
  assert.deepEqual(calls.worktreeRemove[1].worktreeRemoveInput, { directory: b.worktree.directory })
})

test("releaseSession(sessionID) finds and removes the session's worktree", async () => {
  const { client, calls } = createClient()
  const backend = makeBackend(client)

  const handle = await backend.createSession({ parentID: "p1", agent: "worker", worktree: true })
  await backend.releaseSession(handle.sessionID)

  assert.equal(calls.worktreeRemove.length, 1)
  assert.deepEqual(calls.worktreeRemove[0].worktreeRemoveInput, { directory: handle.worktree.directory })

  await backend.dispose()
  assert.equal(calls.worktreeRemove.length, 1, "releaseSession must not be double-removed on dispose")
})

test("releaseSession is a no-op for sessions without a worktree and is idempotent", async () => {
  const { client, calls } = createClient()
  const backend = makeBackend(client)

  const handle = await backend.createSession({ parentID: "p1", agent: "worker" })
  assert.equal(handle.worktree, undefined)

  await backend.releaseSession(handle)
  await backend.releaseSession(handle.sessionID)
  assert.equal(calls.worktreeRemove.length, 0)

  await backend.dispose()
  assert.equal(calls.worktreeRemove.length, 0)
})

test("correlates the completed assistant message with the admitted prompt", async () => {
  const { client, calls } = createClient()
  client.session.messages = async (params) => {
    calls.messages.push(params)
    return {
      data: [
        userMessage({ id: "user-0", time: { created: 50 } }),
        assistantMessage({
          id: "assist-0",
          parentID: "user-0",
          time: { created: 60 },
          cost: 9,
          structured: { old: true },
          parts: [{ id: "p0", sessionID: SESSION_ID, messageID: "assist-0", type: "text", text: "OLD" }],
        }),
        userMessage(),
        assistantMessage({ structured: { ok: true } }),
      ],
    }
  }
  const backend = makeBackend(client)

  const result = await backend.run({ sessionID: SESSION_ID, prompt: "Work" })

  assert.equal(result.text, "Done.")
  assert.deepEqual(result.structured, { ok: true })
  assert.equal(result.cost, 0.42)
  assert.deepEqual(result.files, ["src/a.ts"])
})

test("waits for the correlated assistant message to be completed", async () => {
  const { client, calls } = createClient()
  let reads = 0
  client.session.messages = async (params) => {
    calls.messages.push(params)
    reads += 1
    return {
      data: [
        userMessage(),
        reads === 1
          ? assistantMessage({ time: { created: 200 } })
          : assistantMessage(),
      ],
    }
  }
  const backend = makeBackend(client)

  const result = await backend.run({ sessionID: SESSION_ID, prompt: "Work" })

  assert.equal(result.text, "Done.")
  assert.equal(reads, 2)
})

test("tolerates bare (non-enveloped) responses from the client", async () => {
  const { client, calls } = createClient()
  client.v2.session.prompt = async (params) => {
    calls.prompt.push(params)
    return { id: "user-1", sessionID: SESSION_ID, timeCreated: 100 }
  }
  client.v2.session.wait = async () => {
    calls.wait.push(true)
    return undefined
  }
  client.session.status = async () => {
    calls.status.push(true)
    return { [SESSION_ID]: { type: "idle" } }
  }
  client.session.messages = async () => {
    calls.messages.push(true)
    return [userMessage(), assistantMessage()]
  }
  const backend = makeBackend(client)

  const result = await backend.run({ sessionID: SESSION_ID, prompt: "Work" })

  assert.equal(result.text, "Done.")
  assert.equal(calls.wait.length, 1)
  assert.equal(calls.status.length, 0)
})

test("propagates envelope errors from the prompt call", async () => {
  const { client } = createClient()
  client.v2.session.prompt = async () => ({
    data: undefined,
    error: { _tag: "SessionNotFoundError", sessionID: SESSION_ID, message: "nope" },
  })
  const backend = makeBackend(client)

  await assert.rejects(
    () => backend.run({ sessionID: SESSION_ID, prompt: "Work" }),
    (error) => {
      assert.ok(error instanceof SessionRunError)
      assert.equal(error.code, "SessionNotFoundError")
      return true
    },
  )
})

test("propagates legacy promptAsync error envelopes for structured output", async () => {
  const { client } = createClient()
  client.session.promptAsync = async () => ({
    error: { name: "APIError", data: { message: "structured admission rejected", isRetryable: false } },
  })
  const backend = makeBackend(client)
  await backend.createSession({ parentID: "parent", agent: "worker" })

  await assert.rejects(
    () => backend.run({ sessionID: SESSION_ID, prompt: "structured", format: { type: "object" } }),
    (error) => {
      assert.ok(error instanceof SessionRunError)
      assert.match(error.message, /structured admission rejected/)
      return true
    },
  )
})

test("falls back to session.promptAsync for unformatted prompts when v2 prompt is unavailable", async () => {
  const { client, calls } = createClient()
  client.v2.session.prompt = undefined
  const backend = makeBackend(client)

  const result = await backend.run({ sessionID: SESSION_ID, prompt: "Work" })

  assert.equal(calls.promptAsync.length, 1)
  assert.deepEqual(calls.promptAsync[0].parts, [{ type: "text", text: "Work" }])
  assert.equal(calls.promptAsync[0].format, undefined)
  assert.equal(calls.promptAsync[0].directory, "/base")
  assert.equal(result.text, "Done.")
})

test("a multi-slash model keeps the route in id and the first segment as provider", async () => {
  const { client, calls } = createClient()
  const backend = makeBackend(client)

  await backend.createSession({
    parentID: "parent-1",
    agent: "worker",
    model: "openrouter/anthropic/claude-sonnet",
  })

  assert.deepEqual(calls.create[0].model, {
    id: "anthropic/claude-sonnet",
    providerID: "openrouter",
  })
})

test("rejects when no completed assistant message answers the prompt", async () => {
  const { client, calls } = createClient()
  client.session.messages = async (params) => {
    calls.messages.push(params)
    return { data: [userMessage()] }
  }
  const backend = makeBackend(client)

  await assert.rejects(
    () => backend.run({ sessionID: SESSION_ID, prompt: "Work" }),
    (error) => {
      assert.ok(error instanceof SessionBackendError)
      assert.match(error.message, /no completed assistant message/)
      return true
    },
  )
})

test("a disposed backend rejects further createSession and run calls", async () => {
  const { client } = createClient()
  const backend = makeBackend(client)

  await backend.dispose()

  await assert.rejects(() => backend.createSession({ parentID: "p", agent: "worker" }), SessionBackendError)
  await assert.rejects(() => backend.run({ sessionID: SESSION_ID, prompt: "Work" }), SessionBackendError)
})

test("rejects invalid constructor inputs", async () => {
  const { client } = createClient()
  assert.throws(() => new OpenCodeSessionBackend({}, { directory: "/base" }), SessionBackendError)
  assert.throws(
    () => new OpenCodeSessionBackend(client, { directory: "" }),
    SessionBackendError,
  )
  assert.throws(
    () => new OpenCodeSessionBackend(client, { directory: "/base", pollIntervalMs: 0 }),
    SessionBackendError,
  )
})
