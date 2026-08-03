import { modelReference } from "./options.ts"
import type { AgentLike, ModelReference } from "./types.ts"

export type RoutingState = {
  setActiveModel: (model: ModelReference) => ModelReference
  getActiveModel: () => ModelReference
  prune: (targetSet: Set<string>) => void
  applyModel: (name: string, def: AgentLike, override: string | undefined) => void
  applyEffort: (name: string, def: AgentLike, effort: string | undefined) => void
  routeFor: (name: string) => ModelReference | undefined
  hasRoute: (name: string) => boolean
}

export const createRoutingState = (initialModel: ModelReference): RoutingState => {
  let activeSubagentModel = initialModel
  const routedModels = new Map<string, ModelReference | undefined>()
  const routedEfforts = new Map<string, string>()
  const routedDefinitions = new Map<string, AgentLike>()

  return {
    setActiveModel: (model) => {
      activeSubagentModel = model
      for (const [name, override] of routedModels) {
        if (override) continue
        const def = routedDefinitions.get(name)
        if (def) def.model = activeSubagentModel.raw
      }
      return activeSubagentModel
    },
    getActiveModel: () => activeSubagentModel,
    prune: (targetSet) => {
      for (const name of routedModels.keys()) {
        if (!targetSet.has(name)) {
          routedModels.delete(name)
          routedDefinitions.delete(name)
        }
      }
      for (const name of routedEfforts.keys()) {
        if (!targetSet.has(name)) routedEfforts.delete(name)
      }
    },
    applyModel: (name, def, override) => {
      const wasRouted = routedModels.has(name)
      if (!def.model || wasRouted) {
        const model = override ? modelReference(override, `agentModels.${name}`) : activeSubagentModel
        def.model = model.raw
        routedModels.set(name, override ? model : undefined)
        routedDefinitions.set(name, def)
      }
    },
    applyEffort: (name, def, effort) => {
      if (effort && (!def.variant || routedEfforts.has(name))) {
        def.variant = effort
        routedEfforts.set(name, effort)
      }
    },
    routeFor: (name) => routedModels.get(name),
    hasRoute: (name) => routedModels.has(name),
  }
}
