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
| `extensions/safety-guard.ts` | Blocks file removal (`rm`, `Remove-Item`, `del`, `rd`, …), access to the local SSH directory, and direct `ssh`/`scp`/`sftp`, until you run `/rm-rights` or `/ssh-rights` |
| `extensions/hpc-mode.ts` | `/hpc`: explicit per-session authorization of SSH hosts, remote workspaces, `hpc_exec`, `hpc_transfer`, and Slurm job watches |
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

Requires Node 22.19+ and an installed Pi 1.5 SDK. No `npm install` is needed.

```bash
node --test tests/*.test.mjs
# with a non-global Pi install
PI_TEST_AGENT_ROOT=/path/to/node_modules/@earendil-works/pi-coding-agent node --test tests/*.test.mjs
```

## License

MIT, except for files adapted from third parties. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
