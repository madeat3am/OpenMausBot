# GitHub execution policy

GitHub Actions is intentionally disabled for the `madeat3am/OpenMausBot` fork.
This fork does not use GitHub-hosted runners or automatic GitHub release jobs.
The fork's former GitHub release, platform-package, and legacy release-mirroring
surfaces are retired under the Citadel OpenMausBot retirement decision. They do
not have a replacement execution owner.

Run the repository checks on an operator-owned machine:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
```

Do not add a workflow that selects a GitHub-hosted runner. Any future GitHub
execution must first have an explicitly qualified, free self-hosted runner and
an operator decision to re-enable Actions for this repository.
