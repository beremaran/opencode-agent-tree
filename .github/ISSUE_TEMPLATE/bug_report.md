---
name: Bug report
about: Report a problem with the opencode-agent-tree plugin
title: ""
labels: bug
assignees: ""
---

**Describe the bug**
A clear and concise description of what is broken and what you expected.

**Environment**
- opencode version: (e.g. `opencode --version`)
- Plugin version: (e.g. `@beremaran/opencode-agent-tree@0.5.0`, or local path commit)
- Node/Bun runtime if relevant:

**Config**
Paste the relevant part of your `opencode.json` (plugin entry and options; redact secrets):

```json
{
  "plugin": ["@beremaran/opencode-agent-tree", { "subagentModel": "provider/model" }]
}
```

**Logs**
Paste the relevant startup/run logs, especially any `@beremaran/opencode-agent-tree` lines
(e.g. from `opencode run --print-logs`).

**To reproduce**
Steps to reproduce the behavior.

**Expected behavior**
What you expected to happen.

**Additional context**
Anything else that might help (OS, TUI vs CLI vs web, agent picker state, etc.).
