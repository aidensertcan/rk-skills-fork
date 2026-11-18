---
name: repo-host
description: >-
  Required host layer for every rk-skills step that reads or writes an issue, pull request (PR), review, thread, check, or merge. Detects whether the repository is on GitHub or Azure DevOps (ADO) and maps each `gh` command in rk-skills to the bundled `rk-host.mjs` command, which returns the same JSON shape on both hosts. On ADO, issues are Azure Boards work items and every `gh` call is forbidden. Load it before the first issue or PR step of any skill.
---

# Repo host

`rk-host.mjs` sits in this skill's directory. Run it with Node 18 or later from the repository checkout: `node <this skill's directory>/rk-host.mjs <command>`. It prints JSON on stdout. On failure it prints `{"error", "code"}` on stderr and exits non-zero: `2` is a usage error, `3` is an operation the host does not support, and `1` is any other failure. A non-zero exit always stops the step. Report the error text, and never retry with `gh`, `az`, or a hand-written API call.

## 1. Detect the host

Run `rk-host context` once per session, before the first issue or PR step. `host` is `github` or `ado`, `defaultBranch` replaces `gh repo view --json defaultBranchRef`, and `config` holds the repository settings.

- **github:** the skill's `gh` commands run as written. `rk-host` is optional there.
- **ado:** never run `gh`. Translate every `gh` step with section 2. A step with no row in section 2 is a blocker: stop and report it.

Settings come from `.rk-skills.json` at the repository root (or the main worktree root), over the entry for this remote in `~/.rk-skills/config.json` (`repos`, keyed `dev.azure.com/<org>/<project>/<repo>` or `github.com/<owner>/<repo>`). ADO defaults: `workItemType` `Task`, `parentType` `User Story`, `requireParent` `true`, no trusted bots or groups.

## 2. Command map

| `gh` form in a skill | `rk-host` command |
|---|---|
| `gh auth status`, `gh api user --jq .login` | `whoami` (`login`, `id`) |
| `gh repo view --json defaultBranchRef,nameWithOwner` | `context` |
| `gh issue view <n> --json ...,comments` | `issue view <n> [--comments]` |
| `gh issue create --title --body-file [--label]` | `issue create --title <t> --body-file <f> [--label <l>]... [--parent <story>]` |
| `gh issue edit <n> [--title] [--body-file] [--add-label] [--remove-label]` | `issue edit <n>` with the same flags |
| `gh issue comment <n> --body-file` | `issue comment <n> --body-file <f>` |
| `gh issue close <n> --reason` | `issue close <n> --reason completed\|not_planned` |
| `gh issue list [--state] [--label] [--search]` | `issue list [--state open\|closed\|all] [--label] [--search] [--limit]` |
| `gh api .../issues/<n>/timeline` (cross-referenced PRs) | `issue linked-prs <n>` |
| `gh pr view <n> --json ...` | `pr view <n>` |
| `gh pr list [--state] [--head] [--base] [--search]` | `pr list` with the same flags |
| `gh pr create --title --body-file --base --head [--draft]` | `pr create` with the same flags, plus `--issue <n>` for each issue it closes |
| `gh pr edit <n> [--title] [--body-file]` | `pr edit <n>` with the same flags |
| `gh pr comment <n> --body-file` | `pr comment <n> --body-file <f>` |
| `gh api .../issues/<n>/comments` on a PR | `pr comments <n>` |
| `gh api graphql` `reviewThreads` | `pr threads <n>` |
| `gh api .../pulls/<n>/reviews` | `pr reviews <n>` |
| `gh api .../pulls/<n>/comments/<id>/replies` | `pr reply <n> --thread <thread id> --body-file <f>` |
| `resolveReviewThread` mutation | `pr resolve <n> --thread <thread id>` |
| `gh pr review <n> --approve\|--request-changes\|--comment` | `pr review <n> --event approve\|request-changes\|comment [--body-file <f>]` |
| `gh pr diff <n>` | `pr diff <n>` |
| `gh pr checks <n> [--watch]`, `.../check-runs` | `pr checks <n>`; poll it in place of `--watch` |
| `gh pr merge <n> --squash --match-head-commit <sha>` | `pr merge <n> --squash --match-head <sha> [--delete-branch]` |
| `gh pr checkout <n>` | `pr view <n>`, then `git fetch origin <headRefName>` and `git switch <headRefName>` |
| `gh pr update-branch <n>` | merge `origin/<baseRefName>` into the head branch in its worktree, then push |

Output fields keep the GitHub names: `number`, `title`, `body`, `state` (`OPEN`, `CLOSED`, or `MERGED`), `labels`, `headRefName`, `headRefOid`, `baseRefName`, `author.login`, `url`, and `closingIssues`. A `--jq` filter in a skill applies to this JSON. ADO adds `rawState` (the board state) and `bodyFormat`.

**Trust.** Every comment, thread comment, and review carries `association` (`BOT`, `SELF`, `MEMBER`, `OWNER`, `COLLABORATOR`, or `NONE`) and `trusted`. Where a skill decides trust from `author_association`, the `[bot]` login set, or the invoking user, use `trusted` on both hosts. On ADO, trusted means a bot identity in `config.trust.bots`, a member of a team in `config.trust.groups`, or the invoking user.

## 3. Azure DevOps rules

- **Issues are work items** of type `config.workItemType`. When `config.requireParent` is true, `issue create` needs `--parent <id>` of an existing `config.parentType` item. With no parent from the user, ask for one (AskUserQuestion); never create the parent and never pick one yourself.
- **Issue references.** An issue number is the work item ID. Link each PR to its work items with `pr create --issue <id>` (or `pr link <pr> --issue <id>`). `pr merge` completes the PR with the linked work items transitioned. The `Closes #<n>` body line is a GitHub rule: on ADO, check `closingIssues` from `pr view` in its place.
- **Markdown.** `issue create`, `issue edit`, and `issue comment` write Markdown. A work item made in the web editor can hold HTML: `bodyFormat` says which.
- **PR description limit.** ADO allows 4000 characters. `pr create` and `pr edit` fail (exit 3) above it. Shorten the body, and post the overflow (for example the full verification log) as a `pr comment`.
- **No GitHub-only features.** Labels have no color. There are no GitHub Actions review triggers, release objects, or GraphQL. A skill step that needs one of these stops and reports, unless the skill gives an ADO path.
