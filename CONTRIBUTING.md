# Contributing

Thanks for your interest in Rabbitor. Bug reports, feature ideas, and pull requests are all welcome.

## Reporting issues

Before opening an issue:

- Search existing [issues](https://github.com/donjguido/rabbitor-for-obsidian/issues) first.
- Include your Obsidian version, OS, and Rabbitor version.
- For bugs, describe what you did, what you expected, and what happened. A short screen recording helps.

## Development setup

```bash
git clone https://github.com/donjguido/rabbitor-for-obsidian.git
cd rabbitor-for-obsidian
npm install
npm run dev
```

To test in a real vault, symlink or copy the built output:

```bash
npm run install-plugin -- --vault "/path/to/your/vault"
```

Then reload Obsidian (`Ctrl/Cmd+R`).

## Pull requests

- Branch from `master`.
- Keep PRs focused — one feature or fix per PR.
- Run `npx tsc --noEmit` — must pass with no errors.
- Follow Obsidian plugin conventions:
  - Obsidian CSS variables (not hardcoded colors)
  - `requestUrl()` instead of `fetch()` for network calls
  - Sentence-case UI strings
  - `createDiv`/`createEl` instead of `innerHTML`
  - Touch targets ≥ 44×44px, `:focus-visible` on interactive elements
- Add a line to `CHANGELOG.md` under `## [Unreleased]`.

## Commit messages

Rough convention: `type: short summary`, where `type` is one of `feat`, `fix`, `refactor`, `docs`, `chore`, `test`. Examples:

```
feat: render document attachments in chat history
fix: clean focus listener on file pick
```

## Releasing (maintainers)

1. Bump `version` in `manifest.json` and `package.json`.
2. Add the new version to `versions.json` (maps version → minAppVersion).
3. Update `CHANGELOG.md` — move `[Unreleased]` items under the new version.
4. Commit, tag (`git tag 0.1.1`), and push the tag. The `release.yml` workflow builds and publishes the GitHub release.
