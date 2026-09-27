# Refresh Efficiency

This bundled plugin records observational C02 telemetry and can add compact,
proportionate guidance through the public `before_prompt_build` hook.

Enable the plugin through the existing plugin enablement path:

```bash
openclaw config set plugins.entries.refresh-efficiency.enabled true
```

Then set `plugins.entries.refresh-efficiency.config.guidanceEnabled` to `false`
for the baseline and `true` for the candidate. Telemetry remains registered in
both conditions once the plugin is enabled.
