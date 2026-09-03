export function sanitizeFilename(name, maxLength = 100) {
  if (!name || !name.trim()) return "Untitled Recording";

  let clean = name
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  clean = clean.replace(/[,. ]+$/, "");

  if (clean.length > maxLength) {
    clean = clean.slice(0, maxLength).trim().replace(/[,. ]+$/, "");
  }

  return clean || "Untitled Recording";
}

export function formatNoteTitle(rawName, date, time = "00:00", maxLength = 100) {
  let clean = (rawName || "").trim();

  if (clean.match(/^\d{4}[-/]\d{2}[-/]\d{2}\s+\d{2}:\d{2}(?::\d{2})?$/)) {
    return clean.replace(/:/g, "-");
  }
  if (clean.match(/^\d{2}:\d{2}(?::\d{2})?$/)) {
    return `${date} ${clean.replace(/:/g, "-")}`;
  }

  clean = clean.replace(/^\d{2}[-/]\d{2}\s*(?:Meeting:?\s*)?/i, "");
  clean = clean.replace(/^\d{4}[-/]\d{2}[-/]\d{2}\s*(?:Meeting:?\s*)?/i, "");
  clean = clean.replace(/^Meeting:?\s*/i, "");

  clean = sanitizeFilename(clean, maxLength);

  if (!clean) {
    return `${date} ${time.replace(/:/g, "-")} Recording`;
  }

  return `${date} ${clean}`;
}

export function parsePlaudDate(dateStr) {
  if (!dateStr) {
    const now = new Date();
    return {
      date: now.toISOString().slice(0, 10),
      time: now.toISOString().slice(11, 16),
      iso: now.toISOString()
    };
  }

  let d;
  if (typeof dateStr === "number") {
    d = new Date(dateStr > 1e11 ? dateStr : dateStr * 1000);
  } else if (typeof dateStr === "string" && dateStr.length === 10 && dateStr.includes("-")) {
    d = new Date(`${dateStr}T12:00:00Z`);
  } else {
    d = new Date(dateStr);
  }

  if (isNaN(d.getTime())) {
    d = new Date();
  }

  const pad = (n) => String(n).padStart(2, "0");
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());

  return {
    date: `${year}-${month}-${day}`,
    time: `${hours}:${minutes}`,
    iso: d.toISOString()
  };
}

export function formatDuration(ms) {
  if (!ms || ms <= 0) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

export function formatTimestamp(ms) {
  if (!ms || ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function extractTopics(outlineData, title = "") {
  const topicSet = new Set();

  if (Array.isArray(outlineData)) {
    for (const item of outlineData) {
      const t = (item.topic || "").trim();
      if (t) {
        const cleaned = t
          .replace(/^[\d.)\s-]+/, "")
          .replace(/^Set agenda:\s*/i, "")
          .trim();
        if (
          cleaned &&
          cleaned.length >= 3 &&
          cleaned.length <= 50 &&
          !/^\d+$/.test(cleaned) &&
          !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(cleaned)
        ) {
          topicSet.add(cleaned);
        }
      }
    }
  }

  if (topicSet.size === 0 && title && !title.match(/^\d{4}[-/]\d{2}[-/]\d{2}/) && !title.match(/^\d{1,2}:\d{2}/)) {
    const cleanTitle = title
      .replace(/^\d{2}[-/]\d{2}\s*(?:Meeting:?\s*)?/i, "")
      .replace(/^\d{4}[-/]\d{2}[-/]\d{2}\s*/, "")
      .replace(/^Meeting:?\s*/i, "");

    const parts = cleanTitle.split(/[,—–-]/);
    for (const p of parts) {
      const item = p.trim();
      if (
        item &&
        item.length >= 3 &&
        item.length <= 40 &&
        !/^\d+$/.test(item) &&
        !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(item)
      ) {
        topicSet.add(item);
      }
    }
  }

  return Array.from(topicSet).slice(0, 10);
}

export function determineType(durationMs, noteContent = "", title = "") {
  const lowerTitle = (title || "").toLowerCase();
  if (lowerTitle.includes("call") || lowerTitle.includes("phone")) {
    return "Call";
  }
  if (durationMs < 180000 && (!noteContent || !noteContent.includes("Participants"))) {
    return "Voice Memo";
  }
  return "Meeting";
}

export function generateNoteMarkdown(options) {
  const {
    fileData,
    summaryContent = "",
    transcriptSegments = [],
    outlineData = [],
    audioFileName = null,
    enrichment = null
  } = options;

  const { date, time } = parsePlaudDate(fileData.start_at || fileData.created_at);
  const durationStr = formatDuration(fileData.duration);
  const cleanTitle = formatNoteTitle(fileData.name, date, time);
  const topics = extractTopics(outlineData, fileData.name);
  const noteType = determineType(fileData.duration, summaryContent, fileData.name);

  // Use enriched people & organizations if available
  const people = enrichment?.people && enrichment.people.length > 0 ? enrichment.people : [];
  const orgs = enrichment?.organizations && enrichment.organizations.length > 0 ? enrichment.organizations : [];
  const speakerMap = enrichment?.speakerMap || {};

  // Frontmatter
  const frontmatterLines = [
    "---",
    "categories:",
    '  - "[[Meetings]]"',
    "type:",
    `  - ${noteType}`,
    `date: ${date}`,
    `time: "${time}"`,
    `duration: "${durationStr}"`
  ];

  if (people.length > 0) {
    frontmatterLines.push("people:");
    for (const p of people) {
      frontmatterLines.push(`  - "[[${p}]]"`);
    }
  } else {
    frontmatterLines.push("people: []");
  }

  if (orgs.length > 0) {
    frontmatterLines.push("org:");
    for (const o of orgs) {
      frontmatterLines.push(`  - "[[${o}]]"`);
    }
  }

  if (topics.length > 0) {
    frontmatterLines.push("topics:");
    for (const t of topics) {
      frontmatterLines.push(`  - "[[${t}]]"`);
    }
  } else {
    frontmatterLines.push("topics: []");
  }

  if (enrichment?.confidence !== undefined) {
    frontmatterLines.push(`confidence: ${enrichment.confidence}`);
  }
  if (enrichment?.source) {
    frontmatterLines.push(`speaker_detection: "${enrichment.source}"`);
  }

  frontmatterLines.push(`plaud_id: "${fileData.id}"`);
  if (fileData.serial_number) {
    frontmatterLines.push(`serial_number: "${fileData.serial_number}"`);
  }
  if (audioFileName) {
    frontmatterLines.push(`audio_file: "[[Attachments/${audioFileName}]]"`);
  }
  frontmatterLines.push("---");
  frontmatterLines.push("");

  // Body content
  const bodyLines = [];
  bodyLines.push(`# ${cleanTitle}`);
  bodyLines.push("");

  if (audioFileName) {
    bodyLines.push(`![[Attachments/${audioFileName}]]`);
    bodyLines.push("");
  }

  // Summary section
  if (summaryContent && summaryContent.trim()) {
    let cleanedSummary = summaryContent
      .replace(/!\[PLAUD NOTE\]\(permanent\/[^)]+\)/g, "> *(Visual mindmap generated in Plaud)*")
      .trim();

    // Replace generic speaker references in the note summary with resolved names
    for (const [rawSpk, resolvedName] of Object.entries(speakerMap)) {
      if (resolvedName && rawSpk !== resolvedName && resolvedName !== "Unknown") {
        const spkRegex = new RegExp(`\\b${rawSpk}\\b`, "gi");
        cleanedSummary = cleanedSummary.replace(spkRegex, resolvedName);
      }
    }

    bodyLines.push(cleanedSummary);
    bodyLines.push("");
  } else {
    bodyLines.push("> [!info] Note Summary");
    bodyLines.push("> No AI summary available for this recording.");
    bodyLines.push("");
  }

  // Transcript Callout
  if (Array.isArray(transcriptSegments) && transcriptSegments.length > 0) {
    bodyLines.push(`> [!quote]- Full Transcript (${durationStr})`);
    for (const seg of transcriptSegments) {
      const start = formatTimestamp(seg.start_time);
      const end = formatTimestamp(seg.end_time);
      const rawSpeaker = seg.speaker || "Speaker";
      const resolvedSpeaker = speakerMap[rawSpeaker] || rawSpeaker;
      const content = (seg.content || "").trim();
      bodyLines.push(`> **[${start} - ${end}] ${resolvedSpeaker}**: ${content}`);
      bodyLines.push(">");
    }
    if (bodyLines[bodyLines.length - 1] === ">") {
      bodyLines.pop();
    }
    bodyLines.push("");
  } else {
    bodyLines.push("> [!info]- Full Transcript");
    bodyLines.push("> No verbatim transcript available for this recording.");
    bodyLines.push("");
  }

  return {
    markdown: frontmatterLines.concat(bodyLines).join("\n"),
    metadata: {
      date,
      time,
      durationStr,
      cleanTitle,
      people,
      organizations: orgs,
      topics,
      noteType,
      confidence: enrichment?.confidence,
      source: enrichment?.source
    }
  };
}
