# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Document attachments in chat (PDFs, markdown) with capability warnings for models lacking PDF support
- Markdown export emits Obsidian embeds for document parts
- Styled attachment chips for context and document parts

### Fixed
- Focus listener cleanup on file pick
- Removed dead `loadImagePart` code path

## [0.1.0] - 2026-04-08

Initial release.

### Added
- Highlight passages in Markdown notes with a four-color palette
- Per-highlight conversation threads stored alongside notes
- Right-sidebar view with Highlights, Threads, and Settings tabs
- Multi-provider AI chat: Anthropic, OpenAI, Gemini, OpenRouter, Ollama, custom OpenAI-compatible endpoints
- Streaming responses
- Conversation branching: fork and regenerate from any message
- Markdown export of threads with branch structure preserved
