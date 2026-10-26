# Releasing

How a version goes out. The goal is that every published version is reproducible
from a tag, and that the repository, npm, and GitHub never disagree about what
`latest` means.

Versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html);
changes are recorded in [CHANGELOG.md](CHANGELOG.md) following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Checklist

```bash
# 1. Land the work: code, tests, docs.
# 2. Add the CHANGELOG section for the version you are about to release.
# 3. Set the version.
npm pkg set version=<version>     # e.g. 0.1.4

# 4. Verify locally.
npm ci
npm test                  # hermetic tests, offline, no credentials
npm run typecheck

# 5. Verify packaging.
npm pack --dry-run        # read the file list: nothing extra, nothing missing
npm publish --dry-run     # no warnings, right version, public

# 6. Commit and tag together.
git add -A
git commit -m "chore(release): <version>"
git tag -a v<version> -m "pi-neo-subagents <version>"
git push origin main --follow-tags

# 7. Wait for CI on the pushed commit to turn green.
# 8. Publish. Needs the 6-digit OTP from the authenticator app.
npm publish

# 9. Verify what is actually on the registry.
npm view pi-neo-subagents@<version> version dist.fileCount dist.unpackedSize engines
```

Then update the GitHub Release — **only the newest version gets one**, see below.

## What ships

`package.json` → `files` decides the tarball contents (`index.ts`, `src`,
`README.zh-CN.md`, `CHANGELOG.md`). `README.md`, `LICENSE`, and `package.json`
are always included by npm; `RELEASING.md`, `test/`, `docs/`, `scripts/`, and
`.github/` are not shipped.

Two fields are easy to get wrong:

| Field | Requirement |
|---|---|
| `pi.extensions` | Must point at `./index.ts`; without it the package does nothing when installed. |
| `engines.node` | Must not be looser than the host SDK's floor (`pi-coding-agent` requires `>=22.19.0`). A looser range installs on runtimes where the extension cannot load. |

`@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` stay in
`peerDependencies` with a `*` range. They must never move to `dependencies`: Pi
provides them at runtime, and a second copy triggers Pi's duplicate-module
warning.

## GitHub Releases

Tag every version, but create a GitHub Release **only for the newest one** — one
page that users and watchers look at, instead of a page per patch. Publish the
Release after the npm publish, so the notes never advertise a version that is not
installable yet.

Release notes are written from the user's point of view: what changed for the
person installing it, plus the upgrade command and how it was verified. When a
version skipped a Release, fold its user-visible changes into the next one so
nothing is lost (and point the diff at the last release that did exist).

```bash
# diff against the previous *released* tag
https://github.com/hmtx1024/pi-neo-subagents/compare/v0.1.1...v0.1.3
```

## Verifying a release

A version is not released until it installs from the registry somewhere that is
not the development checkout:

```bash
mkdir /tmp/verify && cd /tmp/verify
mkdir -p .pi/agents && printf -- '---\ndescription: Reviews code\ntools: read\n---\n\nYou are a careful code reviewer.\n' > .pi/agents/reviewer.md
pi install npm:pi-neo-subagents@<version> -l --approve
# then start pi and run /subagents — the definition above should be listed
```

Two behaviours worth remembering:

- `pi update --extensions` did **not** move a lock-pinned project install during
  testing. Reinstall explicitly with `@version`, or clear the project's
  `.pi/npm/package-lock.json` first.
- `npm` read replicas lag by up to a minute after a publish. If `npm view` still
  shows the previous version, check the tarball URL directly
  (`https://registry.npmjs.org/pi-neo-subagents/-/pi-neo-subagents-<version>.tgz`)
  before concluding the publish failed.

## When the live suite matters

`npm test` is hermetic and always runs in CI. It cannot catch provider-side
behaviour, so run the live suite manually before releasing anything that touches
delegation, streaming, usage accounting, or cancellation:

```bash
npm run test:live                      # real provider, ~25s, a few thousand tokens
PI_NEO_SUBAGENTS_LIVE_MODEL=provider/model npm run test:live
```

## Things that are irreversible

- A published version cannot be reused or deleted (only deprecated). Bump and
  publish again instead.
- A pushed tag is public. If a release commit is wrong, tag the fix with the next
  patch version rather than moving the tag.
- Pushing to `main` is what triggers CI; push the release commit before
  publishing so a broken release is caught while it is still only a tag.
