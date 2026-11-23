# changes-panel

A Claude Code mod that adds a **Changes** pane beside the chat: a commit-style view of your project's git changes, and a GitLab-style commit graph.

- **Uncommitted** and **Last commit** open with a summary card (the commit's hash, message, author and age, or the working tree), the file and line totals, and a bar splitting the change into added, modified, renamed, deleted and untracked files. Below it, the files sit in a folder tree with drawn guide lines, folder and file icons coloured by language, `+added −removed` per file and per folder, a change-size bar and a status chip. Click a folder to fold it; click a file to open it in the desktop app's own diff pane, at that file's uncommitted change or at the change its commit made.
- **Graph** draws the history of all branches as coloured lanes, with merge commits, branch and tag labels, author and age. Click a commit to see its files and diffs; **Load more commits** pages further back.

- **Project line** sits in a band just above the prompt, always in view: the project name and **Context ▸**, which expands how much of the context window the conversation uses, by category.

The current branch shows at the right of the view buttons. The list refreshes by itself after Claude edits a file or runs a command. Type `/changes` to reopen the pane.

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
