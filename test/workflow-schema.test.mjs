import assert from "node:assert/strict"
import test from "node:test"

import {
  evaluateCondition,
  parseReference,
  renderTemplate,
  resolveReference,
  validateWorkflowSpec,
  WorkflowValidationError,
} from "../src/workflow/schema.ts"

const baseSpec = () => ({
  version: 1,
  name: "demo",
  description: "A demo workflow",
  labels: ["research", "delivery"],
  phases: {
    research: { label: "Research" },
    build: { label: "Build" },
  },
  limits: {
    maxParallel: 2,
    maxAgents: 4,
    maxIterations: 10,
    maxTokens: 5000,
    maxCost: 1.5,
    deadline: "2026-12-31T23:59:59Z",
  },
  steps: [
    {
      id: "gather",
      type: "agent",
      agent: "explore",
      model: "provider/research",
      variant: "low",
      prompt: "Research the topic.",
      outputSchema: { type: "object" },
      retry: 1,
      timeout: 30,
      isolation: true,
      phase: "research",
      labels: ["fetch"],
    },
    {
      id: "split",
      type: "map",
      over: "gather.items",
      as: "item",
      phase: "research",
      steps: [
        {
          id: "per-item",
          type: "agent",
          agent: "worker",
          prompt: "Process {{ item.content }}.",
        },
      ],
    },
    {
      id: "verify",
      type: "branch",
      phase: "build",
      cases: [
        {
          id: "empty",
          when: { $ref: "gather.items" },
          steps: [
            {
              id: "refill",
              type: "synthesize",
              prompt: "Regenerate from {{ gather.title }}.",
              input: ["gather"],
              retry: 2,
              timeout: 60,
            },
          ],
        },
        {
          id: "has-data",
          when: { $gt: [{ $ref: "gather.count" }, 0] },
          steps: [{ id: "refine", type: "agent", agent: "worker", prompt: "Refine.", isolation: true }],
        },
      ],
      otherwise: [{ id: "fallback", type: "synthesize", prompt: "Summarize." }],
    },
    {
      id: "iterate",
      type: "loop",
      over: "gather.items",
      as: "item",
      until: { $gte: [{ $ref: "item.score" }, 10] },
      steps: [{ id: "score", type: "agent", agent: "worker", prompt: "Score {{ item.value }}." }],
      dependsOn: ["verify"],
    },
    {
      id: "final",
      type: "synthesize",
      agent: "general",
      prompt: "Synthesize {{ gather }} and {{ score.output }}.",
      input: ["gather", "score"],
      outputSchema: { type: "string" },
      retry: 3,
      timeout: 120,
      isolation: true,
      dependsOn: ["iterate"],
    },
  ],
})

const expectError = (fn, pathPattern, messagePattern) => {
  assert.throws(
    () => {
      const result = fn()
      return result
    },
    (error) => {
      assert.ok(error instanceof WorkflowValidationError, `expected WorkflowValidationError, got ${error}`)
      if (pathPattern) assert.match(error.path, pathPattern)
      if (messagePattern) assert.match(error.message, messagePattern)
      return true
    },
  )
}

test("validates a full v1 spec with every step type and returns normalized output", () => {
  const raw = baseSpec()
  const wf = validateWorkflowSpec(raw)

  assert.equal(wf.version, 1)
  assert.equal(wf.spec.name, "demo")
  assert.deepEqual(wf.spec.labels, ["research", "delivery"])
  assert.equal(wf.spec.limits.maxParallel, 2)
  assert.equal(wf.spec.limits.deadline, "2026-12-31T23:59:59Z")
  assert.deepEqual(wf.limits, {
    maxParallel: 2,
    maxAgents: 4,
    maxIterations: 10,
    maxTokens: 5000,
    maxCost: 1.5,
    deadline: "2026-12-31T23:59:59Z",
  })

  assert.equal(wf.steps.length, 10)
  for (const id of ["gather", "split", "per-item", "verify", "refill", "refine", "fallback", "iterate", "score", "final"]) {
    assert.ok(wf.byId[id], `missing step ${id}`)
  }

  assert.equal(wf.byId.gather.agent, "explore")
  assert.equal(wf.byId.gather.model, "provider/research")
  assert.equal(wf.byId.gather.retry, 1)
  assert.equal(wf.byId.gather.timeout, 30)
  assert.equal(wf.byId.gather.isolation, true)
  assert.equal(wf.byId.gather.outputSchema.type, "object")
  assert.equal(wf.byId.split.as, "item")
  assert.equal(wf.byId.iterate.until.$gte[0].$ref, "item.score")
  assert.equal(wf.byId.final.agent, "general")

  assert.equal(wf.order.length, 10)
  assert.equal(new Set(wf.order).size, 10, "order must list every step exactly once")
  for (const [to, deps] of Object.entries(wf.dependencies)) {
    for (const from of deps) {
      assert.ok(
        wf.order.indexOf(from) < wf.order.indexOf(to),
        `${from} must be ordered before ${to}`,
      )
    }
  }
  for (const [from, to] of [
    ["gather", "split"],
    ["gather", "verify"],
    ["verify", "iterate"],
    ["iterate", "final"],
    ["score", "final"],
    ["gather", "final"],
  ]) {
    assert.ok(wf.order.indexOf(from) < wf.order.indexOf(to), `${from} must precede ${to}`)
  }
  assert.deepEqual(wf.dependencies.final, ["gather", "iterate", "score"])
  assert.ok(wf.dependents.gather.includes("final"))
})

test("fills default limits and keeps optional ones absent", () => {
  const wf = validateWorkflowSpec({ version: 1, steps: [{ id: "a", type: "agent", agent: "x", prompt: "Do." }] })
  assert.deepEqual(wf.limits, { maxParallel: 4, maxAgents: 8, maxIterations: 100 })
  assert.equal(wf.spec.limits.maxParallel, undefined)
})

test("returns a deeply immutable normalized output that never aliases input", () => {
  const raw = baseSpec()
  const wf = validateWorkflowSpec(raw)

  assert.notEqual(wf.spec.steps, raw.steps)
  assert.notEqual(wf.spec.steps[0], raw.steps[0])
  assert.notEqual(wf.byId.iterate.until, raw.steps[3].until)
  assert.equal(Object.isFrozen(wf.spec.steps[0]), true)
  assert.equal(Object.isFrozen(wf.byId.iterate.until), true)
  assert.equal(Object.isFrozen(raw.steps[0]), false, "input objects must not be frozen")
  assert.equal(Object.isFrozen(wf.order), true)
  assert.equal(Object.isFrozen(wf.dependencies), true)
  assert.equal(Object.isFrozen(wf.dependencies.final), true)

  assert.throws(() => {
    wf.spec.steps[0].prompt = "changed"
  }, TypeError)
  assert.throws(() => {
    wf.spec.steps.push({ id: "extra", type: "agent", agent: "x", prompt: "Do." })
  }, TypeError)
  assert.throws(() => {
    wf.order.push("extra")
  }, TypeError)
  assert.throws(() => {
    wf.byId.gather.labels.push("x")
  }, TypeError)
})

test("rejects missing, wrong, and malformed versions", () => {
  expectError(() => validateWorkflowSpec({ steps: [] }), /\$\.version/, /exactly 1/)
  expectError(() => validateWorkflowSpec({ version: 2, steps: [] }), /\$\.version/, /exactly 1/)
  expectError(() => validateWorkflowSpec({ version: "1", steps: [] }), /\$\.version/, /exactly 1/)
})

test("rejects unknown top-level and step keys (allowlists)", () => {
  expectError(() => validateWorkflowSpec({ version: 1, steps: [], bogus: 1 }), /\$\.bogus/, /not a supported top-level key/)
  expectError(
    () => validateWorkflowSpec({ version: 1, steps: [{ id: "a", type: "agent", agent: "x", prompt: "Do.", bogus: 1 }] }),
    /\$\.steps\[0\]/,
    /unknown key "bogus"/,
  )
  expectError(
    () => validateWorkflowSpec({ version: 1, steps: [{ id: "a", type: "sequence", steps: [], extra: true }] }),
    /\$\.steps\[0\]/,
    /unknown key "extra"/,
  )
})

test("rejects unknown step types", () => {
  expectError(
    () => validateWorkflowSpec({ version: 1, steps: [{ id: "a", type: "teleport", agent: "x", prompt: "Do." }] }),
    /\$\.steps\[0\]\.type/,
    /one of agent, sequence, parallel, map, loop, branch, synthesize/,
  )
})

test("enforces globally unique step ids including nested steps", () => {
  const raw = baseSpec()
  raw.steps[0].id = "dup"
  raw.steps[1].steps[0].id = "dup"
  expectError(() => validateWorkflowSpec(raw), /\$\.steps\[1\]\.steps\[0\]/, /duplicate step id "dup"/)
})

test("enforces identifier grammar on step ids", () => {
  expectError(
    () => validateWorkflowSpec({ version: 1, steps: [{ id: "1bad", type: "agent", agent: "x", prompt: "Do." }] }),
    /\$\.steps\[0\]\.id/,
    /must match/,
  )
  expectError(
    () => validateWorkflowSpec({ version: 1, steps: [{ id: "", type: "agent", agent: "x", prompt: "Do." }] }),
    /\$\.steps\[0\]\.id/,
    /non-empty string/,
  )
})

test("rejects references to unknown steps and self references", () => {
  expectError(
    () => validateWorkflowSpec({ version: 1, steps: [{ id: "a", type: "agent", agent: "x", prompt: "Use {{ nope.field }}." }] }),
    /\$\.steps\[0\]\.prompt/,
    /does not match any step id/,
  )
  expectError(
    () => validateWorkflowSpec({ version: 1, steps: [{ id: "a", type: "agent", agent: "x", prompt: "Use {{ a.own }}." }] }),
    /\$\.steps\[0\]\.prompt/,
    /cannot reference itself/,
  )
})

test("rejects references to ancestor and descendant steps", () => {
  const ancestorRaw = {
    version: 1,
    steps: [
      {
        id: "p",
        type: "parallel",
        steps: [
          { id: "child", type: "agent", agent: "x", prompt: "Use {{ p.result }}." },
        ],
      },
    ],
  }
  expectError(() => validateWorkflowSpec(ancestorRaw), /\$\.steps\[0\]\.steps\[0\]\.prompt/, /ancestor step "p"/)

  const descendantRaw = {
    version: 1,
    steps: [
      {
        id: "m",
        type: "map",
        over: "inner",
        as: "it",
        steps: [{ id: "inner", type: "agent", agent: "x", prompt: "Do." }],
      },
    ],
  }
  expectError(() => validateWorkflowSpec(descendantRaw), /\$\.steps\[0\]\.over/, /descendant step "inner"/)
})

test("rejects invalid dependsOn entries", () => {
  expectError(
    () => validateWorkflowSpec({ version: 1, steps: [{ id: "a", type: "agent", agent: "x", prompt: "Do.", dependsOn: ["missing"] }] }),
    /\$\.steps\[0\]\.dependsOn/,
    /does not match any step id/,
  )
  expectError(
    () => validateWorkflowSpec({ version: 1, steps: [{ id: "a", type: "agent", agent: "x", prompt: "Do.", dependsOn: ["a"] }] }),
    /\$\.steps\[0\]\.dependsOn/,
    /cannot depend on itself/,
  )
  const ancestorDep = {
    version: 1,
    steps: [
      {
        id: "p",
        type: "sequence",
        steps: [{ id: "child", type: "agent", agent: "x", prompt: "Do.", dependsOn: ["p"] }],
      },
    ],
  }
  expectError(() => validateWorkflowSpec(ancestorDep), /\$\.steps\[0\]\.steps\[0\]\.dependsOn/, /ancestor step "p"/)
})

test("detects dependency cycles and reports the cycle path", () => {
  const raw = {
    version: 1,
    steps: [
      { id: "a", type: "agent", agent: "x", prompt: "Do.", dependsOn: ["b"] },
      { id: "b", type: "agent", agent: "x", prompt: "Do.", dependsOn: ["a"] },
    ],
  }
  expectError(() => validateWorkflowSpec(raw), /\$/, /dependency cycle detected: a -> b -> a/)

  const laterSibling = {
    version: 1,
    steps: [
      {
        id: "seq",
        type: "sequence",
        steps: [
          { id: "first", type: "agent", agent: "x", prompt: "Use {{ second.out }}." },
          { id: "second", type: "agent", agent: "x", prompt: "Do." },
        ],
      },
    ],
  }
  expectError(() => validateWorkflowSpec(laterSibling), /\$/, /dependency cycle detected/)
})

test("validates reference-only ordering: earlier siblings may be referenced", () => {
  const raw = {
    version: 1,
    steps: [
      {
        id: "seq",
        type: "sequence",
        steps: [
          { id: "first", type: "agent", agent: "x", prompt: "Do." },
          { id: "second", type: "agent", agent: "x", prompt: "Use {{ first.out }}." },
        ],
      },
    ],
  }
  const wf = validateWorkflowSpec(raw)
  assert.ok(wf.dependencies.second.includes("first"))
})

test("rejects non-empty reference/sequence container requirements", () => {
  expectError(
    () => validateWorkflowSpec({ version: 1, steps: [{ id: "seq", type: "sequence", steps: [] }] }),
    /\$\.steps\[0\]\.steps/,
    /non-empty/,
  )
  expectError(
    () => validateWorkflowSpec({ version: 1, steps: [{ id: "p", type: "parallel", steps: undefined }] }),
    /\$\.steps\[0\]\.steps/,
    /non-empty/,
  )
})

test("enforces numeric bounds on limits, retry, timeout, and parallel caps", () => {
  const cases = [
    [{ ...baseSpec(), limits: { ...baseSpec().limits, maxParallel: 0 } }, /maxParallel/, /integer >= 1/],
    [{ ...baseSpec(), limits: { ...baseSpec().limits, maxParallel: 1.5 } }, /maxParallel/, /integer >= 1/],
    [{ ...baseSpec(), limits: { ...baseSpec().limits, maxAgents: -1 } }, /maxAgents/, /integer >= 1/],
    [{ ...baseSpec(), limits: { ...baseSpec().limits, maxIterations: 0 } }, /maxIterations/, /integer >= 1/],
    [{ ...baseSpec(), limits: { ...baseSpec().limits, maxTokens: 0 } }, /maxTokens/, /integer >= 1/],
    [{ ...baseSpec(), limits: { ...baseSpec().limits, maxTokens: 2.5 } }, /maxTokens/, /integer >= 1/],
    [{ ...baseSpec(), limits: { ...baseSpec().limits, maxCost: -0.5 } }, /maxCost/, /finite number >= 0/],
    [{ ...baseSpec(), limits: { ...baseSpec().limits, maxParallel: "4" } }, /maxParallel/, /integer >= 1/],
    [{ ...baseSpec(), limits: { ...baseSpec().limits, deadline: "soon" } }, /deadline/, /ISO 8601/],
  ]
  for (const [spec, pathPattern, messagePattern] of cases) {
    expectError(() => validateWorkflowSpec(spec), pathPattern, messagePattern)
  }

  const retryRaw = baseSpec()
  retryRaw.steps[0].retry = -1
  expectError(() => validateWorkflowSpec(retryRaw), /\$\.steps\[0\]\.retry/, /integer >= 0/)
  const retryFloat = baseSpec()
  retryFloat.steps[0].retry = 1.5
  expectError(() => validateWorkflowSpec(retryFloat), /\$\.steps\[0\]\.retry/, /integer >= 0/)
  const timeoutZero = baseSpec()
  timeoutZero.steps[0].timeout = 0
  expectError(() => validateWorkflowSpec(timeoutZero), /\$\.steps\[0\]\.timeout/, /finite number > 0/)
  const parallelRaw = baseSpec()
  parallelRaw.steps.push({
    id: "wide",
    type: "parallel",
    maxParallel: 3,
    steps: [{ id: "leaf", type: "agent", agent: "x", prompt: "Do." }],
  })
  expectError(() => validateWorkflowSpec(parallelRaw), /\$\.steps\[5\]\.maxParallel/, /workflow maxParallel of 2/)
})

test("validates safe prompt templates", () => {
  const makeStep = (prompt) => ({ version: 1, steps: [{ id: "a", type: "agent", agent: "x", prompt }] })
  const badTemplates = [
    ["Use {{ gather.", "unterminated"],
    ["Use {{ gather }} then }} more", "stray"],
    ["Text }} early", "stray"],
    ["Use {{ }}.", "empty"],
    ["Use {{ {{ gather }} }}.", "nested"],
    ["Use {{ gather.output + 1 }}.", "invalid path segment"],
    ["Use {{ gather .output }}.", "invalid reference root"],
    ["Use {{ nope.field }}.", "does not match any step id"],
  ]
  for (const [prompt, message] of badTemplates) {
    expectError(() => validateWorkflowSpec(makeStep(prompt)), /\$\.steps\[0\]\.prompt/, new RegExp(message))
  }

  const wf = validateWorkflowSpec(
    {
      version: 1,
      steps: [
        { id: "gather", type: "agent", agent: "x", prompt: "Do." },
        { id: "use", type: "agent", agent: "x", prompt: "Use {{ gather }} and {{ gather.items[0].name }}." },
      ],
    },
  )
  assert.ok(wf.byId.use)
})

test("supports loop variables inside map/loop bodies and until conditions", () => {
  const wf = validateWorkflowSpec({
    version: 1,
    steps: [
      { id: "rows", type: "agent", agent: "x", prompt: "Return rows." },
      {
        id: "m",
        type: "map",
        over: "rows.data",
        as: "item",
        steps: [
          {
            id: "inner",
            type: "loop",
            over: "rows.data",
            as: "entry",
            until: { $gt: [{ $ref: "entry.n" }, { $ref: "item.limit" }] },
            steps: [{ id: "leaf", type: "agent", agent: "x", prompt: "Use {{ entry.key }} and {{ item.base }}." }],
          },
        ],
      },
    ],
  })
  assert.equal(wf.byId.inner.as, "entry")
  assert.ok(wf.byId.leaf)
})

test("rejects loop-variable collisions with step ids", () => {
  const raw = {
    version: 1,
    steps: [
      { id: "item", type: "agent", agent: "x", prompt: "Do." },
      { id: "m", type: "map", over: "item.list", as: "item", steps: [{ id: "leaf", type: "agent", agent: "x", prompt: "Do." }] },
    ],
  }
  expectError(() => validateWorkflowSpec(raw), /\$\.steps\[1\]\.as/, /collides with step id "item"/)
})

test("rejects loop as without over and validates loop until conditions", () => {
  expectError(
    () =>
      validateWorkflowSpec({
        version: 1,
        steps: [{ id: "l", type: "loop", as: "item", steps: [{ id: "leaf", type: "agent", agent: "x", prompt: "Do." }] }],
      }),
    /\$\.steps\[0\]\.as/,
    /requires "over"/,
  )
  const raw = baseSpec()
  raw.steps[3].until = { $and: [] }
  expectError(() => validateWorkflowSpec(raw), /\$\.steps\[3\]\.until/, /non-empty array of conditions/)
})

test("validates branch case conditions and ids", () => {
  const invalidConditions = [
    [{ $and: [] }, /\$and/, /non-empty array of conditions/],
    [{ $eq: [1] }, /\$eq/, /2-element/],
    [{ $frob: true }, /unknown condition operator/],
    [{ $ref: "x", $eq: [1, 2] }, /exactly one operator/],
    [{ $lt: ["a", 1] }, /\$lt/, /numeric operands/],
    [{ $not: { $and: [] } }, /\$not/, /non-empty array of conditions/],
    [{ $ref: 42 }, /\$ref/, /non-empty string/],
  ]
  for (const [condition, pathPattern, messagePattern] of invalidConditions) {
    const raw = baseSpec()
    raw.steps[2].cases[0].when = condition
    expectError(() => validateWorkflowSpec(raw), /\$\.steps\[2\]\.cases\[0\]\.when/, messagePattern)
  }

  const dupCase = baseSpec()
  dupCase.steps[2].cases[1].id = "empty"
  expectError(() => validateWorkflowSpec(dupCase), /\$\.steps\[2\]\.cases\[1\]\.id/, /duplicate case id "empty"/)

  const unknownCaseKey = baseSpec()
  unknownCaseKey.steps[2].cases[0].bogus = true
  expectError(() => validateWorkflowSpec(unknownCaseKey), /\$\.steps\[2\]\.cases\[0\]/, /unknown key "bogus"/)
})

test("validates synthesize input references and metadata", () => {
  const good = validateWorkflowSpec({
    version: 1,
    steps: [
      { id: "a", type: "agent", agent: "x", prompt: "Do." },
      { id: "s", type: "synthesize", prompt: "Combine {{ a }}.", input: ["a"], agent: "general", model: "m/1", retry: 1, timeout: 9, isolation: true },
    ],
  })
  assert.deepEqual(good.byId.s.input, ["a"])
  assert.equal(good.byId.s.agent, "general")
  assert.equal(good.byId.s.model, "m/1")

  const bad = baseSpec()
  bad.steps[4].input = ["nope"]
  expectError(() => validateWorkflowSpec(bad), /\$\.steps\[4\]\.input/, /does not match any step id/)
})

test("validates outputSchema structurally", () => {
  expectError(() => validateWorkflowSpec({ ...baseSpec(), steps: [{ ...baseSpec().steps[0], outputSchema: "nope" }] }), /\$\.steps\[0\]\.outputSchema/, /plain object/)
  expectError(
    () => validateWorkflowSpec({ ...baseSpec(), steps: [{ ...baseSpec().steps[0], outputSchema: { profile: "object" } }] }),
    /\$\.steps\[0\]\.outputSchema\.type/,
    /is required/,
  )
  expectError(
    () => validateWorkflowSpec({ ...baseSpec(), steps: [{ ...baseSpec().steps[0], outputSchema: { type: "frobnicate" } }] }),
    /\$\.steps\[0\]\.outputSchema\.type/,
    /unknown JSON Schema type "frobnicate"/,
  )
  expectError(
    () => validateWorkflowSpec({ ...baseSpec(), steps: [{ ...baseSpec().steps[0], outputSchema: { type: "object", properties: "nope" } }] }),
    /\$\.steps\[0\]\.outputSchema/,
    /invalid JSON Schema/,
  )
  const ok = validateWorkflowSpec({ ...baseSpec(), steps: [{ ...baseSpec().steps[0], outputSchema: { type: "array", items: { type: "string" } } }] })
  assert.equal(ok.byId.gather.outputSchema.type, "array")
})

test("enforces phase membership and label uniqueness", () => {
  const badPhase = baseSpec()
  badPhase.steps[0].phase = "unknown-phase"
  expectError(() => validateWorkflowSpec(badPhase), /\$\.steps\[0\]\.phase/, /not declared/)

  const badLabels = baseSpec()
  badLabels.labels = ["a", "a"]
  expectError(() => validateWorkflowSpec(badLabels), /\$\.labels/, /must not contain duplicates/)

  const badStepLabels = baseSpec()
  badStepLabels.steps[0].labels = ["a", "a"]
  expectError(() => validateWorkflowSpec(badStepLabels), /\$\.steps\[0\]\.labels/, /must not contain duplicates/)

  const badPhaseShape = baseSpec()
  badPhaseShape.phases.research = { label: "Research", bogus: true }
  expectError(() => validateWorkflowSpec(badPhaseShape), /\$\.phases\.research\.bogus/, /not a supported phase key/)
})

test("policy constrains agents and models", () => {
  const raw = baseSpec()
  expectError(
    () => validateWorkflowSpec(raw, { agents: ["explore"] }),
    /\$\.steps\[1\]\.steps\[0\]\.agent/,
    /agent "worker" is not allowed by policy/,
  )
  expectError(
    () => validateWorkflowSpec(raw, { models: ["other/model"] }),
    /\$\.steps\[0\]\.model/,
    /model "provider\/research" is not allowed by policy/,
  )
  const ok = validateWorkflowSpec({ ...baseSpec(), steps: [baseSpec().steps[0]] }, { agents: ["explore"], models: ["provider/research"] })
  assert.ok(ok.byId.gather)
})

test("policy caps limits: explicit exceed fails, absent values clamp", () => {
  const exceeding = baseSpec()
  exceeding.limits.maxParallel = 5
  expectError(() => validateWorkflowSpec(exceeding, { maxParallel: 2 }), /limits\.maxParallel/, /exceeds the policy hard maximum of 2/)

  const absent = { version: 1, steps: [{ id: "a", type: "agent", agent: "x", prompt: "Do." }] }
  const wf = validateWorkflowSpec(absent, { maxParallel: 2, maxAgents: 3, maxIterations: 4 })
  assert.deepEqual(wf.limits, { maxParallel: 2, maxAgents: 3, maxIterations: 4 })

  const ok = validateWorkflowSpec(
    { version: 1, limits: { maxParallel: 1 }, steps: [{ id: "a", type: "agent", agent: "x", prompt: "Do." }] },
    { maxParallel: 4 },
  )
  assert.equal(wf.limits.maxParallel, 2)
  assert.equal(ok.limits.maxParallel, 1)
})

test("rejects unknown policy options and malformed policy values", () => {
  expectError(() => validateWorkflowSpec(baseSpec(), { bogus: 1 }), /policy\.bogus/, /not a supported policy option/)
  expectError(() => validateWorkflowSpec(baseSpec(), { agents: "worker" }), /policy\.agents/, /array of non-empty strings/)
  expectError(() => validateWorkflowSpec(baseSpec(), { maxParallel: 0 }), /policy\.maxParallel/, /integer >= 1/)
  expectError(() => validateWorkflowSpec(baseSpec(), { maxCost: -1 }), /policy\.maxCost/, /finite number >= 0/)
})

test("parseReference accepts restricted paths and rejects everything else", () => {
  assert.deepEqual(parseReference("a"), { root: "a", segments: [], raw: "a" })
  assert.deepEqual(parseReference("a.b[0].c"), { root: "a", segments: ["b", "0", "c"], raw: "a.b[0].c" })
  assert.deepEqual(parseReference("some-step.result"), { root: "some-step", segments: ["result"], raw: "some-step.result" })

  for (const bad of ["", "a..b", "a.", ".a", "a[", "a[-1]", "a b", "a[b]", "a..", "1a.b", "a[0]x", " a", "a "]) {
    expectError(() => parseReference(bad), /\$/, /reference|invalid/)
  }
  const deep = `a.${Array.from({ length: 40 }, (_, i) => `k${i}`).join(".")}`
  expectError(() => parseReference(deep), /\$/, /exceeds 32 path segments/)
  expectError(() => parseReference("a".repeat(300)), /\$/, /exceeds 256 characters/)
})

test("resolveReference walks dotted and indexed paths with descriptive errors", () => {
  const store = { a: { b: [{ c: 5 }], title: "hello" }, n: 7 }
  assert.equal(resolveReference(store, "a.b[0].c"), 5)
  assert.equal(resolveReference(store, "a.b.0.c"), 5)
  assert.equal(resolveReference(store, "a.title"), "hello")
  assert.equal(resolveReference(store, "n"), 7)
  assert.deepEqual(resolveReference(store, "a.b"), [{ c: 5 }])
  assert.deepEqual(resolveReference(store, "a.b[0]"), { c: 5 })

  expectError(() => resolveReference(store, "zzz"), /\$\.zzz/, /does not match any step id/)
  expectError(() => resolveReference(store, "a.missing"), /\$\.a\.missing/, /does not have a property/)
  expectError(() => resolveReference(store, "a.b[9]"), /\$\.a\.b\[9\]/, /index 9 is out of range/)
  expectError(() => resolveReference(store, "n.deep"), /\$\.n\.deep/, /cannot access "deep" on number/)
  expectError(() => resolveReference(store, "a..b"), /\$/, /empty path segment/)
  expectError(() => resolveReference([], "a"), /\$/, /plain object/)
})

test("errors carry WorkflowValidationError type and path", () => {
  const raw = baseSpec()
  raw.steps[0].retry = -2
  try {
    validateWorkflowSpec(raw)
    assert.fail("should have thrown")
  } catch (error) {
    assert.ok(error instanceof WorkflowValidationError)
    assert.equal(error.name, "WorkflowValidationError")
    assert.equal(error.path, "$.steps[0].retry")
    assert.match(error.message, /retry/)
  }
})

test("handles serialization round-trip: JSON input validates identically", () => {
  const raw = baseSpec()
  const fromJson = JSON.parse(JSON.stringify(raw))
  const a = validateWorkflowSpec(raw)
  const b = validateWorkflowSpec(fromJson)
  assert.deepEqual(JSON.parse(JSON.stringify(a.spec)), JSON.parse(JSON.stringify(b.spec)))
  assert.deepEqual(a.order, b.order)
})

test("parallel siblings carry no implicit ordering dependency", () => {
  const wf = validateWorkflowSpec({
    version: 1,
    steps: [
      {
        id: "p",
        type: "parallel",
        steps: [
          { id: "a", type: "agent", agent: "x", prompt: "Do A." },
          { id: "b", type: "agent", agent: "x", prompt: "Do B." },
        ],
      },
    ],
  })
  assert.deepEqual(wf.dependencies.a, [], "a has no implicit predecessor")
  assert.deepEqual(wf.dependencies.b, [], "b has no implicit predecessor from a")
  assert.ok(wf.order.indexOf("a") !== -1 && wf.order.indexOf("b") !== -1)
})

test("sequence, map, and loop siblings are implicitly ordered", () => {
  const wf = validateWorkflowSpec({
    version: 1,
    steps: [
      { id: "rows", type: "agent", agent: "x", prompt: "Do." },
      {
        id: "seq",
        type: "sequence",
        steps: [
          { id: "s1", type: "agent", agent: "x", prompt: "A." },
          { id: "s2", type: "agent", agent: "x", prompt: "B." },
        ],
      },
      {
        id: "m",
        type: "map",
        over: "rows.items",
        as: "row",
        steps: [
          { id: "m1", type: "agent", agent: "x", prompt: "A." },
          { id: "m2", type: "agent", agent: "x", prompt: "B." },
        ],
      },
      {
        id: "l",
        type: "loop",
        over: "rows.items",
        as: "row",
        steps: [
          { id: "l1", type: "agent", agent: "x", prompt: "A." },
          { id: "l2", type: "agent", agent: "x", prompt: "B." },
        ],
      },
    ],
  })
  assert.ok(wf.dependencies.s2.includes("s1"), "sequence: s2 depends on s1")
  assert.ok(wf.dependencies.m2.includes("m1"), "map: m2 depends on m1 within one iteration")
  assert.ok(wf.dependencies.l2.includes("l1"), "loop: l2 depends on l1 within one iteration")
})

test("branch cases are alternatives: steps never chain across cases or otherwise", () => {
  const wf = validateWorkflowSpec({
    version: 1,
    steps: [
      { id: "flag", type: "agent", agent: "x", prompt: "Do." },
      {
        id: "br",
        type: "branch",
        cases: [
          {
            id: "c1",
            when: { $ref: "flag.ok" },
            steps: [
              { id: "x1", type: "agent", agent: "x", prompt: "A." },
              { id: "x2", type: "agent", agent: "x", prompt: "B." },
            ],
          },
          {
            id: "c2",
            when: { $not: { $ref: "flag.ok" } },
            steps: [{ id: "y1", type: "agent", agent: "x", prompt: "C." }],
          },
        ],
        otherwise: [{ id: "z1", type: "agent", agent: "x", prompt: "D." }],
      },
    ],
  })
  assert.ok(wf.dependencies.x2.includes("x1"), "steps inside one case stay ordered")
  assert.deepEqual(wf.dependencies.y1, [], "a later case must not depend on an earlier case")
  assert.deepEqual(wf.dependencies.z1, [], "otherwise must not depend on any case")
})

test("a loop until may reference its own body outputs; descendants stay rejected elsewhere", () => {
  const ok = validateWorkflowSpec({
    version: 1,
    steps: [
      { id: "rows", type: "agent", agent: "x", prompt: "Do." },
      {
        id: "iterate",
        type: "loop",
        over: "rows.items",
        as: "row",
        until: { $gte: [{ $ref: "score.total" }, 10] },
        steps: [{ id: "score", type: "agent", agent: "x", prompt: "Score {{ row.value }}." }],
      },
    ],
  })
  assert.ok(ok.byId.iterate)
  assert.ok(ok.dependencies.iterate.includes("score"), "the until depends on the body output")

  const stillRejected = {
    version: 1,
    steps: [
      { id: "rows", type: "agent", agent: "x", prompt: "Do." },
      {
        id: "iterate",
        type: "loop",
        over: "rows.items",
        as: "row",
        steps: [{ id: "score", type: "agent", agent: "x", prompt: "Score {{ row.value }}." }],
      },
    ],
  }
  stillRejected.steps[1].until = undefined
  stillRejected.steps[1].over = "score.out"
  expectError(
    () => validateWorkflowSpec(stillRejected),
    /\$\.steps\[1\]\.over/,
    /descendant step "score"/,
  )

  const branchWhenDescendant = {
    version: 1,
    steps: [
      { id: "flag", type: "agent", agent: "x", prompt: "Do." },
      {
        id: "br",
        type: "branch",
        cases: [
          {
            id: "c1",
            when: { $ref: "leaf.out" },
            steps: [{ id: "leaf", type: "agent", agent: "x", prompt: "Do." }],
          },
        ],
      },
    ],
  }
  expectError(
    () => validateWorkflowSpec(branchWhenDescendant),
    /\$\.steps\[1\]\.cases\[0\]\.when/,
    /descendant step "leaf"/,
  )
})

test("enforces per-loop maxIterations and per-map maxParallel overrides", () => {
  const ok = validateWorkflowSpec({
    version: 1,
    limits: { maxIterations: 20, maxParallel: 4 },
    steps: [
      { id: "rows", type: "agent", agent: "x", prompt: "Do." },
      {
        id: "l",
        type: "loop",
        over: "rows.items",
        as: "row",
        maxIterations: 5,
        steps: [{ id: "inner", type: "agent", agent: "x", prompt: "Do." }],
      },
      {
        id: "m",
        type: "map",
        over: "rows.items",
        as: "row",
        maxParallel: 3,
        steps: [{ id: "leaf", type: "agent", agent: "x", prompt: "Do." }],
      },
    ],
  })
  assert.equal(ok.byId.l.maxIterations, 5)
  assert.equal(ok.byId.m.maxParallel, 3)

  const tooManyIterations = {
    version: 1,
    limits: { maxIterations: 3 },
    steps: [
      { id: "rows", type: "agent", agent: "x", prompt: "Do." },
      {
        id: "l",
        type: "loop",
        over: "rows.items",
        as: "row",
        maxIterations: 4,
        steps: [{ id: "inner", type: "agent", agent: "x", prompt: "Do." }],
      },
    ],
  }
  expectError(
    () => validateWorkflowSpec(tooManyIterations),
    /\$\.steps\[1\]\.maxIterations/,
    /must not exceed the workflow maxIterations of 3/,
  )

  const badIterations = {
    version: 1,
    steps: [
      { id: "rows", type: "agent", agent: "x", prompt: "Do." },
      {
        id: "l",
        type: "loop",
        over: "rows.items",
        as: "row",
        maxIterations: 0,
        steps: [{ id: "inner", type: "agent", agent: "x", prompt: "Do." }],
      },
    ],
  }
  expectError(() => validateWorkflowSpec(badIterations), /\$\.steps\[1\]\.maxIterations/, /integer >= 1/)

  const tooWideMap = {
    version: 1,
    limits: { maxParallel: 2 },
    steps: [
      { id: "rows", type: "agent", agent: "x", prompt: "Do." },
      {
        id: "m",
        type: "map",
        over: "rows.items",
        as: "row",
        maxParallel: 3,
        steps: [{ id: "leaf", type: "agent", agent: "x", prompt: "Do." }],
      },
    ],
  }
  expectError(
    () => validateWorkflowSpec(tooWideMap),
    /\$\.steps\[1\]\.maxParallel/,
    /must not exceed the workflow maxParallel of 2/,
  )

  const unknownKey = {
    version: 1,
    steps: [
      { id: "rows", type: "agent", agent: "x", prompt: "Do." },
      {
        id: "m",
        type: "map",
        over: "rows.items",
        as: "row",
        steps: [{ id: "leaf", type: "agent", agent: "x", prompt: "Do." }],
      },
    ],
  }
  unknownKey.steps[1].bogus = true
  expectError(() => validateWorkflowSpec(unknownKey), /\$\.steps\[1\]/, /unknown key "bogus"/)
})

test("renderTemplate interpolates strings, scalars, JSON values, and local scope", () => {
  const store = {
    gather: { title: "Report", count: 3, items: [{ name: "a" }, { name: "b" }] },
    done: true,
    nothing: null,
  }
  assert.equal(renderTemplate("plain text", store), "plain text")
  assert.equal(renderTemplate("Hello {{ gather.title }}!", store), "Hello Report!")
  assert.equal(renderTemplate("count={{ gather.count }}", store), "count=3")
  assert.equal(renderTemplate("ok={{ done }} none={{ nothing }}", store), "ok=true none=null")
  assert.equal(
    renderTemplate("{{ gather }}", store),
    JSON.stringify({ title: "Report", count: 3, items: [{ name: "a" }, { name: "b" }] }),
  )
  assert.equal(renderTemplate("{{ gather.items[1].name }}", store), "b")
  assert.equal(renderTemplate("nested {{ gather.items }}", store), `nested ${JSON.stringify([{ name: "a" }, { name: "b" }])}`)
  assert.equal(renderTemplate("", store), "")
  assert.equal(renderTemplate("{{ gather.title }}{{ gather.title }}", store), "ReportReport")

  const local = { item: { name: "x", n: 2 }, other: 9 }
  assert.equal(renderTemplate("row={{ item.name }}", store, local), "row=x")
  assert.equal(renderTemplate("local-only={{ item.n }} fallback={{ gather.title }}", store, local), "local-only=2 fallback=Report")
})

test("renderTemplate rejects malformed templates and unresolvable references", () => {
  const store = { a: { b: [1] } }
  const badTemplates = [
    ["Use {{ a.b.", /unterminated/],
    ["Use {{ a.b }} then }} more", /stray/],
    ["Text }} early", /stray/],
    ["Use {{ }}.", /empty/],
    ["Use {{ {{ a.b }} }}.", /nested/],
    ["Use {{ nope.field }}.", /does not match any step id/],
  ]
  for (const [template, pattern] of badTemplates) {
    assert.throws(
      () => renderTemplate(template, store),
      (error) => error instanceof WorkflowValidationError && pattern.test(error.message),
    )
  }
  assert.throws(() => renderTemplate(42, store), WorkflowValidationError)
  assert.throws(() => renderTemplate("{{ a.b[9] }}", store), WorkflowValidationError)
})

test("evaluateCondition implements closed comparison semantics", () => {
  const store = {
    flag: true,
    off: false,
    count: 5,
    score: { total: 10, tags: ["a", "b"] },
    price: 9.5,
  }
  assert.equal(evaluateCondition({ $ref: "flag" }, store), true)
  assert.equal(evaluateCondition({ $ref: "off" }, store), false)
  assert.equal(evaluateCondition({ $ref: "score.tags" }, store), true)
  assert.equal(evaluateCondition({ $eq: [{ $ref: "score.total" }, 10] }, store), true)
  assert.equal(evaluateCondition({ $ne: [{ $ref: "score.total" }, 11] }, store), true)
  assert.equal(evaluateCondition({ $eq: [{ $ref: "score.tags" }, ["a", "b"]] }, store), true)
  assert.equal(evaluateCondition({ $eq: [{ $ref: "score" }, { total: 10, tags: ["a", "b"] }] }, store), true)
  assert.equal(evaluateCondition({ $gt: [{ $ref: "count" }, 4] }, store), true)
  assert.equal(evaluateCondition({ $lte: [{ $ref: "price" }, 9.5] }, store), true)
  assert.equal(evaluateCondition({ $lt: [{ $ref: "count" }, { $ref: "price" }] }, store), true)
  assert.equal(evaluateCondition({ $and: [{ $ref: "flag" }, { $gt: [{ $ref: "count" }, 0] }] }, store), true)
  assert.equal(evaluateCondition({ $or: [{ $ref: "off" }, { $eq: [{ $ref: "count" }, 5] }] }, store), true)
  assert.equal(evaluateCondition({ $not: { $ref: "off" } }, store), true)
  assert.equal(evaluateCondition({ $and: [{ $ref: "off" }, { $ref: "flag" }] }, store), false)

  const local = { item: { n: 7 } }
  assert.equal(evaluateCondition({ $gte: [{ $ref: "item.n" }, 7] }, store, local), true)
  assert.equal(evaluateCondition({ $eq: [{ $ref: "item.n" }, 7] }, store, local), true)
  assert.equal(evaluateCondition({ $gt: [{ $ref: "item.n" }, { $ref: "count" }] }, store, local), true)

  assert.throws(() => evaluateCondition({ $gt: [{ $ref: "flag" }, 1] }, store), /numeric operands/)
  assert.throws(() => evaluateCondition({ $frob: 1 }, store), /unknown condition operator/)
  assert.throws(() => evaluateCondition({ $ref: "nope" }, store), /does not match any step id/)
  assert.throws(() => evaluateCondition({ $eq: [1] }, store), /2-element/)
  assert.throws(() => evaluateCondition({ $and: [] }, store), /non-empty array/)
  assert.throws(() => evaluateCondition({ $eq: [1, 2], $ref: "flag" }, store), /exactly one operator/)
})
