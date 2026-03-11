const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const Fuse = require("fuse.js");

const DATA_PATH = path.join(__dirname, "data", "dog_first_aid.csv");

function loadAdviceRows() {
  const csvText = fs.readFileSync(DATA_PATH, "utf8");
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
  });

  return rows
    .map((r) => ({
      animalname: String(r.animalname || "").trim().toLowerCase(),
      symptom: String(r.symptom || "").trim().toLowerCase(),
      first_aid_advice: String(r.first_aid_advice || "").trim(),
      emergency: String(r.emergency || "").trim().toLowerCase(),
    }))
    .filter((r) => r.symptom);
}

const ADVICE_ROWS = loadAdviceRows();

const SYMPTOM_TO_ROW = new Map();
for (const r of ADVICE_ROWS) {
  if (!SYMPTOM_TO_ROW.has(r.symptom)) SYMPTOM_TO_ROW.set(r.symptom, r);
}

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



function normalizeSymptom(userInput) {
  const text = String(userInput || "").toLowerCase().trim();
  if (SYMPTOM_ALIASES[text]) return SYMPTOM_ALIASES[text];
  return text;
}

const CLEAN_SYMPTOMS = Array.from(SYMPTOM_TO_ROW.keys());
const CLEAN_SET = new Set(CLEAN_SYMPTOMS);

const MATCH_PHRASES = [...Object.keys(SYMPTOM_ALIASES), ...CLEAN_SYMPTOMS]
  .map((s) => s.toLowerCase().trim())
  .sort((a, b) => b.length - a.length);

function cleanText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[_\-]/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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

function findBestSymptoms(userMessage) {
  const msg = normalizeText(userMessage);

  const aliasHits = [];
  for (const [alias, canonical] of Object.entries(SYMPTOM_ALIASES)) {
    const a = normalizeText(alias);
    if (msg === a || msg.includes(a)) aliasHits.push(canonical);
  }

  const fuzzy = fuse.search(msg).slice(0, 5).map((r) => r.item);

  const combined = [...aliasHits, ...fuzzy].map((s) => normalizeText(s));
  const unique = [];
  for (const s of combined) {
    if (s && !unique.includes(s)) unique.push(s);
  }

  return unique.filter((s) => SYMPTOM_TO_ROW.has(s));
}

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

const input = process.argv.slice(2).join(" ");

if (!input) {
  console.log("Please type a symptom message.");
  console.log('Example: node test.js "my dog is vomiting and not eating"');
} else {
  let symptoms = extractSymptomsFromMessage(input);

  if (symptoms.length === 0) {
    symptoms = findBestSymptoms(input).slice(0, 3);
  }

  if (symptoms.length === 0) {
    console.log(
      "I couldn’t match the symptom clearly. If your pet looks weak, has trouble breathing, continuous vomiting/diarrhea, bleeding, collapse, or seizures, contact a vet immediately."
    );
  } else {
    const reply = buildAdviceReply(symptoms);
    console.log("\n" + reply + "\n");
  }
}