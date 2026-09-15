# Security Policy

## Supported versions

Only the latest version of `@beremaran/opencode-agent-tree` is supported with
security updates. Older releases are not patched; if you are on an earlier
release, upgrade to the latest version and confirm the issue is resolved before
reporting it.

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

This plugin enforces behavior through OpenCode's agent configuration, so its
security surface is the configuration it runs with. Only use the plugin with
config you control.

- **The root block uses the V2 wildcard action.** The only action family enabled
  afterward is `subagent`, scoped to `general`.
- **Recursive worker delegation is prompt-guided.** The current plugin API does
  not expose semantic complexity evaluation or dynamic permissions, so a worker
  can technically act before delegating.
- **Workers keep their hands-on tools.** This is required for atomic work and
  means worker prompts and agent configuration remain part of the trust boundary.
- **The plugin does not choose models.** Models and worker definitions come
  from OpenCode configuration.
