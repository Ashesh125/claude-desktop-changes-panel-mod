# changes-panel

A Claude Code mod that adds a **Changes** pane beside the chat: a commit-style view of your project's git changes, and a GitLab-style commit graph.

- **Uncommitted** and **Last commit** open with a summary card (the commit's hash, message, author and age, or the working tree), the file and line totals, and a bar splitting the change into added, modified, renamed, deleted and untracked files. Below it, the files sit in a folder tree with drawn guide lines, folder and file icons coloured by language, `+added −removed` per file and per folder, a change-size bar and a status chip. Click a folder to fold it; click a file to open it in the desktop app's own diff pane, at that file's uncommitted change or at the change its commit made.
- **Graph** draws the history of all branches as coloured lanes, with merge commits, branch and tag labels, author and age. Click a commit to see its files and diffs; **Load more commits** pages further back.

- **Projects** (`/projects`, or the **Projects** button above the prompt) shows your OpenProject work. The first page has a card for each project you are a member of: its open work and yours, how it splits across the board's columns, your time this week, and the local folder it links to (matched by name, changeable), with **Open board** and **Open in Claude Code**. A project's board has four columns, To do, Doing, Review and Done (closed in the last two weeks), and an **All / Mine** filter. Each card moves one column with **◀ ▶** (setting the column's status in OpenProject; **⋯** picks any status), runs a timer, and books time in OpenProject with **Log time**, which offers the timer's time or an estimate from your commits today. You and Claude can add tasks of your own to a board; they stay in the pane.
- **Project line** sits in a band just above the prompt, always in view: the project name and **Context ▸**, which expands how much of the context window the conversation uses, by category.

The current branch shows at the right of the view buttons. The list refreshes by itself after Claude edits a file or runs a command. Type `/changes` to reopen the pane.

## OpenProject

The Projects pane reads the projects you are a member of and their work packages, sets a work package's status when you move its card, and books the time you log as a time entry. To connect, save your instance's address and an API key (OpenProject: *My account → Access tokens*) in a file only you can read:

```bash
mkdir -p ~/.config/changes-panel && chmod 700 ~/.config/changes-panel
printf '{"url": "https://openproject.example.com", "apiKey": "YOUR_KEY"}' > ~/.config/changes-panel/openproject.json
chmod 600 ~/.config/changes-panel/openproject.json
```

It syncs when a session starts, when you open the pane, every 15 minutes, and on **Sync**.

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
