import fs from "fs";
import path from "path";
import os from "os";

export function loadEnvFile(filePath = ".env") {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
        const [key, ...vals] = trimmed.split("=");
        const val = vals.join("=").trim().replace(/^["']|["']$/g, "");
        if (!process.env[key.trim()]) {
          process.env[key.trim()] = val;
        }
      }
    }
  } catch {}
}

const COMMON_WORDS_NOT_NAMES = new Set([
  "I", "A", "And", "Or", "But", "If", "So", "Then", "No", "Yes", "Yeah", "Okay",
  "Right", "Well", "Just", "Like", "Sure", "Thanks", "Thank", "Hello", "Hey",
  "Hi", "Sorry", "Please", "Actually", "Basically", "Obviously", "Honestly",
  "Definitely", "Totally", "Look", "Listen", "See", "Wait", "Hold", "Good",
  "Great", "Fine", "Cool", "Nice", "Man", "Dude", "Folks", "Guys", "Team",
  "Everyone", "Everybody", "Anybody", "Someone", "Nobody", "All", "Both",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
  "January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December", "India", "US", "USA", "Bay",
  "Area", "Silicon", "Valley", "Meeting", "Call", "Project", "Team", "Group",
  "Plan", "Roadmap", "Report", "Review", "Discussion", "Proposal", "Notes",
  "Action", "Summary", "Item", "Items", "Sample", "Samples", "Model", "Models",
  "Target", "Targets", "Strategy", "Objective", "Objectives", "Issue", "Issues",
  "Conclusion", "Description", "Next", "Arrangements", "Agreement", "Client",
  "Customer", "Partner", "Partners", "Vendor", "Executive", "Director", "VP", "CEO",
  "CTO", "CIO", "Engineering", "Commercial", "Product", "Support", "Finance"
]);

const ORGS_CACHE_PATH = path.join(os.homedir(), ".plaud", "known_organizations.json");

// Baseline non-sensitive technology platforms commonly referenced in meetings
const BASELINE_ORGS = [
  "Google", "Microsoft", "Apple", "Amazon", "AWS", "Azure",
  "Meta", "OpenAI", "Anthropic", "Slack", "Zoom", "GitHub",
  "NVIDIA", "Intel", "AMD"
];

let cachedOrgs = null;

export function getKnownOrganizations() {
  if (cachedOrgs) return cachedOrgs;

  const orgs = new Set(BASELINE_ORGS);

  // 1. User-specified organizations via environment variable
  const envOrgs = process.env.KNOWN_ORGANIZATIONS || process.env.ORGS;
  if (envOrgs) {
    envOrgs.split(",").map(o => o.trim()).filter(Boolean).forEach(o => orgs.add(o));
  }

  // 2. Dynamically learned organizations saved on previous runs
  try {
    if (fs.existsSync(ORGS_CACHE_PATH)) {
      const saved = JSON.parse(fs.readFileSync(ORGS_CACHE_PATH, "utf-8"));
      if (Array.isArray(saved)) {
        saved.forEach(o => orgs.add(o));
      }
    }
  } catch {}

  cachedOrgs = Array.from(orgs);
  return cachedOrgs;
}

export function saveLearnedOrganizations(newOrgs = []) {
  if (!Array.isArray(newOrgs) || newOrgs.length === 0) return;

  try {
    const current = new Set(getKnownOrganizations());
    let added = false;
    for (const org of newOrgs) {
      const clean = (org || "").trim();
      if (clean && !current.has(clean) && !COMMON_WORDS_NOT_NAMES.has(clean)) {
        current.add(clean);
        added = true;
      }
    }

    if (added) {
      cachedOrgs = Array.from(current);
      const dir = path.dirname(ORGS_CACHE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(ORGS_CACHE_PATH, JSON.stringify(cachedOrgs, null, 2), "utf-8");
    }
  } catch {}
}

export function extractOrganizations(text = "", title = "") {
  const orgs = new Set();
  const combined = `${title}\n${text}`;
  const known = getKnownOrganizations();

  for (const org of known) {
    const regex = new RegExp(`\\b${org.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (regex.test(combined)) {
      orgs.add(org);
    }
  }

  // Suffix patterns for company entities
  const suffixMatches = combined.matchAll(
    /\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)?)\s+(Inc|LLC|Corp|Corporation|Ltd|Limited|Group|Technologies|Technologies|Systems|Networks|Cloud|Capital|Partners|Labs|Ventures|Solutions|Robotics|Holdings)\b/g
  );
  for (const match of suffixMatches) {
    const fullOrg = `${match[1]} ${match[2]}`.trim();
    if (!COMMON_WORDS_NOT_NAMES.has(match[1])) {
      orgs.add(fullOrg);
    }
  }

  const result = Array.from(orgs);
  if (result.length > 0) {
    saveLearnedOrganizations(result);
  }

  return result;
}

export function resolveSpeakersHeuristic(transcriptSegments = [], summaryContent = "", title = "") {
  const organizations = extractOrganizations(summaryContent, title);
  const orgNamesSet = new Set(organizations.map(o => o.toLowerCase()));
  const orgWordsSet = new Set(organizations.flatMap(o => o.toLowerCase().split(/\s+/)));

  if (!Array.isArray(transcriptSegments) || transcriptSegments.length === 0) {
    return {
      speakerMap: {},
      people: [],
      organizations,
      confidence: 0,
      source: "heuristic"
    };
  }

  const utteranceCounts = {};
  for (const t of transcriptSegments) {
    const spk = t.speaker || "Speaker";
    utteranceCounts[spk] = (utteranceCounts[spk] || 0) + 1;
  }
  const totalUtterances = transcriptSegments.length;

  const candidateScores = {};
  for (const spk of Object.keys(utteranceCounts)) {
    candidateScores[spk] = {};
  }

  function addScore(speaker, name, points) {
    if (!speaker || !name) return;
    const clean = name.trim();
    if (COMMON_WORDS_NOT_NAMES.has(clean)) return;
    if (orgNamesSet.has(clean.toLowerCase()) || orgWordsSet.has(clean.toLowerCase())) return;
    if (clean.length < 3 || clean.length > 25) return;
    if (!/^[A-Z][a-z]+$/.test(clean)) return;

    if (!candidateScores[speaker]) candidateScores[speaker] = {};
    candidateScores[speaker][clean] = (candidateScores[speaker][clean] || 0) + points;
  }

  // Turn-taking analysis
  for (let i = 0; i < transcriptSegments.length; i++) {
    const cur = transcriptSegments[i];
    const prev = transcriptSegments[i - 1];
    const next = transcriptSegments[i + 1];
    const curSpk = cur.speaker;
    const prevSpk = prev ? prev.speaker : null;
    const nextSpk = next ? next.speaker : null;
    const text = cur.content || "";

    // Direct address at start of utterance
    const startVocMatch = text.match(/^([A-Z][a-z]+),\s+/);
    if (startVocMatch) {
      const name = startVocMatch[1];
      if (prevSpk && prevSpk !== curSpk) addScore(prevSpk, name, 2.0);
      if (nextSpk && nextSpk !== curSpk) addScore(nextSpk, name, 2.5);
    }

    // Interlocutor address inside utterance
    const midVocMatches = text.matchAll(/[,—]\s*([A-Z][a-z]+)\s*[,.?!]/g);
    for (const m of midVocMatches) {
      const name = m[1];
      if (prevSpk && prevSpk !== curSpk) addScore(prevSpk, name, 2.5);
      if (nextSpk && nextSpk !== curSpk) addScore(nextSpk, name, 2.0);
    }

    // Apologies / greetings
    const greetMatch = text.match(/\b(?:sorry|thanks|thank you|welcome|hey|hi|hello)\s*[,]?\s+([A-Z][a-z]+)\b/i);
    if (greetMatch) {
      const name = greetMatch[1];
      if (prevSpk && prevSpk !== curSpk) addScore(prevSpk, name, 3.0);
      if (nextSpk && nextSpk !== curSpk) addScore(nextSpk, name, 2.0);
    }

    // Self-introduction
    const introMatch = text.match(/\b(?:this is|i am|i'm|my name is)\s+([A-Z][a-z]+)\b/i);
    if (introMatch) {
      const name = introMatch[1];
      addScore(curSpk, name, 5.0);
    }
  }

  // Resolve best candidates
  const speakerMap = {};
  const assignedNames = new Set();
  const speakerConfidence = {};

  const sortedSpeakers = Object.keys(utteranceCounts).sort(
    (a, b) => utteranceCounts[b] - utteranceCounts[a]
  );

  for (const spk of sortedSpeakers) {
    const scores = candidateScores[spk] || {};
    const candidateList = Object.entries(scores)
      .filter(([name]) => !assignedNames.has(name))
      .sort((a, b) => b[1] - a[1]);

    if (candidateList.length > 0) {
      const [topName, topScore] = candidateList[0];
      const secondScore = candidateList[1] ? candidateList[1][1] : 0;

      if (topScore >= 2.0) {
        speakerMap[spk] = topName;
        assignedNames.add(topName);

        const margin = topScore / (secondScore + 1);
        const conf = Math.min(1.0, (topScore / 8.0) * (margin > 1.5 ? 1.0 : 0.8));
        speakerConfidence[spk] = Math.max(0.65, conf);
      } else {
        speakerMap[spk] = spk;
        speakerConfidence[spk] = 0;
      }
    } else {
      speakerMap[spk] = spk;
      speakerConfidence[spk] = 0;
    }
  }

  // Calculate weighted confidence
  let weightedConfSum = 0;
  for (const spk of sortedSpeakers) {
    const count = utteranceCounts[spk];
    const conf = speakerConfidence[spk] || 0;
    weightedConfSum += count * conf;
  }
  const overallConfidence = totalUtterances > 0 ? Number((weightedConfSum / totalUtterances).toFixed(2)) : 0;

  // People list
  const people = Array.from(assignedNames);

  // Extract other names mentioned in context in summary
  const summaryMatches = summaryContent.matchAll(/\b([A-Z][a-z]{2,15})\b/g);
  for (const sm of summaryMatches) {
    const n = sm[1];
    if (
      !COMMON_WORDS_NOT_NAMES.has(n) &&
      !orgNamesSet.has(n.toLowerCase()) &&
      !orgWordsSet.has(n.toLowerCase()) &&
      !people.includes(n)
    ) {
      if (new RegExp(`(?:with|lead|brief|call|pull in|discuss with|alongside|coordinate with)\\s+${n}\\b`, "i").test(summaryContent)) {
        people.push(n);
      }
    }
  }

  return {
    speakerMap,
    people: Array.from(new Set(people)).sort(),
    organizations,
    confidence: overallConfidence,
    source: "heuristic"
  };
}

export async function resolveSpeakersGemini(transcriptSegments = [], summaryContent = "", title = "", apiKey = process.env.GEMINI_API_KEY) {
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");

  // Build a representative dialogue sample covering all speakers
  const speakers = [...new Set(transcriptSegments.map(t => t.speaker).filter(Boolean))];
  const sampleTurns = [];
  sampleTurns.push(...transcriptSegments.slice(0, 45));
  for (const spk of speakers) {
    if (!sampleTurns.some(t => t.speaker === spk)) {
      const spkTurns = transcriptSegments
        .filter(t => t.speaker === spk && t.content)
        .sort((a, b) => (b.content?.length || 0) - (a.content?.length || 0))
        .slice(0, 4);
      sampleTurns.push(...spkTurns);
    }
  }

  const sampleDialogue = sampleTurns.map(
    (s, idx) => `[${idx}] ${s.speaker}: "${s.content}"`
  ).join("\n");

  const speakerListStr = speakers.length > 0 ? speakers.join(", ") : "Speaker 1, Speaker 2";
  const prompt = `You are an expert executive meeting intelligence assistant.
Your task is to identify the real names of EVERY speaker (${speakerListStr}) in this transcript and summary.

Meeting Title: ${title}

Meeting Summary & Action Items:
${summaryContent.slice(0, 4000)}

Dialogue Excerpt:
${sampleDialogue.slice(0, 6000)}

DISAMBIGUATION & IDENTIFICATION RULES:
1. Pay careful attention to conversational grammar:
   - When Speaker A says "Good morning Bob", the person being addressed (Speaker B) is Bob, NOT Speaker A.
   - When Speaker A says "So that's why we have that questionnaire, Alice", the person being addressed is Alice, NOT Speaker A.
   - When Speaker A says "David Smith here", Speaker A is David Smith.
   - When someone says "Alex and Charlie have joined", and one says "Alex here", the other who joined is Charlie.
2. Cross-reference with Action Items and Summary:
   - Plaud notes often associate tasks with "Speaker 1", "Speaker 3", etc. or "@Person". Match these to resolve who is who.
3. Use process of elimination to map EVERY speaker (${speakerListStr}):
   - Identify all meeting attendees from the introductions, roll-calls, and summary.
   - Match each speaker (${speakerListStr}) to one of these attendees using their role, topics they discuss, and who they interact with. Do not leave active key speakers unmapped if their identity is deducible.

Respond with ONLY a valid JSON object in this exact schema:
{
  "speakerMap": { "Speaker 1": "Real Name", "Speaker 2": "Real Name", "Speaker 3": "Real Name" },
  "people": ["Name 1", "Name 2"],
  "organizations": ["Org 1", "Org 2"],
  "confidence": 0.95
}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.1
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const textContent = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textContent) throw new Error("Empty response from Gemini API");

  const parsed = JSON.parse(textContent);
  const orgs = Array.isArray(parsed.organizations) ? parsed.organizations : [];
  if (orgs.length > 0) {
    saveLearnedOrganizations(orgs);
  }

  return {
    speakerMap: parsed.speakerMap || {},
    people: Array.isArray(parsed.people) ? parsed.people : [],
    organizations: orgs,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.9,
    source: "cloud_gemini"
  };
}

export async function resolveSpeakersOpenAI(transcriptSegments = [], summaryContent = "", title = "", apiKey = process.env.OPENAI_API_KEY) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");

  const sampleDialogue = transcriptSegments.slice(0, 30).map(
    (s, idx) => `[${idx}] ${s.speaker}: "${s.content}"`
  ).join("\n");

  const prompt = `Analyze this meeting to identify:
1. Mapping of generic speaker labels ("Speaker 1", "Speaker 2", etc.) to actual person names.
2. List of key attendees / people.
3. List of companies and organizations discussed.

Meeting Title: ${title}
Summary Excerpt:
${summaryContent.slice(0, 2000)}

Dialogue:
${sampleDialogue}`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You return strict JSON with keys: speakerMap (object), people (array), organizations (array), confidence (number 0.0-1.0)." },
        { role: "user", content: prompt }
      ],
      temperature: 0.1
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  const orgs = Array.isArray(parsed.organizations) ? parsed.organizations : [];
  if (orgs.length > 0) {
    saveLearnedOrganizations(orgs);
  }

  return {
    speakerMap: parsed.speakerMap || {},
    people: Array.isArray(parsed.people) ? parsed.people : [],
    organizations: orgs,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.9,
    source: "cloud_openai"
  };
}

export async function enrichMeetingData({
  transcriptSegments = [],
  summaryContent = "",
  title = "",
  minConfidence = 0.70,
  forceCloud = false
}) {
  loadEnvFile();

  const heuristicResult = resolveSpeakersHeuristic(transcriptSegments, summaryContent, title);

  if (!forceCloud && heuristicResult.confidence >= minConfidence) {
    return heuristicResult;
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  const openAiKey = process.env.OPENAI_API_KEY;

  if (geminiKey) {
    try {
      console.log(`  [enricher] Heuristic confidence ${heuristicResult.confidence} < ${minConfidence}. Calling Gemini 3.6 Flash...`);
      const cloudResult = await resolveSpeakersGemini(transcriptSegments, summaryContent, title, geminiKey);
      return cloudResult;
    } catch (err) {
      console.warn(`  [enricher] Gemini fallback failed: ${err.message}. Using heuristic results.`);
    }
  } else if (openAiKey) {
    try {
      console.log(`  [enricher] Heuristic confidence ${heuristicResult.confidence} < ${minConfidence}. Calling OpenAI...`);
      const cloudResult = await resolveSpeakersOpenAI(transcriptSegments, summaryContent, title, openAiKey);
      return cloudResult;
    } catch (err) {
      console.warn(`  [enricher] OpenAI fallback failed: ${err.message}. Using heuristic results.`);
    }
  } else {
    if (heuristicResult.confidence < minConfidence) {
      console.log(`  [enricher] Heuristic confidence is ${heuristicResult.confidence} (below threshold ${minConfidence}). No Cloud LLM key set; using best-effort heuristics.`);
    }
  }

  return heuristicResult;
}
