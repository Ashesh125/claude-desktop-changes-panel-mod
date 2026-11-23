# changes-panel

A Claude Code mod that adds a **Changes** pane beside the chat: a commit-style view of your project's git changes, and a GitLab-style commit graph.

- **Uncommitted** lists every changed, staged and untracked file, grouped by folder, with its status (M, A, D, R, U), its `+added −removed` lines and a bar sized against the biggest change. Click a file to open just that file's diff, then step through the rest with **‹ Prev** / **Next ›**.
- **Last commit** shows the files changed in `HEAD` and their diffs.
- **Graph** draws the history of all branches as coloured lanes, with merge commits, branch and tag labels, author and age. Click a commit to see its files and diffs; **Load more commits** pages further back.

- **Project line** sits in a band just above the prompt, always in view: the project, branch and model, and **Context ▸**, which expands how much of the context window the conversation uses, by category.

The list refreshes by itself after Claude edits a file or runs a command. Type `/changes` to reopen the pane.

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
