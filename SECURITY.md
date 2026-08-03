# Security Policy

## Supported versions

Only the latest published version of `@beremaran/opencode-agent-tree` is
supported with security updates. Older releases are not patched; if you are on
an earlier release, upgrade to the latest version and confirm the issue is
resolved before reporting it.

## Reporting a vulnerability

Please report security vulnerabilities by emailing
[berke@beremaran.com](mailto:berke@beremaran.com) rather than opening a public
issue.

Include in your report:

- The plugin version (from `package.json`) and the opencode version you are
  running.
- A description of the vulnerability and, if possible, a minimal reproduction.
- Any impact assessment you can provide.

You can expect an acknowledgement within a few business days and a fix or
mitigation plan as soon as one can be produced. Please do not disclose the
issue publicly until it has been addressed.

## Known security considerations

This plugin enforces behavior through configuration, so its security surface is
the configuration it runs with. Only use the plugin with config you control.

- **`instructions` is injected verbatim** into the orchestrator's system
  prompt. An untrusted configuration can inject prompt rules that the model
  may follow.
- **The tool block is an explicit allow/deny list, not categorical.** A renamed
  or future mutating tool would not be auto-blocked.
- **Subagents keep their hands-on tools.** Delegation does not remove tools
  from subagents; the plugin constrains the orchestrator, not the subagents.
- **`orchestratorModel` overrides an explicitly configured model** on the
  orchestrator agent.

The README's Security section describes these same considerations in prose.
