# Plaud to Obsidian Export Pipeline

Automated export pipeline that syncs recordings, AI summaries, timestamped transcripts, and audio files from Plaud directly into an Obsidian vault configured with Kepano's schema and Obsidian Bases.

## Features

- **Plaud OAuth Integration**: Reads authentication tokens from `~/.plaud/tokens-mcp.json` and automatically refreshes them when expired.
- **Full Fidelity Audio**: Downloads original 128 kbps `.mp3` audio files into `Attachments/` and embeds an inline media player at the top of each note (`![[Attachments/<file>.mp3]]`).
- **Cascade Speaker & Entity Enrichment**:
  - **Tier 1 (Offline Heuristics)**: Uses conversational turn-taking, vocative addresses, and entity recognition to map generic speaker labels (`Speaker 1` -> `Alice`, `Speaker 2` -> `Bob`) and extract business organizations completely locally with zero API costs.
  - **Confidence Scoring**: Computes a meeting-wide confidence score (0.0 to 1.0) weighted by speaker participation.
  - **Tier 2 (Cloud LLM Fallback)**: If confidence falls below threshold (default `0.70`), and a `GEMINI_API_KEY` or `OPENAI_API_KEY` is present in `.env`, it automatically calls the Cloud LLM to resolve ambiguous speakers.
- **Kepano Obsidian Schema**: Generates frontmatter compatible with Kepano's `Meetings.base`, automatically populating `date`, `time`, `duration`, `people`, `org`, `topics`, and `categories: ["[[Meetings]]"]`.
- **Collapsible Transcript**: Wraps timestamped verbatim transcripts with identified speaker names into native Obsidian callouts (`> [!quote]- Full Transcript (34m 47s)`).
- **Stateful Incremental Sync**: Tracks synced IDs in `.plaud-sync-state.json`, ensuring repeat runs only process new recordings, while automatically detecting when previously un-transcribed notes receive summaries in Plaud.

## Quickstart for New Users

### 1. Authenticate with Plaud
Link your Plaud device account via official OAuth:
```bash
npm run login
```
*(A browser will open asking you to authorize; tokens are securely saved to `~/.plaud/tokens-mcp.json` and auto-refreshed).*

### 2. Configure Your Obsidian Vault
Create a `.env` file from the example:
```bash
cp .env.example .env
```
Set your vault path in `.env`:
```env
OBSIDIAN_VAULT_PATH=/path/to/your/obsidian-vault
# Optional: add a Gemini or OpenAI key for cloud speaker disambiguation
GEMINI_API_KEY=your_key_here
```

### 3. Sync
```bash
npm run sync
```
Your notes will appear under `Notes/` and audio recordings under `Attachments/`.

---

## Command Line Usage & Distribution

You can install and run this tool globally across your system or distribute it via npm:

### Local Global CLI (Instant)
```bash
npm link
plaud-export --vault "/path/to/vault"
```

### Run via npx / npm package
When published to npm (`npm publish`):
```bash
npx plaud-export --vault "/path/to/vault"
```

### CLI Flags & Options
```bash
# Preview sync without writing any files
plaud-export --dry-run

# Sync notes and metadata only (skip downloading audio)
plaud-export --no-audio

# Sync only the latest N recordings
plaud-export --limit 10

# Force re-export and re-enrich existing notes
plaud-export --force

# Custom confidence threshold for cloud LLM fallback (0.0 to 1.0)
plaud-export --min-confidence 0.80

# Always use cloud LLM when key is present
plaud-export --force-cloud
```

---

## AI Speaker & Entity Resolution
* **100% Zero-Dependency Core**: Built with native Node.js 18+ ESM (`fetch`, `crypto`, `fs/promises`).
* **Offline Heuristics (Tier 1)**: Analyzes conversational turns, vocative mentions (*"Thanks Alice"*, *"Bob here"*), and structure with zero cost.
* **Gemini 3.6 Flash (Tier 2)**: When heuristic confidence is below threshold, automatically invokes Gemini 3.6 Flash to deduce attendee identities, replacing generic `Speaker 1`, `Speaker 2` labels throughout the summaries, action items, and transcripts.

---

## Disclaimer

This is an independent open-source community tool. It is not affiliated with, officially maintained by, or endorsed by Plaud.ai (Nicebuild LLC) or Obsidian (Dynalist Inc.). All product names, logos, and brands are property of their respective owners.

Users are responsible for their own third-party API usage (e.g. Google Gemini API keys). The tool includes a zero-cost offline heuristic mode by default.

---

## License

[MIT](LICENSE) © 2026 bitlifter

