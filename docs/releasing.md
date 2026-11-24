# Releasing

A release is a push to main that changes the version. The release commit
bumps `package.json`, the skill's `npx -y repotrail@<version>` pins and
`harness/.claude-plugin/plugin.json` together, and `pnpm test` checks that
they match.

When a push to main changes the version,
[`.github/workflows/release.yml`](../.github/workflows/release.yml) tests and
builds the pushed commit, then publishes whatever doesn't have that version
yet:

- the `repotrail` npm package (`dist/npm`, assembled by `scripts/pack-npm.mjs`)
- the extension on the VS Code Marketplace
- a GitHub release `v<version>` with the .vsix attached and the version's
  changelog section as its notes

Pushes that don't change the version stop after the first step.

To see what's out for the current version:

```bash
node scripts/release-status.mjs
```

## When a run fails

If the cause was outside the code, such as a registry outage or missing
setup, fix it and choose "Re-run failed jobs" on the run. It rebuilds nothing
that succeeded and publishes only what's still missing, from the same commit.
A run that shows as cancelled was replaced by a later push while it waited;
re-run it the same way.

If the code needs a fix, the failed version stays tied to its commit, so
release the fix as the next patch version.

A failed npm or Marketplace publish doesn't stop the other, and the GitHub
release gets the .vsix either way. If the Marketplace keeps failing, upload
that file on the
[publisher page](https://marketplace.visualstudio.com/manage/publishers/repotrail).

## Trusted publishing

The workflow stores no npm or Marketplace token. Both registries trust
GitHub's OIDC token from this repository's `release.yml`, and only the
publish job can request one. Renaming the workflow file stops publishing
until both trust entries are recreated with the new name.

Both entries check only the repository and the file name. If anyone else
gets write access to the repository, also put the publish job in a GitHub
environment that only main can use, and add that environment to both
entries.

### One-time setup

Do this before the next version bump reaches main. Merging the workflow
itself publishes nothing, because it doesn't change the version.

1. **npm: the first version, by hand.** npm only trusts a workflow for a
   package that already exists.

   ```bash
   npm login
   pnpm package:npm
   npm publish ./dist/npm
   ```

2. **Marketplace.** On the
   [publisher page](https://marketplace.visualstudio.com/manage/publishers/repotrail),
   open Trusted Publishing and create a policy. Use repository owner
   `ilackarms`, repository `repotrail`, workflow `release.yml` and no
   environment. This needs no Azure DevOps organization or personal access
   token.

3. **npm trust, within 2 days of the next release.** A new trust entry
   expires if no publish uses it within 2 days, so add it shortly before the
   version bump merges. The command needs npm 11.15.0 or later.

   ```bash
   npm trust github repotrail --repo ilackarms/repotrail --file release.yml --allow-publish
   ```

   On npmjs.com, the same entry is under the package's settings, Trusted
   publishing, GitHub Actions. Allow `npm publish`: new entries otherwise
   allow only staged publishing.
