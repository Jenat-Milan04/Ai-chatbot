const functions = require("firebase-functions");
const fs = require("fs");
const path = require("path");

const { parse } = require("csv-parse/sync");
const Fuse = require("fuse.js");

/**
 * ----------------------------
 * 1) Load CSV once (cold start)
 * ----------------------------
 * Put your CSV here:
 * functions/data/dog_first_aid.csv
 */
const DATA_PATH = path.join(__dirname, "data", "C:\Users\LENOVO\OneDrive\one drive image\ 2nd Year\SDGP\AI CHAT BOT\code\Ai-chatbot-firebase\functions\data\dog_first_aid.csv");

function loadAdviceRows() {
  const csvText = fs.readFileSync(DATA_PATH, "utf8");
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
  });

  // Normalize fields
  return rows
    .map((r) => ({
      animalname: String(r.animalname || "").trim().toLowerCase(),
      symptom: String(r.symptom || "").trim().toLowerCase(),
      first_aid_advice: String(r.first_aid_advice || "").trim(),
      emergency: String(r.emergency || "").trim().toLowerCase(), // "yes" or "no"
    }))
    .filter((r) => r.symptom);
}

const ADVICE_ROWS = loadAdviceRows();

// For quick lookup after matching
const SYMPTOM_TO_ROW = new Map();
for (const r of ADVICE_ROWS) {
  if (!SYMPTOM_TO_ROW.has(r.symptom)) SYMPTOM_TO_ROW.set(r.symptom, r);
}

/**
 * ----------------------------------------
 * 2) “Common name” / unnormalized mappings
 * ----------------------------------------
 */
const SYMPTOM_ALIASES = {
  // vomiting
  "vomitting": "vomiting",
  "vomit": "vomiting",
  "throwing up": "vomiting",
  "dog vomiting": "vomiting",
  "dog vomit": "vomiting",

  // diarrhea
  "diarhea": "diarrhea",
  "diarrhoea": "diarrhea",
  "loosemotion": "diarrhea",
  "loose_motions": "diarrhea",
  "loose stool": "diarrhea",
  "watery stool": "diarrhea",
  "runny stool": "diarrhea",

  // appetite
  "poor appetite": "loss of appetite",
  "no appetite": "loss of appetite",
  "not eating": "loss of appetite",
  "dog not eating": "loss of appetite",
  "loss appetite": "loss of appetite",
  "unable to eat": "loss of appetite",

  // fever
  "high temperature": "fever",
  "dog fever": "fever",
  "hot body": "fever",
  "high temp": "fever",

  // lethargy
  "tired": "lethargy",
  "very tired": "lethargy",
  "low energy": "lethargy",
  "weak": "lethargy",
  "reduced energy": "lethargy",

  // breathing 
  "breathing problem": "breathing difficulty",
  "hard to breathe": "breathing difficulty",
  "trouble breathing": "breathing difficulty",
  "labored breathing": "breathing difficulty",

  // nose
  "runny nose": "nasal discharge",
  "nose discharge": "nasal discharge",
  "fluid from nose": "nasal discharge",

  // walking
  "limping": "lameness",
  "cannot walk properly": "lameness",
  "difficulty walking": "lameness",
  "leg injury": "lameness",

  // seizures
  "fits": "seizures",
  "convulsions": "seizures",
  "dog shaking": "seizures",
  "body shaking": "seizures",

  // weight loss
  "losing weight": "weight loss",
  "getting thin": "weight loss",
  "dog losing weight": "weight loss",
};


/**
 * Normalize user symptom (alias -> clean)
 */
function normalizeSymptom(userInput) {
  const text = String(userInput || "").toLowerCase().trim();
  if (SYMPTOM_ALIASES[text]) return SYMPTOM_ALIASES[text];
  return text;
}

/**
 * ----------------------------------------
 * 3) Extract symptoms from full sentences
 * ----------------------------------------
 */
const CLEAN_SYMPTOMS = Array.from(SYMPTOM_TO_ROW.keys()); // Always matches CSV
const CLEAN_SET = new Set(CLEAN_SYMPTOMS);

const MATCH_PHRASES = [
  ...Object.keys(SYMPTOM_ALIASES),
  ...CLEAN_SYMPTOMS
]
  .map((s) => s.toLowerCase().trim())
  .sort((a, b) => b.length - a.length); // longest first

function cleanText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[_\-]/g, " ")         // loose_motions -> loose motions
    .replace(/[^\w\s]/g, " ")       // remove punctuation
    .replace(/\s+/g, " ")           // collapse spaces
    .trim();
}

/**
 * Returns array of clean symptoms detected in message
 */
function extractSymptomsFromMessage(userMessage) {
  const text = ` ${cleanText(userMessage)} `;
  const found = new Set();

  for (const phrase of MATCH_PHRASES) {
    const p = ` ${phrase} `;
    if (text.includes(p)) {
      const maybeClean = SYMPTOM_ALIASES[phrase] ? SYMPTOM_ALIASES[phrase] : phrase;
      const normalized = normalizeSymptom(maybeClean);
      if (CLEAN_SET.has(normalized)) found.add(normalized);
    }
  }

  return Array.from(found);
}

/**
 * ----------------------------
 * 4) Fuzzy matcher (backup)
 * ----------------------------
 */
const ALL_SYMPTOMS = Array.from(SYMPTOM_TO_ROW.keys());

const fuse = new Fuse(ALL_SYMPTOMS, {
  includeScore: true,
  threshold: 0.35,
});

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fallback when sentence-extraction finds nothing.
 */
function findBestSymptoms(userMessage) {
  const msg = normalizeText(userMessage);

  // 1) alias phrase appears in message
  const aliasHits = [];
  for (const [alias, canonical] of Object.entries(SYMPTOM_ALIASES)) {
    const a = normalizeText(alias);
    if (msg === a || msg.includes(a)) aliasHits.push(canonical);
  }

  // 2) fuzzy match whole message
  const fuzzy = fuse.search(msg).slice(0, 5).map((r) => r.item);

  // unique + keep valid
  const combined = [...aliasHits, ...fuzzy].map((s) => normalizeText(s));
  const unique = [];
  for (const s of combined) if (s && !unique.includes(s)) unique.push(s);

  return unique.filter((s) => SYMPTOM_TO_ROW.has(s));
}

/**
 * --------------------------------
 * 5) Build advice reply (MULTI)
 * --------------------------------
 */
function buildAdviceReply(symptoms) {
  let anyEmergency = false;
  const parts = [];

  for (const s of symptoms) {
    const row = SYMPTOM_TO_ROW.get(s);
    if (!row) continue;

    const isEmergency = row.emergency === "yes";
    if (isEmergency) anyEmergency = true;

    parts.push(
      `✅ Matched symptom: ${s}\n` +
      `${isEmergency ? "🚨 Emergency: YES\n" : "🟢 Emergency: NO\n"}` +
      `🩺 First aid:\n${row.first_aid_advice}`
    );
  }

  const header = anyEmergency
    ? "🚨 EMERGENCY WARNING: If symptoms are severe/worsening, contact a vet immediately.\n\n"
    : "";

  return header + parts.join("\n\n--------------------\n\n");
}

/**
 * --------------------------------
 * 6) HTTP Chatbot Endpoint
 * --------------------------------
 * POST JSON: { "message": "my dog is vomitting and not eating" }
 */
exports.chatbot = functions.https.onRequest((req, res) => {
  // CORS
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const message = req.body?.message;
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Missing 'message' string" });
  }

  //1) Try sentence extraction first (multiple symptoms)
  let symptoms = extractSymptomsFromMessage(message);

  //2) If nothing found, fallback to fuzzy (typos)
  if (symptoms.length === 0) {
    symptoms = findBestSymptoms(message).slice(0, 3); // keep top 3
  }

  if (symptoms.length === 0) {
    return res.json({
      found: false,
      reply:
        "I couldn’t match the symptom clearly. 🚑 If your pet looks weak, has trouble breathing, continuous vomiting/diarrhea, bleeding, collapse, or seizures — please contact a vet immediately.\n\nTip: Type the main symptom (example: 'vomiting', 'diarrhea', 'fever').",
    });
  }

  const reply = buildAdviceReply(symptoms);

  return res.json({
    found: true,
    matched_symptoms: symptoms,
    reply,
  });
});