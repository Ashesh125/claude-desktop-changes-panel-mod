# changes-panel

A Claude Code mod that adds a **Changes** pane beside the chat: a commit-style view of your project's git changes, a GitLab-style commit graph, and a small command box.

- **Uncommitted** lists every changed, staged and untracked file with its status (M, A, D, R, U). Click a file to see its diff; click again to close it.
- **Last commit** shows the files changed in `HEAD` and their diffs.
- **Graph** draws the history of all branches as coloured lanes, with merge commits, branch and tag labels, author and age. Click a commit to see its files and diffs; **Load more commits** pages further back.
- **Terminal** runs a one-shot command through `zsh -i` in the project folder, so your `~/.zshrc` aliases and functions work (for example `gst`, `git add -A` or `git commit -m "…"`), and shows its output. Interactive programs such as `vim` are not supported.

The list refreshes by itself after Claude edits a file or runs a command, and after each command you run. Type `/changes` to reopen the pane.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install changes-panel --marketplace Ashesh125/claude-desktop-changes-panel-mod
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```bash
claude plugin install changes-panel --marketplace Ashesh125/claude-desktop-changes-panel-mod
```

## Requirements

`git` on your `PATH`, and a project that is a git repository. The graph is drawn as SVG in the desktop app, VS Code and mobile, and as text in the terminal.
