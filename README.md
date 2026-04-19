# Rabbitor for Obsidian

Go down the rabbit hole of knowledge. Highlight passages in your notes and have AI-powered conversations about them — with any provider, right inside Obsidian.

Rabbitor brings per-highlight conversation threads, multi-provider AI, and branching edits to your vault. Every thread lives next to the note it came from, exportable as markdown.

> **Status:** pre-release (0.1.0). Not yet submitted to the Obsidian community plugin store. Install manually (see below). Desktop-only for now — mobile has not been tested.

## Screenshots

> TODO: add before submitting to the community plugin store. Drop files into `docs/screenshots/` and link them here.
>
> Checklist of shots to capture:
> - [ ] Hero shot — a note with several highlights + the right sidebar open on a thread
> - [ ] Selection tooltip / color picker over a text selection
> - [ ] Sidebar tabs (Highlights / Threads / Settings) with a populated thread list
> - [ ] Thread view showing streamed reply, message actions, and a branched conversation
> - [ ] Settings page — provider list with a couple of providers configured
> - [ ] Markdown export of a thread (screenshot of the exported file rendered in Obsidian)

## Features

- **Highlight & annotate** — Select any passage in a markdown note and attach a colored highlight with a conversation thread.
- **Multi-provider AI chat** — Anthropic, OpenAI, Google Gemini, OpenRouter, Ollama, or any OpenAI-compatible endpoint. Bring your own keys; they stay on your machine.
- **Branching conversations** — Fork from any message, regenerate alternate replies, keep the tree.
- **Document attachments** — Drop PDFs or markdown notes into a thread as context. Capability warnings flag models that can't handle PDFs.
- **Markdown export** — Export threads as plain markdown with branches and Obsidian embeds preserved.
- **Per-note storage** — Highlights and threads live in a sidecar JSON, so your notes stay clean.

## Installation

### Manual (current)

1. Download the latest `main.js`, `manifest.json`, and `styles.css` from [Releases](https://github.com/donjguido/rabbitor-for-obsidian/releases) (or build from source — see below).
2. Copy them to `<your-vault>/.obsidian/plugins/rabbitor/`.
3. In Obsidian: **Settings → Community plugins → Installed plugins → Enable Rabbitor**.

### BRAT (recommended for pre-release updates)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. Add beta plugin: `donjguido/rabbitor-for-obsidian`.
3. Enable Rabbitor in Community plugins.

### Community store

Not yet available.

## Usage

1. Open any markdown note.
2. Select a passage → a tooltip appears → pick a color to create a highlight.
3. Click the highlight (or open the right sidebar) to start a thread.
4. Configure your AI provider in **Settings → Rabbitor**.

## Configuration

Rabbitor supports these AI providers out of the box:

| Provider      | Requires | Notes |
|---------------|----------|-------|
| Anthropic     | API key  | Claude models |
| OpenAI        | API key  | GPT family |
| Google Gemini | API key  | Gemini family |
| OpenRouter    | API key  | Unified endpoint for many models |
| Ollama        | Local URL | Run models locally |
| Custom        | URL + optional key | Any OpenAI-compatible endpoint |

Keys are stored in Obsidian's plugin data directory on your machine. Rabbitor never phones home.

## Development

```bash
npm install
npm run dev          # build with sourcemaps, watch mode
npm run build        # production build
npx tsc --noEmit     # type-check

# Build and copy into a local vault for testing:
npm run install-plugin -- --vault "C:/path/to/vault"
```

### Project layout

```
src/main.ts       plugin entry (lifecycle, commands)
src/types.ts      shared interfaces
src/constants.ts  view IDs, colors, defaults
src/store/        annotation CRUD + debounced persistence
src/editor/       CM6 extensions (highlights, badges, selection tooltip)
src/views/        right-sidebar ItemView (Highlights / Threads / Settings)
src/settings/     PluginSettingTab
src/ai/           provider adapters
src/export/       markdown exporters
```

Obsidian loads three files: `manifest.json`, `main.js`, `styles.css`. esbuild bundles `src/main.ts` → `main.js` (CJS).

## Contributing

Issues and pull requests welcome. Before opening a PR:

- Run `npx tsc --noEmit` — must pass with no errors.
- Follow the patterns in [CLAUDE.md](./CLAUDE.md) (Obsidian CSS variables, `requestUrl` vs `fetch`, sentence-case UI text, etc.).
- New features should come with a short design note in `docs/superpowers/specs/` if behavior is non-obvious.

## License

[MIT](./LICENSE) © donjguido

## Related

- [Rabbitor web app](https://rabbitor.vercel.app) — browser-based annotator, same brand.
