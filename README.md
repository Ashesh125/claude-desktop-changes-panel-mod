# changes-panel

A Claude Code mod that adds a **Changes** pane beside the chat: a commit-style view of your project's git changes, and a GitLab-style commit graph.

- **Uncommitted** and **Last commit** open with a summary card (the commit's hash, message, author and age, or the working tree), the file and line totals, and a bar splitting the change into added, modified, renamed, deleted and untracked files. Below it, the files sit in a folder tree with drawn guide lines, folder and file icons coloured by language, `+added −removed` per file and per folder, a change-size bar and a status chip. Click a folder to fold it; click a file to see its diff right in the pane, one file at a time: its uncommitted change, or the change its commit made. Only the changed lines and three lines around them show; the unchanged stretches between fold into **⋯ Show N hidden lines** (with **↓ 20 more** / **↑ 20 more** on long ones), and **Whole file** shows all of it with the changes marked. **‹ ›** step to the previous and next file, **← Files** goes back to the list, and an open diff reloads as Claude edits the file.
- **Graph** draws the history of all branches as coloured lanes, with merge commits, branch and tag labels, author and age. Click a commit to see its files and diffs; **Load more commits** pages further back.

- **OpenProject** (`/open-project`, or the **OpenProject** button above the prompt) shows your OpenProject work. The first page has a card for each project you are a member of: its open work and yours, how it splits across the board's columns, your time this week, and the local folder it links to (matched by name, changeable), with **Open board** and **Open in Claude Code**. A project's board has four columns, To do, Doing, Review and Done (closed in the last two weeks), and an **All / Mine** filter. Each card moves one column with **◀ ▶** (setting the column's status in OpenProject; **⋯** picks any status), runs a timer, and books time in OpenProject with **Log time**, which offers the timer's time or an estimate from your commits today. You and Claude can add tasks of your own to a board; they stay in the pane.
- **GitLab** (`/gitlab-projects`, or the **GitLab** button above the prompt) shows your GitLab work through the `glab` CLI. The first page has a card for each project with work for you (issues assigned to you, your open merge requests, merge requests waiting for your review), the session's own repository, and any you add with **Find another of your GitLab projects**: your issues, MRs and reviews there, the default branch's latest pipeline, your time this week, and the local folder it links to (matched by its `origin` remote, changeable), with **Open board**, **Open in Claude Code** and **Open in GitLab**. A project's board takes its columns from the project's own issue board, between **Open** and **Closed** (closed in the last two weeks), with an **All / Mine** filter. **◀ ▶** moves an issue one column (swapping its board label, or closing and reopening it), **⋯** picks any column, opens it in GitLab or starts a Claude Code session on it, and **Log time** adds the timer's time, or an estimate from your commits, to the issue's time spent in GitLab. Below the board: the project's open merge requests, each with **Review in Claude Code**, and its latest pipelines. Claude can list your GitLab work with the `list_gitlab_work` tool.
- **Project line** sits in a band just above the prompt, always in view: the project name, **Context ▸**, which expands how much of the context window the conversation uses, by category, the **OpenProject** and **GitLab** buttons, and the running timer with its task, when one is running.

The current branch shows at the right of the view buttons. The list refreshes by itself after Claude edits a file or runs a command. Type `/changes` to reopen the pane.

## OpenProject

The OpenProject pane reads the projects you are a member of and their work packages, sets a work package's status when you move its card, and books the time you log as a time entry. To connect, save your instance's address and an API key (OpenProject: *My account → Access tokens*) in a file only you can read:

```bash
mkdir -p ~/.config/changes-panel && chmod 700 ~/.config/changes-panel
printf '{"url": "https://openproject.example.com", "apiKey": "YOUR_KEY"}' > ~/.config/changes-panel/openproject.json
chmod 600 ~/.config/changes-panel/openproject.json
```

It syncs when a session starts, when you open the pane, every 15 minutes, and on **Sync**.

## GitLab

The GitLab pane uses [`glab`](https://gitlab.com/gitlab-org/cli) and its login, so the mod holds no GitLab token. Log in once:

```bash
glab auth login
```

It uses the first host `glab auth status` shows you logged in to. To pick another, name it in `~/.config/changes-panel/gitlab.json`:

```bash
printf '{"host": "gitlab.example.com"}' > ~/.config/changes-panel/gitlab.json
```

It syncs when a session starts, when you open the pane, every 15 minutes, and on **Sync**; a project's board loads when you open it.

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

`git` on your `PATH`, and a project that is a git repository. The GitLab pane needs `glab`, logged in. The graph is drawn as SVG in the desktop app, VS Code and mobile, and as text in the terminal.
