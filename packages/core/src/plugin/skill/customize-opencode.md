<!--
  Built-in skill. Name and description are registered in
  packages/core/src/plugin/skill.ts.
-->

# Customizing Multi-AI Code OpenCode

This is the Multi-AI Code managed OpenCode build. Its configuration rules are
intentionally different from upstream OpenCode.

## Ownership boundary

- Never read, create, or modify project `.opencode` directories.
- Never read or create project `opencode.json`, `opencode.jsonc`, or
  `config.json` files for OpenCode settings.
- Never read or modify the host user's upstream OpenCode directories.
- All mutable OpenCode data belongs to the active Multi-AI Code account.
- The managed model catalog, enabled providers, credentials, default model,
  and small model are supplied by Multi-AI Code and must not be overridden.
- `/connect` and custom provider setup are not available in this build.

## Account paths

`OPENCODE_RUNTIME_ROOT` is set automatically by Multi-AI Code. Do not ask the
user to configure it.

| Data        | Path                                                              |
| ----------- | ----------------------------------------------------------------- |
| Main config | `$OPENCODE_RUNTIME_ROOT/config/opencode.json` or `opencode.jsonc` |
| TUI config  | `$OPENCODE_RUNTIME_ROOT/config/tui.json` or `tui.jsonc`           |
| Agents      | `$OPENCODE_RUNTIME_ROOT/config/agent(s)/<name>.md`                |
| Commands    | `$OPENCODE_RUNTIME_ROOT/config/command(s)/<name>.md`              |
| Skills      | `$OPENCODE_RUNTIME_ROOT/config/skill(s)/<name>/SKILL.md`          |
| Plugins     | `$OPENCODE_RUNTIME_ROOT/config/plugin(s)/*.{js,ts}`               |
| Plans       | `$OPENCODE_RUNTIME_ROOT/data/plans/`                              |

If `OPENCODE_RUNTIME_ROOT` is unavailable, do not guess a host path. Ask the
user to change the setting through Multi-AI Code or restart the managed
session.

## Applying changes

Configuration is loaded when OpenCode starts. After changing account
configuration, tell the user to restart the current OpenCode session.

OpenCode validates configuration strictly. Preserve existing JSON/JSONC
formatting, edit only fields required by the request, and avoid introducing
provider or model fields managed by the host.

Common account-level fields include:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "build",
  "shell": "/bin/zsh",
  "autoupdate": false,
  "instructions": ["AGENTS.md"],
  "permission": {
    "edit": "allow",
    "bash": {
      "git *": "allow",
      "*": "ask"
    }
  },
  "mcp": {
    "example": {
      "type": "local",
      "command": ["example-mcp"],
      "enabled": true
    }
  }
}
```

Do not add `model`, `small_model`, `provider`,
`enabled_providers`, or `disabled_providers`; Multi-AI Code injects those
values from its reviewed package resources.

## Agents

For non-trivial agents, create an account-scoped Markdown file:

```text
$OPENCODE_RUNTIME_ROOT/config/agents/reviewer.md
```

```markdown
---
description: Reviews changes for correctness.
mode: subagent
permission:
  edit: deny
  bash: ask
---

Review the requested changes and report concrete regressions.
```

The file body is the system prompt. Do not set a model in the agent file; the
managed runtime owns model selection.

## Commands

Account commands live under
`$OPENCODE_RUNTIME_ROOT/config/commands/<name>.md`. The body is the prompt;
`$ARGUMENTS` expands to the command arguments.

```markdown
---
description: Reviews the current working tree.
agent: build
---

Review the current changes. Extra focus: $ARGUMENTS
```

## Skills

Account skills live under
`$OPENCODE_RUNTIME_ROOT/config/skills/<name>/SKILL.md`.

```markdown
---
name: example-skill
description: Use when the user requests the example workflow.
---

# Example Skill

Workflow instructions.
```

The name must be lowercase and hyphen-separated. The description must say
what the skill does and when it should trigger.

## Plugins and MCP

Install or create plugins only in the account config directory. Configure MCP
servers only in the account config file. Do not install dependencies or write
lockfiles inside the user's repository as part of OpenCode customization.

Never expose credentials in chat, logs, generated files, or IM replies.
