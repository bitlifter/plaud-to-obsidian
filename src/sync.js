import fs from "fs/promises";
import { existsSync } from "fs";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { PlaudClient } from "./plaud-client.js";
import {
  formatNoteTitle,
  parsePlaudDate,
  formatDuration,
  generateNoteMarkdown,
  sanitizeFilename
} from "./extractor.js";
import { enrichMeetingData, loadEnvFile } from "./enricher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_STATE_FILE = path.join(ROOT_DIR, ".plaud-sync-state.json");

function parseArgs() {
  loadEnvFile();
  const args = process.argv.slice(2);
  const options = {
    vault: process.env.OBSIDIAN_VAULT_PATH || "",
    downloadAudio: true,
    limit: null,
    force: false,
    dryRun: false,
    minConfidence: 0.70,
    forceCloud: false,
    stateFile: DEFAULT_STATE_FILE
  };

  if (args[0] === "login") {
    return { login: true };
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--vault" && args[i + 1]) {
      options.vault = path.resolve(args[++i]);
    } else if (arg === "--no-audio") {
      options.downloadAudio = false;
    } else if (arg === "--limit" && args[i + 1]) {
      options.limit = parseInt(args[++i], 10);
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--min-confidence" && args[i + 1]) {
      options.minConfidence = parseFloat(args[++i]);
    } else if (arg === "--force-cloud") {
      options.forceCloud = true;
    } else if (arg === "--state" && args[i + 1]) {
      options.stateFile = path.resolve(args[++i]);
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Plaud-to-Obsidian Exporter

Commands:
  login                   Authenticate and link your Plaud account via official OAuth

Options:
  --vault <path>          Target Obsidian vault path (or set OBSIDIAN_VAULT_PATH in .env)
  --no-audio              Skip downloading .mp3 audio files
  --limit <n>             Export only first N new files
  --force                 Re-export files even if already in state
  --dry-run               Preview what would be exported without writing files
  --min-confidence <0-1>  Confidence threshold to trigger cloud LLM (default: 0.70)
  --force-cloud           Always use cloud LLM if key is present
  --state <path>          Path to state tracking JSON file
  --help, -h              Show this help message
      `);
      process.exit(0);
    }
  }

  return options;
}

async function loadState(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { last_sync: null, files: {} };
  }
}

async function saveState(filePath, state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
}

async function run() {
  loadEnvFile();
  const options = parseArgs();

  if (options.login) {
    console.log("Launching Plaud OAuth login via @plaud-ai/mcp...\n");
    const child = spawn("npx", ["-y", "@plaud-ai/mcp", "install", "--yes"], {
      stdio: "inherit",
      shell: true
    });
    child.on("close", (code) => {
      process.exit(code ?? 0);
    });
    return;
  }

  if (!options.vault) {
    console.error("\n[Error] No Obsidian vault path specified!");
    console.error("Please configure your target Obsidian vault using one of the following:");
    console.error("  1. In .env:        OBSIDIAN_VAULT_PATH=\"/path/to/your/obsidian-vault\"");
    console.error("  2. CLI flag:       npm run sync -- --vault \"/path/to/your/obsidian-vault\"");
    console.error("  3. Environment:    export OBSIDIAN_VAULT_PATH=\"/path/to/your/obsidian-vault\"\n");
    process.exit(1);
  }

  const hasCloudKey = Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);

  console.log("=== Plaud to Obsidian Sync ===");
  console.log(`Vault:           ${options.vault}`);
  console.log(`Audio sync:      ${options.downloadAudio ? "ENABLED (.mp3)" : "DISABLED"}`);
  console.log(`AI Enrichment:   ${hasCloudKey ? "Gemini 3.6 Flash (SOTA Precision)" : "Offline Heuristics"}`);
  console.log(`Dry run:         ${options.dryRun ? "YES" : "NO"}`);
  console.log(`Force:           ${options.force ? "YES" : "NO"}`);
  if (options.limit) console.log(`Limit:           ${options.limit}`);
  console.log("--------------------------------");

  const notesDir = path.join(options.vault, "Notes");
  const attachmentsDir = path.join(options.vault, "Attachments");

  if (!options.dryRun) {
    await fs.mkdir(notesDir, { recursive: true });
    await fs.mkdir(attachmentsDir, { recursive: true });
  }

  const client = new PlaudClient();
  const state = await loadState(options.stateFile);

  console.log("Fetching recordings list from Plaud...");
  const allFiles = await client.listAllFiles();
  console.log(`Found ${allFiles.length} total recordings in Plaud.`);

  // Filter pending files
  let pending = allFiles.filter((file) => {
    if (options.force) return true;
    const existing = state.files[file.id];
    if (!existing) return true;

    const noteExists = existsSync(path.join(notesDir, existing.note_filename));
    if (!noteExists) return true;

    if (file.name !== existing.name) return true;
    if (!existing.has_summary || !existing.has_transcript) return true;

    return false;
  });

  console.log(`Pending recordings to sync: ${pending.length}`);

  if (options.limit && options.limit > 0) {
    pending = pending.slice(0, options.limit);
    console.log(`Processing limited batch of ${pending.length} recordings.`);
  }

  if (pending.length === 0) {
    console.log("Vault is up to date! No new recordings to sync.");
    return;
  }

  let successCount = 0;
  let audioDownloadCount = 0;
  let errorCount = 0;

  for (let i = 0; i < pending.length; i++) {
    const item = pending[i];
    const prefix = `[${i + 1}/${pending.length}]`;
    const dur = formatDuration(item.duration);
    console.log(`\n${prefix} Processing: "${item.name}" (${dur}) [ID: ${item.id}]`);

    try {
      const fullRecord = await client.getFile(item.id);

      // Resolve summary
      let summaryContent = "";
      const noteList = fullRecord.note_list || [];
      const sumNote = noteList.find((n) => n.data_type === "auto_sum_note");
      if (sumNote) {
        summaryContent = await client.loadBlockContent(sumNote);
      }

      // Resolve transcript
      let transcriptSegments = [];
      const sourceList = fullRecord.source_list || [];
      const txBlock = sourceList.find((s) => s.data_type === "transaction" || s.data_type === "transaction_polish");
      if (txBlock) {
        const rawTx = await client.loadBlockContent(txBlock);
        if (rawTx) {
          try {
            const parsed = JSON.parse(rawTx);
            if (Array.isArray(parsed)) transcriptSegments = parsed;
          } catch {}
        }
      }

      // Resolve outline
      let outlineData = [];
      const outlineBlock = sourceList.find((s) => s.data_type === "outline");
      if (outlineBlock) {
        const rawOutline = await client.loadBlockContent(outlineBlock);
        if (rawOutline) {
          try {
            const parsed = JSON.parse(rawOutline);
            if (Array.isArray(parsed)) outlineData = parsed;
          } catch {}
        }
      }

      // Enrich Meeting (Speaker detection & Org extraction)
      // When cloud key is available, use cloud directly for SOTA accuracy
      const enrichment = await enrichMeetingData({
        transcriptSegments,
        summaryContent,
        title: item.name,
        minConfidence: options.minConfidence,
        forceCloud: hasCloudKey || options.forceCloud
      });

      console.log(`  - Enrichment [${enrichment.source}]: Conf=${enrichment.confidence}`);
      if (Object.keys(enrichment.speakerMap).length > 0) {
        const mapped = Object.entries(enrichment.speakerMap)
          .filter(([raw, resolved]) => raw !== resolved)
          .map(([raw, resolved]) => `${raw} -> ${resolved}`)
          .join(", ");
        if (mapped) console.log(`    Speakers: ${mapped}`);
      }
      if (enrichment.people.length > 0) {
        console.log(`    People:   ${enrichment.people.slice(0, 8).join(", ")}${enrichment.people.length > 8 ? "..." : ""}`);
      }
      if (enrichment.organizations.length > 0) {
        console.log(`    Orgs:     ${enrichment.organizations.join(", ")}`);
      }

      // Prepare filenames
      const { date, time } = parsePlaudDate(item.start_time || item.start_at || item.created_at);
      const cleanTitle = formatNoteTitle(item.name, date, time);
      const noteFileName = `${cleanTitle}.md`;
      const noteFilePath = path.join(notesDir, noteFileName);

      // Prepare audio filename
      let audioFileName = null;
      let audioDownloaded = false;

      if (options.downloadAudio && fullRecord.presigned_url) {
        const safeAudioBase = sanitizeFilename(item.name, 80);
        audioFileName = `${date} ${safeAudioBase}.mp3`;
        const audioFilePath = path.join(attachmentsDir, audioFileName);

        if (!options.dryRun) {
          if (existsSync(audioFilePath)) {
            console.log(`  - Audio file already exists: ${audioFileName}`);
          } else {
            process.stdout.write(`  - Downloading audio (${dur})... `);
            await client.downloadFile(fullRecord.presigned_url, audioFilePath);
            console.log("Done.");
            audioDownloaded = true;
            audioDownloadCount++;
          }
        } else {
          console.log(`  [dry-run] Would download audio: ${audioFileName}`);
        }
      }

      // Generate Note
      const { markdown, metadata } = generateNoteMarkdown({
        fileData: fullRecord,
        summaryContent,
        transcriptSegments,
        outlineData,
        audioFileName,
        enrichment
      });

      if (!options.dryRun) {
        const existing = state.files[item.id];
        if (existing && existing.note_filename && existing.note_filename !== noteFileName) {
          const oldPath = path.join(notesDir, existing.note_filename);
          if (existsSync(oldPath)) {
            await fs.unlink(oldPath);
            console.log(`  - Replaced older note: ${existing.note_filename} -> ${noteFileName}`);
          }
        }

        await fs.writeFile(noteFilePath, markdown, "utf-8");
        console.log(`  - Wrote note: Notes/${noteFileName}`);

        // Update state
        state.files[item.id] = {
          name: item.name,
          date,
          note_filename: noteFileName,
          audio_filename: audioFileName,
          duration: item.duration,
          people: metadata.people,
          organizations: metadata.organizations,
          topics: metadata.topics,
          type: metadata.noteType,
          confidence: enrichment.confidence,
          speaker_detection: enrichment.source,
          has_summary: Boolean(summaryContent && summaryContent.trim()),
          has_transcript: Boolean(transcriptSegments && transcriptSegments.length > 0),
          synced_at: new Date().toISOString()
        };
        state.last_sync = new Date().toISOString();
        await saveState(options.stateFile, state);
      } else {
        console.log(`  [dry-run] Would write note: Notes/${noteFileName}`);
      }

      successCount++;
    } catch (err) {
      errorCount++;
      console.error(`  ERROR processing ${item.id}:`, err.message);
    }
  }

  console.log("\n================================");
  console.log("Sync Complete!");
  console.log(`Notes created/updated: ${successCount}`);
  console.log(`Audio files downloaded: ${audioDownloadCount}`);
  console.log(`Errors:                 ${errorCount}`);
  console.log("================================");
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
