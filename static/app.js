/* ============================================================
   JATAYU OS — app.js
   Client-side routing, WebSocket pipeline, voice loop, and the
   orb state machine. The 3D core (battleground.js) is loaded
   lazily on first visit to #battleground and only ever receives
   state flags — it never sits in the WS or audio path.
   ============================================================ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const VIEWS = [
  "dashboard", "battleground", "chat", "knowledge",
  "agents", "integrations", "workspace", "settings",
];

const ORB_STATES = ["IDLE", "LISTENING", "THINKING", "SPEAKING", "ALERT"];

const VOICE_STATUS_TEXT = {
  IDLE: "Tap the orb to speak",
  LISTENING: "Listening — tap again when you're done",
  THINKING: "Thinking",
  SPEAKING: "Speaking",
  ALERT: "Attention needed",
};

/* Integration-category → wing-cluster mapping (Guidelines §4). */
const CLUSTER_KEYWORDS = {
  google: ["gmail", "calendar", "drive", "docs", "sheets", "google"],
  comms: ["telegram", "slack", "discord"],
  knowledge: ["obsidian", "notion", "anythingllm", "knowledge"],
  voice: ["whisper", "elevenlabs", "voice", "tts", "stt", "speech"],
};

const App = {
  /* Integration contract state (Handoff §13) */
  ws: null,
  currentConversationId: null,
  conversation_mode: "chat", // "chat" | "voice"

  wsReady: false,
  wsRetries: 0,
  orbState: "IDLE",
  killSwitch: false,
  status: null,
  panels: null,
  agentsRaw: null,
  pluginsRaw: null,
  clusterHealth: null,

  bg: null,          // battleground module (lazy)
  bgReady: null,     // init promise

  /* voice pipeline */
  mediaRecorder: null,
  recChunks: [],
  recStream: null,
  recTarget: null,   // "voice" | "chat"
  audioCtx: null,
  analyser: null,
  analyserData: null,
  ttsAudio: null,
  ttsUrl: null,
  fallbackSpeaking: false,

  /* streaming */
  streamBuf: "",
  chatStreamEl: null,
  thinkingTimer: null,
  alertFlashTimer: null,
};

/* ============================================================
   ROUTING
   ============================================================ */

function route() {
  let view = location.hash.slice(1) || "dashboard";
  if (!VIEWS.includes(view)) view = "dashboard";

  $$(".view").forEach((s) => s.classList.toggle("active", s.id === "view-" + view));
  $$("#nav a[data-view]").forEach((a) =>
    a.classList.toggle("active", a.dataset.view === view)
  );

  if (view === "battleground") {
    App.conversation_mode = "voice";
    enterBattleground();
  } else {
    App.conversation_mode = "chat";
    if (App.bg) App.bg.pause();
  }

  if (view === "chat") fetchConversations();
  if (view === "agents") renderAgentsView();
  if (view === "integrations") renderIntegrationsView();
  if (view === "workspace") renderWorkspace();
  if (view === "settings") renderSettings();
}

async function enterBattleground() {
  if (!App.bgReady) {
    // Lazy-load Three.js + the scene only when the hero view is entered,
    // so the rest of the OS never pays for the 3D stack.
    App.bgReady = import("./battleground.js").then((mod) => {
      App.bg = mod.default;
      return App.bg.init({
        container: $("#bg-host"),
        getAudioLevel,
      });
    });
  }
  await App.bgReady;
  App.bg.setState(App.orbState);
  if (App.clusterHealth) App.bg.setClusterHealth(App.clusterHealth);
  App.bg.resume();
}

/* ============================================================
   ORB STATE MACHINE
   Color/motion mapping lives in battleground.js and style.css;
   this is the single authority on which state is live.
   ============================================================ */

function setOrbState(state) {
  if (!ORB_STATES.includes(state)) return;
  // Kill switch: crimson overrides everything until released (Guidelines §3).
  if (App.killSwitch && state !== "ALERT") return;

  App.orbState = state;
  document.body.dataset.orbState = state;
  if (App.bg) App.bg.setState(state);

  const statusEl = $("#bg-voice-status");
  if (statusEl) {
    statusEl.textContent =
      App.killSwitch && state === "ALERT"
        ? "Kill switch engaged. All tools are paused."
        : VOICE_STATUS_TEXT[state];
  }
}

/* ============================================================
   WEBSOCKET — primary channel. ws://localhost:8000/ws
   ============================================================ */

function connectWS() {
  const url = `ws://${location.host}/ws`;
  App.ws = new WebSocket(url);

  App.ws.onopen = () => {
    App.wsReady = true;
    App.wsRetries = 0;
    setConnBadge(true);
  };

  App.ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case "chunk": handleChunk(msg); break;
      case "done": handleDone(msg); break;
      case "panels": handlePanels(msg); break;
      case "error": handleTurnError(msg); break;
    }
  };

  App.ws.onclose = () => {
    App.wsReady = false;
    setConnBadge(false);
    const delay = Math.min(10000, 1000 * Math.pow(1.6, App.wsRetries++));
    setTimeout(connectWS, delay);
  };

  App.ws.onerror = () => App.ws.close();
}

function setConnBadge(ok) {
  const badge = $("#conn-badge");
  badge.textContent = ok ? "LINKED" : "OFFLINE";
  badge.className = "badge " + (ok ? "ok" : "err");
  const bgWs = $("#bg-ws-status");
  if (bgWs) bgWs.textContent = ok ? "ONLINE" : "OFFLINE";
  updateCoreStatusLine();
}

function sendText(text) {
  if (!App.wsReady) {
    if (App.conversation_mode === "voice") {
      $("#bg-voice-status").textContent = "Jatayu is offline. Reconnecting.";
      setOrbState("IDLE");
    }
    return false;
  }
  const payload = { text };
  if (App.currentConversationId) payload.conversation_id = App.currentConversationId;
  App.ws.send(JSON.stringify(payload));

  App.streamBuf = "";
  setOrbState("THINKING");

  clearTimeout(App.thinkingTimer);
  App.thinkingTimer = setTimeout(() => {
    if (App.orbState === "THINKING") {
      handleTurnError({ text: "No response from Jatayu. Try again." });
    }
  }, 90000);
  return true;
}

function handleChunk(msg) {
  App.streamBuf += msg.text;
  if (App.conversation_mode === "voice") {
    const el = $("#bg-assistant-text");
    el.textContent = App.streamBuf;
    el.parentElement.scrollTop = el.parentElement.scrollHeight;
  } else {
    if (!App.chatStreamEl) App.chatStreamEl = appendChatBubble("assistant", "");
    App.chatStreamEl.querySelector(".bubble").textContent = App.streamBuf;
    scrollThread();
  }
}

function handleDone(msg) {
  clearTimeout(App.thinkingTimer);
  App.currentConversationId = msg.conversation_id;

  if (App.conversation_mode === "voice") {
    $("#bg-assistant-text").textContent = msg.text;
    speakReply(msg.text);
  } else {
    if (!App.chatStreamEl) App.chatStreamEl = appendChatBubble("assistant", "");
    App.chatStreamEl.querySelector(".bubble").textContent = msg.text;
    App.chatStreamEl = null;
    scrollThread();
    setOrbState("IDLE");
    fetchConversations(); // pick up the new/updated conversation title
  }

  addTimelineEntry(msg.text);
}

function handlePanels(msg) {
  App.panels = msg;
  renderPanels(msg);
  renderWorkspace();
}

function handleTurnError(msg) {
  clearTimeout(App.thinkingTimer);
  const text = msg.text || "Something went wrong.";

  if (App.conversation_mode === "voice") {
    $("#bg-assistant-text").textContent = text;
  } else {
    if (App.chatStreamEl) {
      App.chatStreamEl.querySelector(".bubble").textContent = text;
      App.chatStreamEl = null;
    } else {
      appendChatBubble("assistant", text);
    }
  }

  // A failed turn flashes crimson, then returns to rest (Guidelines §1).
  if (!App.killSwitch) {
    setOrbState("ALERT");
    clearTimeout(App.alertFlashTimer);
    App.alertFlashTimer = setTimeout(() => {
      if (!App.killSwitch && App.orbState === "ALERT") setOrbState("IDLE");
    }, 4000);
  }
}

/* ============================================================
   VOICE — mic capture → /api/transcribe → WS → /api/speak
   ============================================================ */

function ensureAudioGraph() {
  // Must be created inside a user gesture. One element, one source node.
  if (App.audioCtx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  App.audioCtx = new Ctx();
  App.ttsAudio = new Audio();
  App.ttsAudio.crossOrigin = "anonymous";
  const src = App.audioCtx.createMediaElementSource(App.ttsAudio);
  App.analyser = App.audioCtx.createAnalyser();
  App.analyser.fftSize = 512;
  App.analyserData = new Uint8Array(App.analyser.fftSize);
  src.connect(App.analyser);
  App.analyser.connect(App.audioCtx.destination);
}

/* Live TTS amplitude 0..1, or null when unavailable — the orb's
   SPEAKING pulse is driven from this (Guidelines §3). */
function getAudioLevel() {
  if (App.fallbackSpeaking) return null;
  if (!App.analyser || !App.ttsAudio || App.ttsAudio.paused) return null;
  App.analyser.getByteTimeDomainData(App.analyserData);
  let sum = 0;
  for (let i = 0; i < App.analyserData.length; i++) {
    const v = (App.analyserData[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / App.analyserData.length) * 3.2);
}

async function startRecording(target) {
  try {
    App.recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    if (target === "voice") {
      $("#bg-voice-status").textContent = "Microphone unavailable. Check browser permissions.";
    }
    return false;
  }
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";
  App.recChunks = [];
  App.recTarget = target;
  App.mediaRecorder = new MediaRecorder(App.recStream, { mimeType: mime });
  App.mediaRecorder.ondataavailable = (e) => {
    if (e.data.size) App.recChunks.push(e.data);
  };
  App.mediaRecorder.start();
  if (target === "voice") setOrbState("LISTENING");
  return true;
}

function stopRecording() {
  return new Promise((resolve) => {
    if (!App.mediaRecorder || App.mediaRecorder.state === "inactive") {
      resolve(null);
      return;
    }
    App.mediaRecorder.onstop = () => {
      App.recStream.getTracks().forEach((t) => t.stop());
      resolve(new Blob(App.recChunks, { type: "audio/webm" }));
    };
    App.mediaRecorder.stop();
  });
}

async function transcribe(blob) {
  const res = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "Content-Type": "audio/webm" },
    body: blob,
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return (data.transcript || "").trim();
}

/* Orb interaction flow (Handoff §7). */
async function toggleMic() {
  ensureAudioGraph();
  if (App.audioCtx && App.audioCtx.state === "suspended") App.audioCtx.resume();

  switch (App.orbState) {
    case "IDLE":
      await startRecording("voice");
      break;

    case "LISTENING": {
      setOrbState("THINKING");
      $("#bg-voice-status").textContent = "Transcribing";
      const blob = await stopRecording();
      if (!blob || blob.size === 0) {
        setOrbState("IDLE");
        return;
      }
      try {
        const transcript = await transcribe(blob);
        if (!transcript) {
          setOrbState("IDLE");
          $("#bg-voice-status").textContent = "Nothing heard. Tap the orb to try again.";
          return;
        }
        $("#bg-user-line").textContent = transcript;
        $("#bg-assistant-text").textContent = "";
        sendText(transcript);
      } catch {
        setOrbState("IDLE");
        $("#bg-voice-status").textContent = "Transcription failed. Tap the orb to try again.";
      }
      break;
    }

    case "SPEAKING":
      cancelSpeech();
      break;

    // THINKING and ALERT ignore taps.
  }
}

async function speakReply(text) {
  setOrbState("SPEAKING");
  try {
    const res = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const ttsError = res.headers.get("X-TTS-Error");
    const buf = await res.arrayBuffer();
    if (!res.ok || ttsError || buf.byteLength === 0) {
      _speakWithBrowserFallback(text);
      return;
    }
    ensureAudioGraph();
    const blob = new Blob([buf], { type: "audio/mpeg" });
    if (App.ttsUrl) URL.revokeObjectURL(App.ttsUrl);
    App.ttsUrl = URL.createObjectURL(blob);

    if (App.ttsAudio) {
      App.ttsAudio.src = App.ttsUrl;
      App.ttsAudio.onended = () => setOrbState("IDLE");
      App.ttsAudio.onerror = () => _speakWithBrowserFallback(text);
      App.ttsAudio.play().catch(() => _speakWithBrowserFallback(text));
    } else {
      // No AudioContext available at all — plain playback, no analyser.
      const el = new Audio(App.ttsUrl);
      el.onended = () => setOrbState("IDLE");
      el.play().catch(() => _speakWithBrowserFallback(text));
    }
  } catch {
    _speakWithBrowserFallback(text);
  }
}

function _speakWithBrowserFallback(text) {
  if (!("speechSynthesis" in window)) {
    setOrbState("IDLE");
    return;
  }
  App.fallbackSpeaking = true;
  const utter = new SpeechSynthesisUtterance(text);
  utter.onend = utter.onerror = () => {
    App.fallbackSpeaking = false;
    setOrbState("IDLE");
  };
  window.speechSynthesis.speak(utter);
}

function cancelSpeech() {
  if (App.ttsAudio && !App.ttsAudio.paused) App.ttsAudio.pause();
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  App.fallbackSpeaking = false;
  setOrbState("IDLE");
}

/* ============================================================
   CHAT VIEW
   ============================================================ */

async function fetchConversations() {
  try {
    const res = await fetch("/api/conversations?limit=50");
    const data = await res.json();
    renderConversationList(data.conversations || []);
  } catch {
    /* sidebar simply stays as-is while offline */
  }
}

function renderConversationList(conversations) {
  const list = $("#conv-list");
  list.innerHTML = "";
  for (const conv of conversations) {
    const li = document.createElement("li");
    li.dataset.id = conv.id;
    if (conv.id === App.currentConversationId) li.classList.add("active");
    li.innerHTML =
      `<div class="conv-title">${escapeHtml(conv.title || "Untitled")}</div>` +
      `<div class="conv-time">${relTime(conv.updated_at)}</div>`;
    li.addEventListener("click", () => loadConversation(conv.id));
    list.appendChild(li);
  }
}

async function loadConversation(id) {
  const res = await fetch(`/api/conversations/${id}`);
  const data = await res.json();
  App.currentConversationId = id;
  App.chatStreamEl = null;

  const thread = $("#chat-thread");
  thread.innerHTML = "";
  for (const m of data.messages || []) {
    if (m.role !== "user" && m.role !== "assistant") continue; // system/tool: never rendered
    appendChatBubble(m.role, m.content);
  }
  scrollThread();
  $$("#conv-list li").forEach((li) =>
    li.classList.toggle("active", li.dataset.id === id)
  );
}

function newChat() {
  App.currentConversationId = null;
  App.chatStreamEl = null;
  $("#chat-thread").innerHTML =
    '<div class="chat-empty"><p>Ask anything, or give Jatayu something to do.</p></div>';
  $$("#conv-list li").forEach((li) => li.classList.remove("active"));
  $("#chat-input").focus();
}

function appendChatBubble(role, text) {
  const empty = $("#chat-empty");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.innerHTML =
    role === "assistant"
      ? '<span class="avatar" aria-hidden="true"></span><div class="bubble"></div>'
      : '<div class="bubble"></div>';
  div.querySelector(".bubble").textContent = text;
  $("#chat-thread").appendChild(div);
  return div;
}

function scrollThread() {
  const t = $("#chat-thread");
  t.scrollTop = t.scrollHeight;
}

function sendChatMessage() {
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text) return;
  appendChatBubble("user", text);
  scrollThread();
  App.chatStreamEl = null;
  if (sendText(text)) input.value = "";
}

async function toggleChatMic() {
  const btn = $("#btn-chat-mic");
  if (App.mediaRecorder && App.mediaRecorder.state === "recording" && App.recTarget === "chat") {
    btn.classList.remove("recording");
    const blob = await stopRecording();
    if (!blob) return;
    try {
      const transcript = await transcribe(blob);
      if (transcript) {
        const input = $("#chat-input");
        input.value = (input.value ? input.value + " " : "") + transcript;
        input.focus();
      }
    } catch {
      /* leave the input untouched on failure */
    }
  } else {
    const ok = await startRecording("chat");
    if (ok) btn.classList.add("recording");
  }
}

/* ============================================================
   STATUS / AGENTS POLLING — kill switch + wing registry
   ============================================================ */

async function pollStatus() {
  try {
    const res = await fetch("/api/status");
    const status = await res.json();
    App.status = status;

    const wasKilled = App.killSwitch;
    App.killSwitch = !!status.kill_switch;

    // HUD bindings — live data, never baked into the artwork (Guidelines §2).
    setText("#bg-model", status.model || "—");
    setText("#bg-model-footer", status.model || "—");
    setText("#bg-tools", String(status.tools ?? "—"));
    setText("#bg-kill", App.killSwitch ? "ENGAGED" : "OFF");
    setText("#stat-status", (status.status || "—").toUpperCase());

    const badge = $("#status-badge");
    badge.textContent = (status.status || "—").toUpperCase();
    badge.className =
      "badge " +
      (App.killSwitch ? "err" : status.status === "optimal" ? "ok" : "warn");

    updateCoreStatusLine();

    if (App.killSwitch && !wasKilled) {
      App.killSwitch = false; // let the transition through the guard
      setOrbState("ALERT");
      App.killSwitch = true;
    } else if (!App.killSwitch && wasKilled) {
      setOrbState("IDLE");
    }
  } catch {
    /* status endpoint unreachable — connection badge already covers this */
  }
}

function updateCoreStatusLine() {
  const line = $("#bg-status-line");
  const core = $("#bg-core-status");
  const dash = $("#dash-status-line");
  let stateWord;
  if (App.killSwitch) stateWord = "PAUSED";
  else if (!App.wsReady) stateWord = "STANDBY";
  else if (App.status && App.status.status !== "optimal")
    stateWord = App.status.status.toUpperCase();
  else stateWord = "ACTIVE";
  if (line) line.textContent = `ADVANCED AGI — ${stateWord}`;
  if (core) core.textContent = App.killSwitch ? "PAUSED" : App.wsReady ? "OPERATIONAL" : "STANDBY";
  if (dash) dash.textContent = `SYSTEM ${stateWord}`;
}

const HEALTH_RANK = { healthy: 0, active: 0, configured: 0, available: 0, degraded: 1 };

async function pollAgents() {
  try {
    const [agentsRes, pluginsRes] = await Promise.all([
      fetch("/api/agents"),
      fetch("/api/plugins"),
    ]);
    App.agentsRaw = await agentsRes.json();
    App.pluginsRaw = await pluginsRes.json();

    App.clusterHealth = computeClusterHealth(App.agentsRaw, App.pluginsRaw);
    if (App.bg) App.bg.setClusterHealth(App.clusterHealth);

    for (const [cluster, health] of Object.entries(App.clusterHealth)) {
      const el = document.querySelector(`.bg-cluster[data-cluster="${cluster}"]`);
      if (el) el.className = `bg-cluster ${health}`;
    }
    renderAgentsView();
    renderIntegrationsView();
  } catch {
    /* leave last known wing state in place */
  }
}

function computeClusterHealth(agents, plugins) {
  const worst = { google: 0, comms: 0, knowledge: 0, voice: 0 };
  const entries = [
    ...Object.entries(agents || {}),
    ...Object.entries(plugins || {}),
  ];
  for (const [name, info] of entries) {
    const key = name.toLowerCase();
    const status = String(info.status || "healthy").toLowerCase();
    const rank = HEALTH_RANK[status] ?? 2; // unknown statuses count as failed
    for (const [cluster, words] of Object.entries(CLUSTER_KEYWORDS)) {
      if (words.some((w) => key.includes(w))) {
        worst[cluster] = Math.max(worst[cluster], rank);
        break;
      }
    }
  }
  const label = ["healthy", "degraded", "failed"];
  return Object.fromEntries(
    Object.entries(worst).map(([k, v]) => [k, label[v]])
  );
}

/* ============================================================
   DASHBOARD / PANELS
   ============================================================ */

async function loadDashboard() {
  try {
    const [reminders, schedule, drafts, memory] = await Promise.all(
      ["reminders", "schedule", "drafts", "memory"].map((p) =>
        fetch(`/api/${p}`).then((r) => r.json())
      )
    );
    renderPanels({
      reminders: reminders.reminders,
      schedule,
      drafts: drafts.drafts,
      memory: memory.memories,
    });
    renderWorkspace();
  } catch {
    /* panels stay in their empty states while offline */
  }
}

function renderPanels(data) {
  App.panels = data;

  const reminders = data.reminders || [];
  fillList(
    "#panel-reminders",
    reminders.slice(0, 5).map(
      (r) =>
        `<li><span>${escapeHtml(r.text)}</span><span class="meta">${escapeHtml(r.due_time || "")}</span></li>`
    ),
    "Nothing pending."
  );

  const tasks = (data.schedule && data.schedule.tasks) || [];
  fillList(
    "#panel-schedule",
    tasks.map(
      (t) =>
        `<li><i class="prio ${escapeHtml(t.priority)}"></i><span>${escapeHtml(t.description)}</span></li>`
    ),
    "No tasks scheduled today."
  );
  setText("#stat-tasks", String(tasks.length));

  const drafts = data.drafts || [];
  fillList(
    "#panel-drafts",
    drafts.map((d) => `<li><span>${escapeHtml(d.text || d.summary || JSON.stringify(d))}</span></li>`),
    "No drafts waiting for review."
  );

  const memories = data.memory || [];
  fillList(
    "#panel-memory",
    memories.slice(0, 6).map(
      (m) =>
        `<li><span>${escapeHtml(m.fact)}</span><span class="meta">${escapeHtml(m.category || "")}</span></li>`
    ),
    "Nothing remembered yet."
  );
  setText("#stat-memories", String(memories.length));
}

function addTimelineEntry(text) {
  const timeline = $("#timeline");
  const empty = timeline.querySelector(".empty");
  if (empty) empty.remove();
  const li = document.createElement("li");
  const snippet = text.length > 90 ? text.slice(0, 90) + "…" : text;
  li.innerHTML = `<span>${escapeHtml(snippet)}</span><span class="meta">${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>`;
  timeline.prepend(li);
  while (timeline.children.length > 12) timeline.lastChild.remove();
}

/* ============================================================
   SECONDARY VIEWS
   ============================================================ */

function renderAgentsView() {
  if (!App.agentsRaw) return;
  fillList(
    "#agents-list",
    Object.entries(App.agentsRaw).map(([name, info]) => {
      const s = String(info.status || "unknown").toLowerCase();
      const cls = (HEALTH_RANK[s] ?? 2) === 0 ? "healthy" : s === "degraded" ? "degraded" : "failed";
      return `<li><i class="health-dot ${cls}"></i><span>${escapeHtml(name)}</span><span class="meta">${escapeHtml(s)}</span></li>`;
    }),
    "No agents registered."
  );
}

function renderIntegrationsView() {
  if (!App.pluginsRaw) return;
  fillList(
    "#plugins-list",
    Object.entries(App.pluginsRaw).map(([id, info]) => {
      const s = String(info.status || "unknown").toLowerCase();
      const cls = (HEALTH_RANK[s] ?? 2) === 0 ? "healthy" : s === "degraded" ? "degraded" : "failed";
      return `<li><i class="health-dot ${cls}"></i><span>${escapeHtml(id)}</span><span class="meta">${escapeHtml(s)}</span></li>`;
    }),
    "No plugins loaded."
  );
}

function renderWorkspace() {
  if (!App.panels) return;
  const { reminders = [], schedule = {}, drafts = [] } = App.panels;
  fillList(
    "#ws-reminders",
    reminders.map(
      (r) => `<li><span>${escapeHtml(r.text)}</span><span class="meta">${escapeHtml(r.due_time || "")}</span></li>`
    ),
    "Nothing pending."
  );
  fillList(
    "#ws-schedule",
    (schedule.tasks || []).map(
      (t) => `<li><i class="prio ${escapeHtml(t.priority)}"></i><span>${escapeHtml(t.description)}</span></li>`
    ),
    "No tasks scheduled today."
  );
  fillList(
    "#ws-drafts",
    drafts.map((d) => `<li><span>${escapeHtml(d.text || d.summary || JSON.stringify(d))}</span></li>`),
    "No drafts waiting for review."
  );
}

async function renderSettings() {
  try {
    const [org, status] = await Promise.all([
      fetch("/api/organization").then((r) => r.json()),
      fetch("/api/status").then((r) => r.json()),
    ]);
    $("#settings-info").innerHTML = [
      ["Organization", org.name],
      ["Model", (org.settings && org.settings.model) || status.model],
      ["Voice", org.settings && org.settings.voice],
      ["Proactive mode", org.settings && org.settings.proactive ? "On" : "Off"],
      ["Tools available", status.tools],
      ["Kill switch", status.kill_switch ? "Engaged" : "Off"],
      ["Data directory", org.data_dir],
    ]
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`)
      .join("");
  } catch {
    /* keep the loading placeholder */
  }
}

/* ============================================================
   HELPERS
   ============================================================ */

function fillList(sel, items, emptyText) {
  const el = $(sel);
  if (!el) return;
  el.innerHTML = items.length
    ? items.join("")
    : `<li class="empty">${emptyText}</li>`;
}

function setText(sel, text) {
  const el = $(sel);
  if (el) el.textContent = text;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function relTime(iso) {
  const then = new Date(iso);
  if (isNaN(then)) return "";
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  if (days <= 0)
    return "Today " + then.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return then.toLocaleDateString();
}

/* ============================================================
   BOOT
   ============================================================ */

function bindEvents() {
  window.addEventListener("hashchange", route);

  $("#orb-button").addEventListener("click", toggleMic);

  $("#btn-new-chat").addEventListener("click", newChat);
  $("#btn-chat-send").addEventListener("click", sendChatMessage);
  $("#btn-chat-mic").addEventListener("click", toggleChatMic);
  $("#chat-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });
}

function boot() {
  setText(
    "#stat-date",
    new Date().toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
    })
  );

  bindEvents();
  connectWS();
  route();
  loadDashboard();

  pollStatus();
  setInterval(pollStatus, 12000);
  pollAgents();
  setInterval(pollAgents, 30000);
}

boot();
