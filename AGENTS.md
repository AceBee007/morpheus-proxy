# Agent Instructions

This project is a TypeScript and Node.js project. Agents working in this
repository should keep Git history clean and useful.

## Project Defaults

- Start each task by checking `git status --short --branch`.
- Inspect existing changes before editing. Treat unknown changes as user-owned.
- Do not revert, overwrite, amend, rebase, force-push, delete branches, or run
  destructive Git commands unless the user explicitly asks for that operation.
- Prefer the commands defined in `package.json` for TypeScript/Node.js checks.

## Dedicated Agents

- Use [agents/git-checkpoint-agent.md](agents/git-checkpoint-agent.md) when a
  task needs explicit branch, staging, commit, push, or PR checkpoint handling.
