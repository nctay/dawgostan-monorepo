# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- Create an issue with `gh issue create`.
- Read an issue with `gh issue view <number> --comments`.
- List issues with `gh issue list`.
- Comment with `gh issue comment`.
- Apply or remove labels with `gh issue edit`.
- Close with `gh issue close`.
- Infer the repository from `git remote -v`.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Skill operations

- “Publish to the issue tracker” means creating a GitHub issue.
- “Fetch the relevant ticket” means reading it with `gh issue view`.
- Use GitHub native issue dependencies for blocking relationships.
- If native dependencies are unavailable, add `Blocked by: #<number>` to the issue body.
- A ticket is ready only when all blocking issues are closed.
