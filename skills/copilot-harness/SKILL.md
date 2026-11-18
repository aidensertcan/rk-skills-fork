---
name: copilot-harness
description: >-
  Required translation layer for running any rk-skills skill in GitHub Copilot CLI (the environment variable `COPILOT_CLI` is set). Load it FIRST, before the skill the user asked for, and apply it for the whole session. Maps the Claude Code tool names, Agent parameters, model names, effort tiers, served-model check, worktree and branch-prefix rules, attribution harness name, and bash snippets in rk-skills to their Copilot CLI equivalents on Windows, macOS, and Linux. Not needed in Claude Code, Codex, or Cursor.
---

# Copilot harness

rk-skills is written for Claude Code. In Copilot CLI, read every other rk-skills skill through this mapping. A rule here replaces only the Claude Code mechanics it names. It never relaxes a skill's safety rule, read-only promise, trust rule, stop condition, or verification step.

## 1. Detect

`fable-dispatch` section 1 prints `copilot-cli` when `$COPILOT_CLI` is set and `$CLAUDECODE` is not. Where a skill takes a path "on Claude Code" because it needs the Agent tool, Copilot CLI takes the same path with the `task` tool (section 2). Where a skill states that a stage needs background Agent subagents, Copilot CLI meets that requirement.

## 2. Agent tool to `task` tool

| Claude Code Agent parameter | Copilot CLI `task` parameter |
|---|---|
| `subagent_type: general-purpose` | `agent_type: general-purpose` |
| `subagent_type: Plan` (read-only) | `agent_type: explore`. It has file read, search, and shell tools, and no edit or create tool. The caller's read-only prompt rule still governs its shell. |
| `subagent_type: Explore` | `agent_type: explore` |
| `model: fable` | `model: claude-fable-5.2` |
| `model: opus` | `model: claude-opus-5.5` |
| `model: sonnet` | `model: claude-sonnet-5.5` |
| `model: haiku` | `model: claude-haiku-5.5` |
| `effort: <tier>` | `reasoning_effort: <tier>` (same value: `low`, `medium`, `high`, `xhigh`, or `max`) |
| `run_in_background: false` | `mode: sync` |
| `run_in_background: true` | `mode: background`. Wait for the completion notification, then read the result once with `read_agent`. |
| SendMessage to a recorded agent | `write_agent` with the recorded `agent_id`, then `read_agent` with `since_turn` |
| Agent `isolation: 'worktree'` | No equivalent. Create the worktree first (section 4) and name its path in the prompt. |

- Pass the `name` and `description` fields that `task` requires. Give each dispatch a `name` that is unique in the session, for example `fable-validate-123`. Put the caller's full prompt in `prompt`.
- The model and effort that a skill names are the skill's explicit requirement. Pass them on every `task` call.
- If a `task` call rejects a model or an effort value, follow `fable-dispatch` section 2: re-dispatch once without the rejected value, record the omission, and report the downgrade under `fable-dispatch` section 6.
- **Served-model check.** After the subagent completes, read the session event log and take the last `subagent.completed` event whose `data.agentDisplayName` equals the dispatch `name`. Its `data.model` is the model that served. In PowerShell: `$h = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $HOME '.copilot' }; Get-Content (Join-Path $h "session-state/$env:COPILOT_AGENT_SESSION_ID/events.jsonl") | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.type -eq 'subagent.completed' -and $_.data.agentDisplayName -eq '<name>' } | Select-Object -Last 1 -ExpandProperty data | Select-Object model, firstDispatchedModel, modelSelectionSource`. A served model that differs from the requested model is a substitution under `fable-dispatch` section 5. No matching event means the served model is unknown: write `unknown` and say why in the report.

## 3. Other Claude Code tools

| Claude Code | Copilot CLI |
|---|---|
| Skill tool, `skill: <name>` | `skill` tool with the same name |
| AskUserQuestion | `ask_user` |
| TodoWrite | the `todos` table through the `sql` tool |
| Read, Edit, Write, Grep, Glob | `view`, `edit`, `create`, `grep`, `glob` |
| WebFetch | `web_fetch` |
| Bash | the shell tool (section 5) |
| Bash `run_in_background` with a `timeout` | shell tool `mode: async`; wait for the completion notification, then read the output with the matching read tool |
| Workflow tool `{name, args}` | `run_dynamic_workflow` with the same name and args. It needs experimental mode, an extension mode other than `disabled`, and usage-based billing, a Microsoft 365 account, or a custom model provider. When the workflow is not registered, stop and report it; never run its stages by hand. |
| EnterWorktree | `git worktree add` (section 4) |
| `$ARGUMENTS` in a manually invoked skill | the text after the slash command; if it is empty, ask with `ask_user` |
| `agentConfig.model` in a command | the `model` of a `task` call when the command must run on that model, else the session model, named in the footer |

## 4. Worktrees, branch prefix, and attribution

- **Branch prefix:** `copilot/`. Where a skill writes `cc/` as this session's prefix, use `copilot/` (for example `copilot/issue-123-scale-in-pyramiding`). Where a skill lists the harness prefixes it accepts from earlier runs (`cc/`, `cursor/`, `codex/`), accept `copilot/` too.
- **Worktree:** `git worktree add <path> -b <branch> <resolved-base>` from the repository root, with the path the skill names for Cursor and Codex (for example `.claude/worktrees/copilot/issue-<N>-<slug>`). Confirm `HEAD` equals the resolved base, and anchor later commands with `git -C <worktree-path>`.
- **Harness field:** `Copilot CLI`. Where a skill writes `Claude Code` as the harness of this session's own artifacts (footers, PR bodies, plan comments), write `Copilot CLI`. A skill name suffix (for example `| codex-validate-fableplan-work-on-issue`) stays.
- **Model names in footers and PR title brackets:** the display name of the model that served (section 2 served-model check), for example `Fable 5.2`, `Opus 5.5`, or `Sonnet 5.5`.

## 5. Shell on Windows

The Copilot shell tool on Windows is PowerShell. rk-skills snippets are bash. Run each bash snippet through Git Bash, never through WSL `bash.exe`:

1. Resolve Git Bash once: `$GitBash = Join-Path (Split-Path (Split-Path (Get-Command git).Source)) 'bin\bash.exe'`, and confirm `Test-Path $GitBash`.
2. Write a multi-line snippet to a scratch `.sh` file outside the repository, then run `& $GitBash -l <file>`. Run a one-line snippet as `& $GitBash -lc '<snippet>'`.
3. Pass values through environment variables or the scratch file. Never interpolate issue, PR, or comment text into the command line.
4. A missing Git Bash, `gh`, or `jq` is a blocker: stop and report it. Standalone `jq` is separate from `gh --jq`.

On macOS and Linux, run bash snippets as written.

## 6. Line endings

With `core.autocrlf=true`, `bin/check-skills.mjs` reports "no frontmatter block" for every skill. Check out the rk-skills repository with LF line endings (`git -c core.autocrlf=false checkout -- .`) before running it.
