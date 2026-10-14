/**
 * AI Quiz Generator — app.js
 *
 * Flow:
 *   1. User enters Gemini API Key (stored in localStorage)
 *   2. User pastes raw question text + selects/types quiz title
 *   3. "AI ilə Quiz Yarat" clicked → parser extracts questions client-side
 *   4. Single Gemini API call → AI returns JSON with correct answers + explanations
 *   5. Quiz renders interactively with full review + results
 */

// ─── GLOBALS ──────────────────────────────────────────────────────────────────
const GEMINI_MODELS = [
  "gemini-3-flash-preview",
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-flash-latest"
];
let preferredGeminiModel = "gemini-3-flash-preview";
const LS_KEY_API = "quiz_gemini_api_key";
const LS_KEY_TEXT = "quiz_last_text";

let questions = [];   // Array<{ id, question, options: string[], correct: number, explanation: string }>
let userAnswers = {};  // { [id]: optionIndex }
let currentIdx = 0;

// ─── SCREENS ──────────────────────────────────────────────────────────────────
const S = {
  setup: document.getElementById("screen-setup"),
  loading: document.getElementById("screen-loading"),
  quiz: document.getElementById("screen-quiz"),
  results: document.getElementById("screen-results"),
  review: document.getElementById("screen-review"),
};
function showScreen(name) {
  Object.values(S).forEach(el => el.classList.remove("active"));
  S[name].classList.add("active");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ─── TOAST ────────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg, type = "info", duration = 3500) {
  let el = document.getElementById("__toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "__toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = (type === "success" ? "✅ " : type === "error" ? "❌ " : "ℹ️ ") + msg;
  el.className = `toast ${type}`;
  requestAnimationFrame(() => { requestAnimationFrame(() => { el.classList.add("show"); }); });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), duration);
}

// ─── SOUND FX ─────────────────────────────────────────────────────────────────
class SoundFx {
  constructor() { this.ctx = null; }
  init() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx?.state === "suspended") this.ctx.resume();
  }
  tone(freq, type, dur, vol = 0.1) {
    try {
      this.init();
      if (!this.ctx) return;
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, this.ctx.currentTime);
      g.gain.setValueAtTime(vol, this.ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + dur);
      o.connect(g); g.connect(this.ctx.destination);
      o.start(); o.stop(this.ctx.currentTime + dur);
    } catch (_) { }
  }
  correct() { this.tone(523, "sine", 0.12, 0.15); setTimeout(() => this.tone(659, "sine", 0.18, 0.15), 80); }
  wrong() { this.tone(220, "triangle", 0.15, 0.2); setTimeout(() => this.tone(185, "triangle", 0.25, 0.2), 100); }
  click() { this.tone(800, "sine", 0.04, 0.05); }
  finish() { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.tone(f, "sine", 0.2, 0.12), i * 90)); }
}
const sfx = new SoundFx();

// ─── HARDCODED API KEY ────────────────────────────────────────────────────────
// ⚠️ API key-inizi buraya yapışdırın:
const HARDCODED_API_KEY = "AQ.Ab8RN6IR1HYB57W-k3e1f2nREOIUfS_ZA6iGpB85iRYtSvmfkg";

// ─── QUIZ TIMER ───────────────────────────────────────────────────────────────
let quizTimerStart = null;
let quizTimerInterval = null;

function formatTimer(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function startQuizTimer() {
  stopQuizTimer();
  quizTimerStart = Date.now();
  const timerEl = document.getElementById("quiz-timer-display");
  if (timerEl) timerEl.textContent = "00:00";
  quizTimerInterval = setInterval(() => {
    const elapsed = Date.now() - quizTimerStart;
    if (timerEl) timerEl.textContent = formatTimer(elapsed);
  }, 1000);
}

function stopQuizTimer() {
  if (quizTimerInterval) {
    clearInterval(quizTimerInterval);
    quizTimerInterval = null;
  }
}

function getElapsedTime() {
  if (!quizTimerStart) return "00:00";
  return formatTimer(Date.now() - quizTimerStart);
}

// ─── QUESTION TEXT PARSER (Client-side, no AI) ───────────────────────────────
/**
 * Markdown-aware parser. Handles:
 *   Plain:    "1. Question?\nA) Opt\nB) Opt"
 *   Markdown: "**1.** Question?\nA) `code`\nB) Option"
 * Returns array of { id, question, options: string[] }
 */
function stripMarkdown(text) {
  return text
    .replace(/\*\*/g, "")          // remove bold markers **
    .replace(/\*/g, "")            // remove italic markers *
    .replace(/`([^`]*)`/g, "$1")  // replace `code` with code
    .replace(/_{2,}/g, "")        // remove __
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // [text](url) → text
    .trim();
}

function parseQuestionsFromText(raw) {
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const parsed = [];
  let current = null;

  // Question: 1. text | 1) text | 1 - text | Sual 1: text | Sual 1. text
  const qPattern = /^(?:(?:Sual|Q|Question)\s+)?(\d+)[.)\-:]\s+(.+)/i;
  // Option: A) text | A. text | A - text
  const optPattern = /^([A-Ea-e])[.)\-]\s*(.+)/;
  // Skip pattern (applied on cleaned text)
  const skipPattern = /^(---|===|#|Bölmə|Section|Qeyd|Note|Hazır)/i;

  for (let rawLine of lines) {
    const clean = stripMarkdown(rawLine);
    if (!clean) continue;

    // Skip horizontal rules, headings, section titles, notes
    if (skipPattern.test(clean)) continue;

    // Try question match
    const qMatch = clean.match(qPattern);
    if (qMatch) {
      if (current && current.options.length >= 2) parsed.push(current);
      const parsedNum = parseInt(qMatch[1], 10);
      current = {
        id: parsed.length + 1,
        originalNum: !isNaN(parsedNum) ? parsedNum : (parsed.length + 1),
        question: qMatch[2].trim(),
        options: []
      };
      continue;
    }

    // Try option match
    const oMatch = clean.match(optPattern);
    if (oMatch && current) {
      const optText = oMatch[2].trim();
      if (optText.length > 0 && !optText.startsWith("---")) {
        current.options.push(optText);
      }
      continue;
    }

    // Multi-line question continuation (before any options)
    if (current && current.options.length === 0 && clean.length > 1) {
      current.question += " " + clean;
    }
  }

  if (current && current.options.length >= 2) parsed.push(current);

  // Guarantee strictly unique 1-indexed sequential IDs for all parsed items
  parsed.forEach((q, idx) => {
    q.id = idx + 1;
  });

  return parsed;
}


// ─── TEXTAREA LIVE DETECTION ───────────────────────────────────────────────────
const questionsInput = document.getElementById("questions-input");
const charCount = document.getElementById("char-count");

questionsInput.addEventListener("input", () => {
  const text = questionsInput.value;
  const parsed = parseQuestionsFromText(text);
  charCount.textContent = `${text.length} simvol · ${parsed.length} sual aşkarlandı`;
  charCount.className = parsed.length > 0 ? "char-count detected" : "char-count";
});

// Restore last text from localStorage
const lastText = localStorage.getItem(LS_KEY_TEXT);
if (lastText) { questionsInput.value = lastText; questionsInput.dispatchEvent(new Event("input")); }

// ─── EXAMPLE BUTTON ───────────────────────────────────────────────────────────
const EXAMPLE_TEXT = `1. Bash skriptində $? dəyişəni nəyi göstərir?
A) Skriptin PID-ni
B) Əvvəlki əmrin exit kodunu
C) Cari istifadəçinin adını
D) Skriptin işləmə vaxtını

2. Python-da "abc"[::-1] nə qaytarır?
A) "abc"
B) Xəta verir
C) "cba"
D) ""

3. CIA triadında "Integrity" termini nəyi ifadə edir?
A) Məlumatın yalnız səlahiyyətli şəxslərə görünməsi
B) Sistemin həmişə əlçatan olması
C) Məlumatın icazəsiz dəyişdirilmədən qorunması
D) İstifadəçi parollarının uzunluğu

4. Windows-da Event ID 4624 nəyi göstərir?
A) Uğursuz login cəhdi
B) Uğurlu login (Successful Logon)
C) Proses yaradılması
D) Fayl silinməsi

5. Linux-da chmod 750 file.sh icazələri necə təyin edir?
A) Owner: rwx, Group: r-x, Others: ---
B) Owner: r--, Group: rwx, Others: r--
C) Owner: rwx, Group: rwx, Others: rwx
D) Owner: ---, Group: r-x, Others: rwx`;

document.getElementById("btn-load-example").addEventListener("click", () => {
  questionsInput.value = EXAMPLE_TEXT;
  questionsInput.dispatchEvent(new Event("input"));
  sfx.click();
});

document.getElementById("btn-clear-paste").addEventListener("click", () => {
  questionsInput.value = "";
  questionsInput.dispatchEvent(new Event("input"));
  sfx.click();
});

// ─── GEMINI API CALL ──────────────────────────────────────────────────────────
async function requestGemini(model, apiKey, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  // Attempt 1: with application/json mime type
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 8192,
          responseMimeType: "application/json"
        }
      })
    });

    if (resp.ok) {
      const data = await resp.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        let jsonStr = text.trim();
        const jsonMatch = jsonStr.match(/\[[\s\S]*\]/) || jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonStr = jsonMatch[0];
        } else {
          jsonStr = jsonStr.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/, "").trim();
        }
        let parsed = JSON.parse(jsonStr);
        if (!Array.isArray(parsed) && typeof parsed === "object" && parsed !== null) {
          const arr = Object.values(parsed).find(v => Array.isArray(v));
          if (arr) parsed = arr;
        }
        return parsed;
      }
    } else {
      const err = await resp.json().catch(() => ({}));
      const msg = err?.error?.message || `HTTP ${resp.status}`;
      // If error is not a 400 that might be caused by responseMimeType, throw immediately
      if (resp.status !== 400) {
        throw new Error(msg);
      }
    }
  } catch (err) {
    if (!err.message?.includes("HTTP 400") && !err.message?.includes("JSON")) {
      throw err;
    }
  }

  // Attempt 2: plain prompt without responseMimeType
  const respFallback = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8192
      }
    })
  });

  if (!respFallback.ok) {
    const err = await respFallback.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${respFallback.status}`);
  }

  const data = await respFallback.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Boş cavab alındı");

  let jsonStrFallback = text.trim();
  const jsonMatchFallback = jsonStrFallback.match(/\[[\s\S]*\]/) || jsonStrFallback.match(/\{[\s\S]*\}/);
  if (!jsonMatchFallback) throw new Error("AI JSON formatında cavab qaytarmadı");

  let parsedFallback = JSON.parse(jsonMatchFallback[0]);
  if (!Array.isArray(parsedFallback) && typeof parsedFallback === "object" && parsedFallback !== null) {
    const arr = Object.values(parsedFallback).find(v => Array.isArray(v));
    if (arr) parsedFallback = arr;
  }
  return parsedFallback;
}

async function callGeminiWithFallback(apiKey, prompt) {
  const candidateModels = [
    preferredGeminiModel,
    ...GEMINI_MODELS.filter(m => m !== preferredGeminiModel)
  ];

  let lastError = null;
  for (const model of candidateModels) {
    try {
      const result = await requestGemini(model, apiKey, prompt);
      preferredGeminiModel = model; // save the model that worked
      return result;
    } catch (err) {
      console.warn(`Model ${model} uğursuz oldu:`, err.message);
      lastError = err;
      if (err.message?.includes("API_KEY_INVALID") || err.message?.includes("API key not valid")) {
        throw new Error("Daxil edilmiş API Key yanlışdır. Zəhmət olmasa yoxlayın.");
      }
    }
  }

  throw new Error(lastError?.message || "AI modelləri ilə əlaqə qurmaq mümkün olmadı.");
}

// ─── BUILD CHUNK PROMPT ───────────────────────────────────────────────────────
function buildChunkPrompt(chunkQuestions) {
  const questionsJson = chunkQuestions.map((q, i) => ({
    index: i,
    id: q.id,
    question: q.question,
    options: q.options
  }));

  return `Sən kibertəhlükəsizlik, proqramlaşdırma, sistemlər və şəbəkə üzrə mütəxəssis imtahan rəhbərisən.

Aşağıdakı ${questionsJson.length} sual üçün JSON formatında dəqiq düzgün cavabları, balanslaşdırılmış variantları və qısa izahları ver.

Hər sual üçün:
1. "index": sualın buradakı index-i (0-dan ${questionsJson.length - 1}-ə qədər)
2. "id": sualın ID nömrəsi
3. "correct": düzgün variantın 0-based indeksi (0=A, 1=B, 2=C, 3=D, 4=E)
4. "options": təmizlənmiş və uzunluğu balanslaşdırılmış variantlar massivi (mütləq orijinal sayda variant olmalıdır)
5. "explanation": 1-2 cümlə AZƏRBAYCAN dilində aydın izah

ÇOX VACİB TƏLƏB — VARİANTLARIN UZUNLUĞUNUN BALANSLANDIRILMASI (Uzunluq biasının aradan qaldırılması):
Bəzən doğru cavab variantı digər variantlardan çox uzun, izahlı və detallı yazılır, bu isə cavabı oxumadan sırf uzunluğuna görə təxmin etməyə imkan verir.
Bu problemi MÜTLƏQ aradan qaldır:
- Hər sual üçün "options" massivi qaytar.
- Əgər bir variant (xüsusilə doğru cavab) digər variantlardan nəzərəçarpacaq dərəcədə uzundursa, onu qısalt, lakonik et və digər variantların uzunluğuna uyğunlaşdır (balanslaşdır).
- Texniki mənası və dəqiqliyi qorunsun, lakin artıq izahat sözlərini ixtisar et ki, variantların heç biri uzunluğu ilə "doğru cavab mənəm" deyə fərqlənməsin.
- Əgər digər yanlış variantlar həddən artıq qısadırsa, onları da bir az bərabərləşdirə bilərsən. Bütün variantlar təxminən oxşar həcmdə və tərzdə olmalıdır.
- "options" massivindəki variantların sayı mütləq orijinal sualdakı variantların sayı ilə eyni olmalıdır.
- "correct" indeksi həmin "options" massivindəki düzgün cavabın 0-based indeksini göstərməlidir.

QAYDALAR:
- Yalnız və yalnız JSON array qaytar. Əlavə mətn və ya markdown yazma.
- "explanation" sahəsi mütləq Azərbaycan dilində olmalıdır.

Suallar:
${JSON.stringify(questionsJson, null, 2)}

Cavab strukturu:
[
  {
    "index": 0,
    "id": 1,
    "correct": 1,
    "options": [
      "Variant 1",
      "Variant 2",
      "Variant 3",
      "Variant 4"
    ],
    "explanation": "Azərbaycan dilində izah..."
  }
]`;
}

// ─── LOADING PROGRESS & ANIMATION ─────────────────────────────────────────────
let loadingInterval = null;
const LOADING_STATUS_TIPS = [
  "⚡ Suallar və cavab variantları oxunur...",
  "🔍 Kibertəhlükəsizlik qaydaları üzrə təhlil aparılır...",
  "💡 Düzgün cavablar və ətraflı izahlar hazırlanır...",
  "🛡️ Variantların düzgünlüyü yoxlanılır...",
  "✨ Quiz arxitekturası və nəticələr qurulur..."
];

function startLoadingLiveAnimation() {
  stopLoadingLiveAnimation();
  let idx = 0;
  const subEl = document.getElementById("loading-submsg");
  if (subEl) subEl.textContent = LOADING_STATUS_TIPS[0];

  loadingInterval = setInterval(() => {
    idx = (idx + 1) % LOADING_STATUS_TIPS.length;
    if (subEl) {
      subEl.style.opacity = "0.3";
      setTimeout(() => {
        subEl.textContent = LOADING_STATUS_TIPS[idx];
        subEl.style.opacity = "1";
      }, 150);
    }
  }, 1700);
}

function stopLoadingLiveAnimation() {
  if (loadingInterval) {
    clearInterval(loadingInterval);
    loadingInterval = null;
  }
}

function animateLoadingBar(targetPct, duration = 400) {
  const bar = document.getElementById("loading-bar");
  if (bar) {
    bar.style.transition = `width ${duration}ms ease`;
    bar.style.width = `${targetPct}%`;
  }
}
function setLoadingMsg(msg) {
  const el = document.getElementById("loading-msg");
  if (el) el.textContent = msg;
}
function setLoadingCount(cur, total) {
  const el = document.getElementById("loading-count");
  if (el) el.textContent = `${cur} / ${total} sual işləndi`;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── GENERATE QUIZ ─────────────────────────────────────────────────────────────
document.getElementById("btn-generate").addEventListener("click", async () => {
  const apiKey = HARDCODED_API_KEY;
  const rawText = questionsInput.value.trim();
  const quizTitle = document.getElementById("quiz-title-input").value.trim() || "Kibertəhlükəsizlik Quiz";

  // Validate API key
  if (!apiKey || apiKey === "BURAYA_API_KEY_YAZIN" || apiKey.length < 15) {
    toast("API key koda daxil edilməyib! app.js faylında HARDCODED_API_KEY dəyişənini yeniləyin.", "error", 6000);
    return;
  }

  // Validate questions
  if (rawText.length < 20) {
    toast("Sualları daxil edin!", "error");
    questionsInput.focus();
    return;
  }

  const parsed = parseQuestionsFromText(rawText);
  if (parsed.length === 0) {
    toast("Heç bir sual aşkarlanmadı. Format yoxlayın (1. Sual? A) ... B) ...)", "error", 5000);
    return;
  }

  // Save text to LS
  localStorage.setItem(LS_KEY_TEXT, rawText);

  // Disable button and show loading
  const btnGenerate = document.getElementById("btn-generate");
  const btnText = document.getElementById("btn-generate-text");
  const btnSpinner = document.getElementById("btn-spinner");
  btnGenerate.disabled = true;
  btnText.classList.add("hidden");
  btnSpinner.classList.remove("hidden");

  showScreen("loading");
  startLoadingLiveAnimation();
  setLoadingMsg(`${parsed.length} sual aşkarlandı, AI analiz edir...`);
  setLoadingCount(0, parsed.length);
  animateLoadingBar(10, 300);

  try {
    const BATCH_SIZE = 25;
    const totalBatches = Math.ceil(parsed.length / BATCH_SIZE);
    const allAiResults = [];

    for (let b = 0; b < totalBatches; b++) {
      const start = b * BATCH_SIZE;
      const end = Math.min(start + BATCH_SIZE, parsed.length);
      const chunk = parsed.slice(start, end);

      const progressStart = Math.round((start / parsed.length) * 80) + 10;
      animateLoadingBar(progressStart, 500);

      if (totalBatches > 1) {
        setLoadingMsg(`AI analiz edir: sual ${start + 1}–${end} / ${parsed.length}...`);
      } else {
        setLoadingMsg("AI sualları analiz edir, düzgün cavablar tapılır...");
      }
      setLoadingCount(start, parsed.length);

      const chunkPrompt = buildChunkPrompt(chunk);
      const chunkResults = await callGeminiWithFallback(apiKey, chunkPrompt);

      if (!Array.isArray(chunkResults)) {
        throw new Error("AI düzgün formatda cavab qaytarmadı.");
      }

      chunk.forEach((q, cIdx) => {
        if (!q) return;
        const item = (Array.isArray(chunkResults)
          ? chunkResults.find(r => r && (r.index === cIdx || r.id === q.id || r.id === q.originalNum))
          : null) || (Array.isArray(chunkResults) ? chunkResults[cIdx] : null) || {};
        allAiResults.push({
          id: q.id,
          correct: typeof item.correct === "number" ? item.correct : 0,
          options: Array.isArray(item.options) ? item.options : null,
          explanation: item.explanation || "Bu sual üçün izah təqdim edilmədi."
        });
      });

      setLoadingCount(end, parsed.length);
      const progressEnd = Math.round((end / parsed.length) * 80) + 10;
      animateLoadingBar(progressEnd, 400);
      await sleep(100);
    }

    animateLoadingBar(95, 300);
    setLoadingMsg("Quiz hazırlanır...");
    setLoadingCount(parsed.length, parsed.length);

    // Merge AI results with parsed questions
    const merged = mergeResults(parsed, allAiResults);

    // Shuffle both question order and options order
    questions = shuffleQuizQuestions(merged);

    // Reset state
    userAnswers = {};
    currentIdx = 0;

    await sleep(300);
    animateLoadingBar(100, 200);
    await sleep(200);

    // Store quiz title
    document.getElementById("quiz-title-display").textContent = quizTitle;

    setupQuizScreen();
    showScreen("quiz");
    renderDotNav();
    renderQuestion();

    // Start the quiz timer
    startQuizTimer();

    toast(`${questions.length} sual uğurla qarışdırılaraq yükləndi!`, "success");

  } catch (err) {
    console.error("AI error:", err);
    showScreen("setup");
    toast("Xəta baş verdi: " + err.message, "error", 6000);
    stopQuizTimer();
  } finally {
    stopLoadingLiveAnimation();
    btnGenerate.disabled = false;
    btnText.classList.remove("hidden");
    btnSpinner.classList.add("hidden");
  }
});

// ─── SHUFFLE UTILITIES ────────────────────────────────────────────────────────
/**
 * Fisher-Yates array shuffle (returns a new array)
 */
function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Shuffles both the order of questions AND the options inside each question,
 * while accurately preserving the correct answer index.
 */
function shuffleQuizQuestions(questionList) {
  if (!Array.isArray(questionList)) return [];
  // 1. Shuffle options inside each question while updating the correct answer index
  const randomizedQuestions = questionList.filter(Boolean).map((q, qIndex) => {
    const opts = Array.isArray(q.options) ? q.options : [];
    // Map each option with a flag tracking if it's the correct answer
    const mapped = opts.map((text, idx) => ({
      text,
      isCorrect: idx === q.correct
    }));

    // Shuffle the options
    const shuffledOptions = shuffleArray(mapped);

    // Find the new index of the correct answer
    const newCorrectIdx = shuffledOptions.findIndex(o => o.isCorrect);

    return {
      ...q,
      id: q.id !== undefined ? q.id : (qIndex + 1),
      options: shuffledOptions.map(o => o.text),
      correct: newCorrectIdx !== -1 ? newCorrectIdx : 0
    };
  });

  // 2. Shuffle the order of the questions themselves
  return shuffleArray(randomizedQuestions);
}

// ─── MERGE PARSED + AI RESULTS ────────────────────────────────────────────────
function mergeResults(parsed, aiResults) {
  const aiMap = {};
  if (Array.isArray(aiResults)) {
    aiResults.forEach(item => {
      if (item && item.id !== undefined) {
        aiMap[item.id] = item;
      }
    });
  }

  return (Array.isArray(parsed) ? parsed : []).filter(Boolean).map((q, i) => {
    const ai = (q && q.id !== undefined ? aiMap[q.id] : null) || (Array.isArray(aiResults) ? aiResults[i] : null) || {};
    let correct = typeof ai.correct === "number" ? ai.correct : 0;

    // Use AI balanced/shortened options if valid and matching count
    let options = Array.isArray(q.options) ? q.options : [];
    if (
      Array.isArray(ai.options) &&
      ai.options.length === options.length &&
      ai.options.every(o => typeof o === "string" && o.trim().length > 0)
    ) {
      options = ai.options.map(o => o.trim());
    } else {
      // Client-side fallback cleanup for excessively long options
      options = options.map(opt => {
        if (typeof opt === "string" && opt.length > 90) {
          return opt.replace(/\s*\([^)]{15,}\)\s*$/, "").replace(/\s*—\s*[^—]{15,}$/, "").trim();
        }
        return String(opt || "");
      });
    }

    // Clamp to valid range
    correct = Math.max(0, Math.min(correct, Math.max(0, options.length - 1)));

    return {
      id: q && q.id !== undefined ? q.id : (i + 1),
      originalNum: q && q.originalNum !== undefined ? q.originalNum : (i + 1),
      question: q && q.question ? q.question : "Sual",
      options: options,
      correct: correct,
      explanation: ai.explanation || "Bu sualın izahı mövcud deyil."
    };
  });
}

// ─── SAFE QUESTION NAVIGATION (DEBOUNCED TO PREVENT SKIPPING) ────────────────
let lastNavTimestamp = 0;

function goToNextQuestion() {
  const now = Date.now();
  if (now - lastNavTimestamp < 220) return; // Prevent double trigger (skipping questions)
  lastNavTimestamp = now;

  // Unfocus active button so Enter doesn't trigger native button clicks
  if (document.activeElement && typeof document.activeElement.blur === "function") {
    document.activeElement.blur();
  }

  sfx.click();
  if (currentIdx < questions.length - 1) {
    currentIdx++;
    renderQuestion();
  } else {
    finishQuiz();
  }
}

function goToPrevQuestion() {
  const now = Date.now();
  if (now - lastNavTimestamp < 220) return;
  lastNavTimestamp = now;

  if (document.activeElement && typeof document.activeElement.blur === "function") {
    document.activeElement.blur();
  }

  sfx.click();
  if (currentIdx > 0) {
    currentIdx--;
    renderQuestion();
  }
}

// ─── QUIZ SCREEN SETUP ────────────────────────────────────────────────────────
function setupQuizScreen() {
  const btnBack = document.getElementById("btn-back");
  const btnPrev = document.getElementById("btn-prev");
  const btnNext = document.getElementById("btn-next");

  btnBack.onclick = (e) => {
    if (e?.target?.blur) e.target.blur();
    sfx.click();
    if (confirm("Quizden çıxmaq istəyirsiniz?")) {
      stopQuizTimer();
      const nav = document.getElementById("dot-nav");
      if (nav) nav.innerHTML = "";
      showScreen("setup");
    }
  };
  btnPrev.onclick = (e) => {
    if (e?.target?.blur) e.target.blur();
    goToPrevQuestion();
  };
  btnNext.onclick = (e) => {
    if (e?.target?.blur) e.target.blur();
    goToNextQuestion();
  };
}

// ─── RENDER QUESTION ──────────────────────────────────────────────────────────
function renderQuestion() {
  const q = questions[currentIdx];
  if (!q) return;

  const LETTERS = ["A", "B", "C", "D", "E"];

  document.getElementById("section-tag").textContent = `Sual ${currentIdx + 1}`;
  document.getElementById("question-counter").textContent = `${currentIdx + 1} / ${questions.length}`;
  document.getElementById("q-number").textContent = String(currentIdx + 1).padStart(2, "0");
  document.getElementById("q-text").textContent = q.question || "Sual";

  // Progress
  document.getElementById("progress-fill").style.width =
    `${((currentIdx + 1) / Math.max(1, questions.length)) * 100}%`;

  // Live score
  updateLiveScore();

  // Options
  const grid = document.getElementById("options-grid");
  grid.innerHTML = "";
  const answered = Boolean(userAnswers && q.id !== undefined && userAnswers.hasOwnProperty(q.id));
  const chosen = answered ? userAnswers[q.id] : null;

  (q.options || []).forEach((text, idx) => {
    const btn = document.createElement("button");
    btn.className = "option-btn";

    let stateClass = "";
    if (answered) {
      btn.disabled = true;
      if (idx === q.correct) stateClass = "correct";
      else if (chosen === idx && idx !== q.correct) stateClass = "wrong";
    }
    if (stateClass) btn.classList.add(stateClass);

    btn.innerHTML = `
      <span class="option-label">${LETTERS[idx] || (idx + 1)}</span>
      <span class="option-text">${text}</span>
    `;

    if (!answered) {
      btn.addEventListener("click", () => selectAnswer(idx));
    }

    grid.appendChild(btn);
  });

  // Feedback
  const fbEl = document.getElementById("q-feedback");
  if (answered) {
    fbEl.classList.remove("hidden");
    fbEl.className = `question-feedback ${chosen === q.correct ? "correct" : "wrong"}`;
    document.getElementById("feedback-icon").textContent = chosen === q.correct ? "✅" : "❌";
    document.getElementById("feedback-msg").innerHTML =
      `<strong>${chosen === q.correct ? "Əla! Doğru cavabdır." : "Yanlış cavab!"}</strong> ${q.explanation || ""}`;
  } else {
    fbEl.classList.add("hidden");
    fbEl.className = "question-feedback hidden";
  }

  // Next button label
  const btnNext = document.getElementById("btn-next");
  if (currentIdx === questions.length - 1) {
    btnNext.innerHTML = `Nəticəni gör <svg viewBox="0 0 24 24" fill="none" width="18" height="18"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  } else {
    btnNext.innerHTML = `Növbəti <svg viewBox="0 0 24 24" fill="none" width="18" height="18"><path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  document.getElementById("btn-prev").disabled = currentIdx === 0;
  updateDotNav();
}

function selectAnswer(idx) {
  const q = questions[currentIdx];
  if (!q || q.id === undefined) return;
  userAnswers[q.id] = idx;
  if (idx === q.correct) sfx.correct();
  else sfx.wrong();
  renderQuestion();
}

function updateLiveScore() {
  let correct = 0, answered = 0;
  questions.forEach(q => {
    if (q && q.id !== undefined && userAnswers && userAnswers.hasOwnProperty(q.id)) {
      answered++;
      if (userAnswers[q.id] === q.correct) correct++;
    }
  });
  document.getElementById("live-score").textContent = correct;
  document.getElementById("live-total").textContent = answered;
}

// ─── DOT NAV ──────────────────────────────────────────────────────────────────
function renderDotNav() {
  const nav = document.getElementById("dot-nav");
  nav.innerHTML = "";
  questions.forEach((q, i) => {
    if (!q) return;
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.title = `Sual ${i + 1}`;
    dot.addEventListener("click", () => { sfx.click(); currentIdx = i; renderQuestion(); });
    nav.appendChild(dot);
  });
  updateDotNav();
}
function updateDotNav() {
  const dots = document.querySelectorAll("#dot-nav .dot");
  dots.forEach((dot, i) => {
    const q = questions[i];
    if (!q) {
      dot.remove();
      return;
    }
    dot.className = "dot";
    if (i === currentIdx) dot.classList.add("current");
    if (userAnswers && q.id !== undefined && userAnswers.hasOwnProperty(q.id)) {
      dot.classList.add(userAnswers[q.id] === q.correct ? "answered-correct" : "answered-wrong");
    }
  });
}

// ─── FINISH QUIZ ──────────────────────────────────────────────────────────────
function finishQuiz() {
  sfx.finish();

  let correct = 0, wrong = 0, skipped = 0;
  questions.forEach(q => {
    if (!q) return;
    if (q.id === undefined || !userAnswers || !userAnswers.hasOwnProperty(q.id)) skipped++;
    else if (userAnswers[q.id] === q.correct) correct++;
    else wrong++;
  });

  const total = Math.max(1, questions.length);
  const percent = Math.round((correct / total) * 100);

  let medal = "💡", labelText = "Daha çox hazırlıq tələb olunur", labelClass = "poor";
  if (percent >= 90) { medal = "🏆"; labelText = "Ekspert Səviyyəsi!"; labelClass = "excellent"; }
  else if (percent >= 75) { medal = "🥇"; labelText = "Yaxşı Nəticə!"; labelClass = "good"; }
  else if (percent >= 50) { medal = "🥈"; labelText = "Orta Nəticə"; labelClass = "average"; }

  document.getElementById("result-medal").textContent = medal;
  document.getElementById("score-big").textContent = correct;
  document.getElementById("score-denom").textContent = `/ ${questions.length}`;
  document.getElementById("score-percent").textContent = `${percent}% Düzgünlük`;
  document.getElementById("result-label").textContent = labelText;
  document.getElementById("result-label").className = `result-label ${labelClass}`;
  document.getElementById("stat-correct").textContent = correct;
  document.getElementById("stat-wrong").textContent = wrong;
  document.getElementById("stat-skipped").textContent = skipped;

  stopQuizTimer();
  const timeSpent = getElapsedTime();
  const statTimeEl = document.getElementById("stat-time");
  if (statTimeEl) statTimeEl.textContent = timeSpent;

  showScreen("results");
}

// ─── RESULTS BUTTONS ─────────────────────────────────────────────────────────
document.getElementById("btn-review").addEventListener("click", () => {
  sfx.click();
  renderReviewList("all");
  showScreen("review");
});

document.getElementById("btn-restart-quiz")?.addEventListener("click", () => {
  sfx.click();
  questions = shuffleQuizQuestions(questions);
  userAnswers = {};
  currentIdx = 0;
  setupQuizScreen();
  showScreen("quiz");
  renderDotNav();
  renderQuestion();
  startQuizTimer();
  toast("Suallar və variantlar yenidən qarışdırıldı!", "success");
});

document.getElementById("btn-new-quiz").addEventListener("click", () => {
  sfx.click();
  stopQuizTimer();
  const nav = document.getElementById("dot-nav");
  if (nav) nav.innerHTML = "";
  showScreen("setup");
});

// ─── REVIEW SCREEN ────────────────────────────────────────────────────────────
document.getElementById("btn-back-review").addEventListener("click", () => {
  sfx.click(); showScreen("results");
});

document.querySelectorAll(".filter-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    sfx.click();
    document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    renderReviewList(btn.dataset.filter);
  });
});

function renderReviewList(filter = "all") {
  const list = document.getElementById("review-list");
  list.innerHTML = "";
  const LETTERS = ["A", "B", "C", "D", "E"];

  questions.forEach((q, idx) => {
    if (!q) return;
    const answered = Boolean(userAnswers && q.id !== undefined && userAnswers.hasOwnProperty(q.id));
    const chosen = answered ? userAnswers[q.id] : null;
    const isCorrect = answered && chosen === q.correct;
    const isWrong = answered && chosen !== q.correct;
    const isSkipped = !answered;

    if (filter === "correct" && !isCorrect) return;
    if (filter === "wrong" && !isWrong) return;
    if (filter === "skipped" && !isSkipped) return;

    const statusClass = isCorrect ? "correct" : isWrong ? "wrong" : "skipped";
    const statusText = isCorrect ? "Düzgün" : isWrong ? "Yanlış" : "Cavabsız";

    let optsHtml = "";
    (q.options || []).forEach((opt, oi) => {
      let cls = "neutral";
      if (oi === q.correct) cls = "correct";
      else if (isWrong && oi === chosen) cls = "wrong-pick";

      optsHtml += `
        <div class="review-option ${cls}">
          <span class="review-opt-label">${LETTERS[oi] || (oi + 1)}</span>
          <span style="flex:1">${opt}</span>
          ${oi === q.correct ? `<span style="font-weight:700;font-size:11px;flex-shrink:0">✓ Düzgün</span>` : ""}
          ${isWrong && oi === chosen ? `<span style="font-weight:700;font-size:11px;flex-shrink:0">✗ Seçiminiz</span>` : ""}
        </div>`;
    });

    const item = document.createElement("div");
    item.className = `review-item ${statusClass}`;
    item.innerHTML = `
      <div class="review-item-header">
        <span class="review-status">${statusText}</span>
        <span class="review-q-num">#${q.id !== undefined ? q.id : (idx + 1)} · Sual ${idx + 1}</span>
      </div>
      <p class="review-q-text">${q.question || "Sual"}</p>
      <div class="review-options">${optsHtml}</div>
      <div style="margin-top:12px;padding:10px 14px;background:rgba(255,255,255,0.03);border-radius:8px;font-size:12px;line-height:1.7;color:var(--text-2);">
        <strong style="color:var(--text-1)">💡 İzah:</strong> ${q.explanation || "İzah yoxdur"}
      </div>
    `;
    list.appendChild(item);
  });

  if (list.children.length === 0) {
    list.innerHTML = `<p style="text-align:center;color:var(--text-2);padding:48px 0">Bu kateqoriyada sual tapılmadı.</p>`;
  }
}

// ─── KEYBOARD SHORTCUTS ───────────────────────────────────────────────────────
window.addEventListener("keydown", e => {
  // Only active while on the quiz screen
  if (!S.quiz.classList.contains("active")) return;

  // 1. CRITICAL: Do NOT intercept if user is pressing Ctrl, Meta (Cmd), Alt, or Shift
  // Allows Ctrl+A (Select All), Ctrl+C (Copy), Shift+Select, etc. to work completely normally!
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;

  // 2. Do not intercept if focus is inside an input or textarea
  const targetTag = e.target?.tagName?.toUpperCase();
  if (targetTag === "INPUT" || targetTag === "TEXTAREA" || e.target?.isContentEditable) return;

  const keyMap = { a: 0, "1": 0, b: 1, "2": 1, c: 2, "3": 2, d: 3, "4": 3, e: 4, "5": 4 };
  const k = e.key.toLowerCase();

  // Option selection (A, B, C, D, E or 1, 2, 3, 4, 5)
  if (keyMap.hasOwnProperty(k)) {
    e.preventDefault();
    const q = questions[currentIdx];
    if (q && q.id !== undefined && (!userAnswers || !userAnswers.hasOwnProperty(q.id))) {
      selectAnswer(keyMap[k]);
    }
    return;
  }

  // Next question: Enter or ArrowRight
  if (e.key === "Enter" || e.key === "ArrowRight") {
    // Calling preventDefault stops the browser from firing a second click on the focused button
    e.preventDefault();
    goToNextQuestion();
    return;
  }

  // Previous question: ArrowLeft
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    goToPrevQuestion();
    return;
  }
});

// ─── INIT ─────────────────────────────────────────────────────────────────────
