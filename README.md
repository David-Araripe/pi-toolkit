# pi-toolkit

Portable extensions, skills, and prompt templates for [Pi](https://pi.dev).
Works on macOS, Linux, and native Windows (Git Bash or Pi's optional `powershell` tool).

## Install

```bash
pi install git:github.com/David-Araripe/pi-toolkit
# or pin a release
pi install git:github.com/David-Araripe/pi-toolkit@v0.1.0
```

Restart Pi or run `/reload`. To try it for one session only, run `pi -e git:github.com/David-Araripe/pi-toolkit`.

## Contents

| Resource | What it does |
|---|---|
| `extensions/safety-guard.ts` | Blocks file removal (`rm`, `Remove-Item`, `del`, `rd`, …), access to the local SSH directory, and direct `ssh`/`scp`/`sftp`, until you run `/rm-rights` or `/ssh-rights`. Also blocks direct `claude`/`codex` runs, nested pi sessions inside subagents, and writes to subagent or agent-comm state |
| `extensions/hpc-mode.ts` | `/hpc`: explicit per-session authorization of SSH hosts, remote workspaces, `hpc_exec`, `hpc_transfer`, and Slurm job watches (including job arrays) |
| `extensions/subagents/` | `subagent` / `subagent_query`: persistent pi, Claude Code and Codex child agents with automatic reports and non-blocking waits (`/agents`, `/cc-agent`, `/codex-agent`) |
| `extensions/agent-comm/` | `agent_comm`: permission-aware messaging between pi sessions of one project and between subagents (`/comm`) |
| `extensions/bg-shell.ts` | `bg_shell`: long local commands in the background; the agent is woken on exit or at check-ins (`/bg`) |
| `extensions/wait.ts` | `/wait`: send a prompt after a delay |
| `extensions/goal.ts` | Long-running goals with budgets (`/goal`) |
| `extensions/progress-check.ts` | Periodic progress checkpoints during long tool loops |
| `extensions/research-mode.ts` | Evidence-driven research protocol and research-aware compaction |
| `extensions/btw.ts` | Side questions without derailing the main thread |
| `extensions/file-links.ts` | Shows local Markdown links as clickable absolute paths |
| `extensions/notify.ts` | Desktop notification (OSC 777) when the agent finishes |
| `extensions/provider-picker.ts` | `/provider`: pick a provider first, then a model |
| `extensions/session-breakdown.ts` | Usage and cost breakdown across sessions |
| `extensions/fork-here.ts`, `commit-command.ts`, `productivity-commands.ts` | `/fork-here`, `/commit`, `/grill-me`, `/teach`, `/handoff` |
| `skills/` | `commit`, `dataviz`, `grilling`, `grill-me`, `handoff`, `simplify`, `teach` |
| `prompts/` | `/review`, `/dataviz`, `/simplify` |

## Subagents

`extensions/subagents/` lets the agent delegate work to child agents that keep
their own native session and process.

| Backend | Driven through | Allowed |
| --- | --- | --- |
| pi | `pi --mode rpc` | always; inherits the parent's live `/hpc` grants |
| Claude Code | `claude -p` with stream-json and `--permission-prompt-tool stdio` | after `/cc-agent` |
| Codex | `codex app-server --listen stdio://` | after `/codex-agent` |

- **Tools.** `subagent` (`start`, `send`, `wait`, `interrupt`, `stop`, `reply`)
  and the read-only `subagent_query` (`list`, `get`, `transcript`, `export`).
  `start` takes a backend, name, prompt, optional files, `cwd` (e.g. a git
  worktree), model, effort, mode and goal.
- **Reports arrive by themselves.** When a child's turn ends or it needs a
  permission, the report is steered into the coordinator's conversation: a busy
  coordinator sees it between tool calls, an idle one is woken. Nothing polls
  the model. Undelivered reports stay on disk until the session resumes.
- **Waiting.** `subagent action=wait` (`id`/`ids`, `wait_for` all/any,
  `timeout_seconds`) registers a watch and returns at once; the held reports
  arrive as one message. Without a UI (print/JSON mode) it blocks instead.
- **Lifetime.** Each child runs under a detached worker, so it keeps working
  after pi quits. `stop` releases the processes but keeps the session; `send`
  resumes it. A widget below the editor lists running children and watches.
- **Authorization.** `/cc-agent` and `/codex-agent` (`on|off|status`) work like
  `/hpc allow`: confirmed by the user, session-only, never grantable by tools.
  Claude children default to `--permission-mode auto` plus a generated deny list
  (removals, SSH clients, nested agents, the SSH directory, subagent state);
  Codex children use the `workspace-write` sandbox. Bypass/full-access modes are
  refused in code. Permission prompts a child raises are relayed to the
  coordinator (`subagent action=reply`).
- **Nesting.** Children get no subagent tools, and a pi session started from
  inside any child refuses to run.
- **Investigating a run.** `<agent dir>/subagents/runs/<id>/` keeps the spec,
  state, normalised transcript, raw protocol events and worker log.
  `/agents export <id> [file]` writes an HTML transcript.

Workers run as `node worker.ts`, so they need Node 22.18+ (built-in TypeScript
type stripping). Claude Code and Codex children need those CLIs installed and
logged in.

## Agent communication

`extensions/agent-comm/` is a small, pull-only messaging primitive.

- **Independent sessions.** Live root sessions of the same project (same git
  repository, worktrees included) can `list` and `send` to each other; e.g. tell
  session A "send B what you found", then tell B "check your inbox". `/comm
  join <scope>` shares a named scope across repositories, `/comm leave` makes a
  session private, `/comm status` shows the state. `PI_AGENT_COMM_SCOPE=off`
  disables it for one launch.
- **Subagents.** `subagent start` takes `communication`: `none` (default, fully
  isolated), `supervisor` (may message its parent) or `peers` (parent and
  siblings in the same `comm_group`). Claude Code and Codex children accept only
  `none`.
- **Delivery.** Messages are files (max 4000 characters); nothing is injected
  into a conversation. The tool and the footer (`✉ N unread`) say when mail
  waits; `agent_comm action=inbox` reads it.
- **Peer-message gate.** After a session reads messages from anyone but its own
  supervisor, every action that relies on a user grant (`/rm-rights`,
  `/ssh-rights`, `/hpc`, `/cc-agent`, `/codex-agent`, delegating to a pi child
  that inherits `/hpc` grants) asks the user first: Allow once, Allow until my
  next message, or Deny. Without a UI the action is blocked.
- **Limits.** This is harness isolation, not a sandbox. The safety guard blocks
  writes to the `agent-comm/` and `subagents/` state folders in the agent
  directory, but an agent with shell access can still read files or use other
  channels.

## Background shells

`bg_shell` is the local counterpart of `hpc_job_watch`:

- `start` (`command`, optional `label`, `cwd`, `check_after_minutes` default 60,
  `keep`) runs the command detached and logs to `$TMPDIR/pi-bg-shell/<session>/`.
  Nothing is killed for time; after `check_after_minutes` of awake time a
  check-in wakes the agent with the log tail, and it can `extend` or `stop`.
- `watch` (`pid`, optional `log_path`) attaches to an already running process.
- `list`, `output`, `extend`, `stop`.

On exit, a message with the exit code, runtime and log tail wakes an idle agent
or is steered into the current run. Processes survive `/reload`; on quit they
are killed unless started with `keep: true`. At most 4 run at once, `bg_shell
start` gets the same safety checks as `bash`, and long `bash` sleeps are refused
while one runs. `/bg`, `/bg log <id>` and `/bg stop <id|all>` manage them by hand.

## HPC hosts are machine-local

The package ships **no host names**. `/hpc` accepts only the aliases you
configure on each machine. Each alias must already work non-interactively as
`ssh <alias>`. The extension never reads your SSH configuration.

Create `hpc-hosts.json` in the Pi agent directory: `~/.pi/agent/` on macOS and
Linux, `%USERPROFILE%\.pi\agent\` on Windows, or `$PI_CODING_AGENT_DIR`.

```json
{
  "hosts": ["cluster-a", "cluster-b"],
  "guidance": [
    "- Load software with `module load` before running jobs.",
    "- In sbatch scripts, initialize the environment manager explicitly; batch shells are non-interactive."
  ]
}
```

| Key | Default | Purpose |
|---|---|---|
| `hosts` | `[]` | Allowed SSH aliases (lowercase letters, digits, `.`, `_`, `-`) |
| `guidance` | `[]` | Extra lines for the HPC system prompt, e.g. site conventions |
| `ssh`, `scp` | `"ssh"`, `"scp"` | Client executables, e.g. `"C:\\Program Files\\OpenSSH\\ssh.exe"` |
| `connectionSharing` | `true`; `false` on Windows | Pass `ControlMaster=auto` and `ControlPersist=60`. Windows OpenSSH does not support connection sharing |

Overrides: `PI_HPC_HOSTS=cluster-a,cluster-b` replaces `hosts`, and
`PI_HPC_CONFIG=/path/to/file.json` selects another file. Run `/reload` after changing either.

```text
/hpc allow cluster-a                            # authorize tools for this session (asks first)
/hpc connect cluster-a /scratch/$USER/project   # route read/write/edit/bash to the host
/hpc local                                      # local tools again; authorization kept
/hpc revoke all
```

Authorization never survives `/reload`, restart, or session replacement. The
extension never cancels submitted Slurm jobs.

### MFA clusters

Pi runs SSH with `BatchMode=yes`, so it cannot answer prompts. On macOS and
Linux, open a shared master connection in a terminal (`ControlMaster` and
`ControlPath` in your SSH config) before `/hpc allow`. Windows OpenSSH has no
connection sharing. For MFA hosts on Windows, run Pi inside WSL, or use
key-based authentication through `ssh-agent` if the site allows it.

## Windows notes

- Install [Git for Windows](https://git-scm.com/download/win). Pi uses Git Bash
  for the `bash` tool. To have the model use PowerShell instead, add
  `"defaultTools": ["read", "powershell", "edit", "write"]` to your settings. The
  safety guard covers both tools.
- `hpc_transfer` needs OpenSSH 9.0 or newer (`ssh -V`). If the built-in client is
  older, set `ssh` and `scp` in `hpc-hosts.json` to a newer install.
- `notify.ts` uses OSC 777. Terminals without support, possibly including Windows Terminal, ignore it,
  so it does no harm; WezTerm supports it.
- The `dataviz` palette checker needs Python. Use `py` or `python` if `python3`
  is not on `PATH`.
- Subagents, agent-comm and `bg_shell` are developed and tested on macOS and
  Linux. On native Windows the extra process-tree check against nested pi
  sessions is skipped (no `ps`); the environment-based check still applies. If
  the Claude Code or Codex CLIs do not start as subagents, run Pi inside WSL.
- `.gitattributes` forces LF line endings so checkouts behave the same on every OS.

## Private overlays

Keep private skills, host lists, and settings out of this repository. Layer them
in your own Pi settings instead:

```json
{
  "packages": [
    "git:github.com/David-Araripe/pi-toolkit@v0.1.0",
    "git:github.com/<owner>/private-pi-overlay"
  ]
}
```

Pi combines resource lists from user settings and project `.pi/settings.json`.

## Tests

Requires Node 22.19+ and an installed Pi 1.6 SDK. Subagent tests use fake CLIs and make no model requests. No `npm install` is needed.

```bash
node --test tests/*.test.mjs
# with a non-global Pi install
PI_TEST_AGENT_ROOT=/path/to/node_modules/@earendil-works/pi-coding-agent node --test tests/*.test.mjs
```

## License

MIT, except for files adapted from third parties. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
