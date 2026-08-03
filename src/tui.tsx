/** @jsxImportSource @opentui/solid */
import path from "node:path"

import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { For, createSignal } from "solid-js"

import { PLUGIN_ID } from "./constants.ts"
import type { RunRecord, RunSummary } from "./workflow/state.ts"
import { WorkflowStore } from "./workflow/store.ts"

type DashboardRun = RunSummary & {
  completed: number
  running: number
  failed: number
  total: number
  tokens: number
  cost: number
}

const summarize = (run: RunRecord): DashboardRun => {
  const nodes = Object.values(run.nodes)
  return {
    runId: run.runId,
    instanceId: run.instanceId,
    workflow: run.workflow,
    status: run.status,
    fingerprint: run.fingerprint,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    seq: run.seq,
    completed: nodes.filter((node) => node.status === "completed" || node.status === "cached").length,
    running: nodes.filter((node) => node.status === "running").length,
    failed: nodes.filter((node) => node.status === "failed" || node.status === "cancelled").length,
    total: nodes.length,
    tokens: (run.usage?.tokensIn ?? 0) + (run.usage?.tokensOut ?? 0),
    cost: run.usage?.cost ?? 0,
  }
}

const shortId = (id: string): string => id.slice(0, 8)

export const WorkflowTuiPlugin: TuiPlugin = async (api) => {
  const [runs, setRuns] = createSignal<DashboardRun[]>([])
  const [error, setError] = createSignal<string | undefined>()
  const store = new WorkflowStore({
    root: path.join(api.state.path.state, "opencode-agent-tree", "workflows"),
    projectWorkflowDir: path.join(api.state.path.directory, ".opencode", "workflows"),
    personalWorkflowDir: path.join(api.state.path.config, "workflows"),
  })
  let initialized = false

  const refresh = async () => {
    try {
      if (!initialized) {
        await store.init()
        initialized = true
      }
      const summaries = await store.listRuns()
      const records = await Promise.all(summaries.slice().reverse().slice(0, 20).map((run) => store.loadRun(run.runId)))
      setRuns(records.filter((run): run is RunRecord => run !== null).map(summarize))
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const Dashboard = () => (
    <box flexDirection="column" padding={1} gap={1}>
      <text><strong>Dynamic workflows</strong></text>
      <text>Runs are durable. Use /workflow &lt;task&gt; to start one and workflow tools to cancel or resume.</text>
      {error() ? <text>Could not load runs: {error()}</text> : null}
      <box flexDirection="column">
        <text><strong>RUN       STATUS       NODES       TOKENS      COST      WORKFLOW</strong></text>
        <For each={runs()} fallback={<text>No workflow runs yet.</text>}>
          {(run) => (
            <text>
              {shortId(run.runId).padEnd(10)}
              {run.status.padEnd(13)}
              {`${run.completed}/${run.total}`.padEnd(12)}
              {String(run.tokens).padEnd(12)}
              {run.cost.toFixed(4).padEnd(10)}
              {run.workflow}
            </text>
          )}
        </For>
      </box>
      <text>Dashboard refreshes every second. Full per-node details remain available in child sessions and workflow_status.</text>
    </box>
  )

  const unregisterRoute = api.route.register([{ name: "agent-tree-workflows", render: Dashboard }])
  api.keymap.registerLayer({
    mode: "base",
    commands: [{
      name: "agent-tree.workflows.open",
      title: "Open workflow dashboard",
      description: "Inspect dynamic workflow runs",
      category: "Workflows",
      namespace: "palette",
      slashName: "workflow-dashboard",
      run: () => {
        void refresh()
        api.route.navigate("agent-tree-workflows")
      },
    }],
  })
  const timer = setInterval(() => {
    if (api.route.current.name === "agent-tree-workflows") void refresh()
  }, 2000)
  void refresh()

  api.lifecycle.onDispose(() => {
    clearInterval(timer)
    unregisterRoute()
  })
}

export const tui = WorkflowTuiPlugin

export default { id: PLUGIN_ID, tui } satisfies TuiPluginModule
