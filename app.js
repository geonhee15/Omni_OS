// OMNI_OS core
// Future apps get integrated by registering themselves as modules here.
const OmniOS = {
  version: "0.7.0",
  bootTime: Date.now(),
  modules: {},

  register(name, module) {
    this.modules[name] = module;
    if (typeof module.init === "function") module.init();
  },
};

// ---------- native bridge (WKWebView <-> Objective-C) ----------
const OmniNative = {
  _seq: 0,
  _pending: {},
  available: !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.omni),

  request(cmd, arg = null, timeoutMs = 8000) {
    if (!this.available) return Promise.reject(new Error("bridge offline"));
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        delete this._pending[id];
        reject(new Error("bridge timeout"));
      }, timeoutMs);
      this._pending[id] = { resolve, timer };
      window.webkit.messageHandlers.omni.postMessage({ id, cmd, arg });
    });
  },

  _deliver(id, payload) {
    const p = this._pending[id];
    if (!p) return;
    clearTimeout(p.timer);
    delete this._pending[id];
    p.resolve(payload);
  },
};
window.OmniNative = OmniNative;

// ---------- panel navigation ----------
OmniOS.register("nav", {
  init() {
    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.addEventListener("click", () => this.show(btn.dataset.panel));
    });
  },

  show(name) {
    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.panel === name);
    });
    document.querySelectorAll(".panel").forEach((panel) => {
      panel.classList.toggle("active", panel.id === `panel-${name}`);
    });
    document.dispatchEvent(new CustomEvent("omni:panel", { detail: name }));
  },
});

// ---------- module: clock ----------
OmniOS.register("clock", {
  init() {
    this.timeEl = document.getElementById("clock-time");
    this.dateEl = document.getElementById("clock-date");
    this.uptimeEl = document.getElementById("uptime");
    this.tick();
    setInterval(() => this.tick(), 1000);
  },

  tick() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");

    this.timeEl.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    this.dateEl.textContent = now
      .toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      })
      .toUpperCase();

    const up = Math.floor((Date.now() - OmniOS.bootTime) / 1000);
    this.uptimeEl.textContent = `UPTIME ${pad(Math.floor(up / 3600))}:${pad(Math.floor((up % 3600) / 60))}:${pad(up % 60)}`;
  },
});

// ---------- module: Security-Protocol-1 status ----------
OmniOS.register("sp1", {
  POLL_MS: 5000,

  // protocol.log is written in Korean by Security-Protocol-1; map known
  // markers to English labels for display. Order matters: first match wins.
  EVENT_MAP: [
    { match: "입력 차단 활성화", label: "LOCKDOWN ENGAGED — INPUT BLOCKED", tone: "alert" },
    { match: "[LOCK] 오버레이 표시 시도", label: "LOCKDOWN REQUESTED", tone: "warn" },
    { match: "[LOCK] UNLOCK 선택", label: "AUTH PHASE ENTERED", tone: "warn" },
    { match: "[OPEN] 락다운 해제", label: "LOCKDOWN RELEASED", tone: "ok" },
    { match: "[LOCKOUT]", label: "LOCKOUT — SWITCHED TO macOS LOGIN", tone: "alert" },
    { match: "[ESC] 비상 키", label: "EMERGENCY ESCAPE", tone: "warn" },
    { match: "[ALERT] 침입 시도 기록", label: "INTRUSION RECORDED", tone: "alert" },
    { match: "[FAIL] 해제 실패", label: "UNLOCK ATTEMPT FAILED", tone: "alert" },
    { match: "해제 단계", label: "UNLOCK STEP OK", tone: "ok" },
    { match: "해제 시퀀스 시간 초과", label: "UNLOCK SEQUENCE TIMEOUT", tone: "warn" },
    { match: "트리거 제스처 감지", label: "TRIGGER GESTURE DETECTED", tone: "warn" },
    { match: "제스처 인식:", label: null, tone: "" }, // handled specially (extract gesture name)
    { match: "[REMOTE] 명령 수신:", label: null, tone: "warn" }, // extract command
    { match: "[REMOTE] 원격 락다운 요청", label: "REMOTE LOCK REQUEST", tone: "warn" },
    { match: "[REMOTE] 원격 해제 요청", label: "REMOTE UNLOCK REQUEST", tone: "warn" },
    { match: "[REMOTE] 토큰 불일치", label: "REMOTE TOKEN MISMATCH — IGNORED", tone: "alert" },
    { match: "[REMOTE] unlock 요청 거부", label: "REMOTE UNLOCK DENIED (DISABLED)", tone: "warn" },
    { match: "원격 명령 수신 시작", label: "REMOTE LISTENER STARTED", tone: "ok" },
    { match: "Security-Protocol-1 가동", label: "WATCHER STARTED", tone: "ok" },
    { match: "카메라 감시 시작", label: "CAMERA MONITORING STARTED", tone: "ok" },
    { match: "macOS 잠금 해제 감지", label: "macOS SESSION UNLOCKED", tone: "" },
    { match: "macOS 비밀번호 확인됨", label: "PASSWORD VERIFIED — FAIL COUNT RESET", tone: "ok" },
    { match: "워치독", label: "WATCHDOG INTERVENTION", tone: "warn" },
    { match: "카메라 실패", label: "CAMERA FAILURE", tone: "alert" },
    { match: "카메라 스레드", label: "CAMERA THREAD ERROR", tone: "alert" },
    { match: "카메라 권한", label: "CAMERA PERMISSION EVENT", tone: "warn" },
    { match: "손쉬운 사용", label: "ACCESSIBILITY PERMISSION MISSING", tone: "alert" },
  ],

  init() {
    const $ = (id) => document.getElementById(id);
    this.els = {
      state: $("sp1-state"),
      since: $("sp1-since"),
      stateMod: $("mod-state"),
      sync: $("sp1-sync"),
      link: $("sp1-link"),
      feed: $("sp1-feed"),
      navDot: $("sp1-nav-dot"),
      wState: $("w-state"),
      wPid: $("w-pid"),
      wUptime: $("w-uptime"),
      wCpu: $("w-cpu"),
      wCpuBar: $("w-cpu-bar"),
      wMem: $("w-mem"),
      wMemBar: $("w-mem-bar"),
      components: $("w-components"),
      aInstalled: $("a-installed"),
      aLoaded: $("a-loaded"),
      aLabel: $("a-label"),
      lSize: $("l-size"),
      lMtime: $("l-mtime"),
      lLines: $("l-lines"),
      hexstream: $("hexstream"),
      attempts: $("sp1-attempts"),
      attemptsN: $("sp1-attempts-n"),
      gTotal: $("g-total"),
      gRows: $("g-rows"),
      spark: $("spark"),
      sparkNote: $("spark-note"),
      nServer: $("n-server"),
      nLat: $("n-lat"),
      nProvider: $("n-provider"),
      nTopic: $("n-topic"),
      rEnabled: $("r-enabled"),
      rUnlock: $("r-unlock"),
      iCount: $("i-count"),
      iLast: $("i-last"),
      sModel: $("s-model"),
      scanSweep: $("scan-sweep"),
      igNote: $("ig-note"),
      igTabs: $("ig-tabs"),
      igGrid: $("ig-grid"),
      igEmpty: $("ig-empty"),
      lightbox: $("lightbox"),
      lbImg: $("lb-img"),
      lbMeta: $("lb-meta"),
      lbCanvas: $("lb-canvas"),
      lbAnalysis: $("lb-analysis"),
    };
    this.els.lightbox.addEventListener("click", () => {
      this._lbToken++; // cancels any in-flight analysis render
      this.els.lightbox.hidden = true;
      this.els.lbImg.src = "";
      this.els.lbCanvas.width = 0;
      this.els.lbAnalysis.innerHTML = "";
    });
    this.buildBars();
    this.refresh();
    setInterval(() => this.refresh(), this.POLL_MS);
  },

  buildBars() {
    const make = (el, n) => {
      for (let i = 0; i < n; i++) el.appendChild(document.createElement("i"));
    };
    make(this.els.wCpuBar, 12);
    make(this.els.wMemBar, 12);
    make(this.els.spark, 30);
  },

  async refresh() {
    if (!OmniNative.available) {
      // dev convenience: ?mock=1 renders the panel with sample data in a browser
      if (location.search.includes("mock=1")) {
        this.render(this.mockPayload());
        if (this._galleryItems === null) {
          this._galleryItems = this.mockGallery();
          this.renderGallery();
        }
        return;
      }
      this.renderBridgeOffline();
      return;
    }
    try {
      const s = await OmniNative.request("sp1.status");
      this.render(s);
    } catch (e) {
      this.setState("warn", "SYNC ERROR", "native bridge did not respond");
      this.els.navDot.className = "nav-dot off";
    }
  },

  // ── intruder gallery ──
  GALLERY_CATS: [
    ["all", "ALL"],
    ["wrong_gesture", "WRONG GESTURE"],
    ["keyboard", "KEYBOARD"],
    ["mouse", "MOUSE"],
    ["snap", "REMOTE SNAP"],
  ],
  _galleryItems: null,
  _galleryCat: "all",
  _lastIntruderCount: null,

  async fetchGallery() {
    try {
      const r = await OmniNative.request("sp1.intruders", null, 20000);
      this._galleryItems = r.items || [];
      this.renderGallery();
    } catch (e) {
      /* keep whatever we had; next count change retries */
      this._lastIntruderCount = null;
    }
  },

  catTone(reason) {
    if (reason === "wrong_gesture") return "alert";
    if (reason === "keyboard" || reason === "mouse") return "warn";
    return "";
  },

  fmtDateTime(epoch) {
    if (typeof epoch !== "number") return "—";
    const d = new Date(epoch * 1000);
    const mon = d.toLocaleDateString("en-US", { month: "short" }).toUpperCase();
    const pad = (x) => String(x).padStart(2, "0");
    return `${mon} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  },

  renderGallery() {
    const items = this._galleryItems || [];
    const els = this.els;

    // tabs with per-category counts
    els.igTabs.innerHTML = "";
    for (const [key, label] of this.GALLERY_CATS) {
      const n = key === "all" ? items.length : items.filter((i) => i.reason === key).length;
      const tab = document.createElement("button");
      tab.className = `ig-tab${this._galleryCat === key ? " active" : ""}`;
      tab.innerHTML = `${label}<span class="cnt">${n}</span>`;
      tab.addEventListener("click", () => {
        this._galleryCat = key;
        this.renderGallery();
      });
      els.igTabs.appendChild(tab);
    }

    const shown = this._galleryCat === "all"
      ? items
      : items.filter((i) => i.reason === this._galleryCat);

    els.igNote.textContent = `${items.length} CAPTURES`;
    els.igGrid.innerHTML = "";
    els.igEmpty.hidden = shown.length > 0;
    if (items.length > 0) this.prewarmHuman();

    for (const item of shown) {
      const cell = document.createElement("div");
      cell.className = "ig-cell";
      if (typeof item.thumb === "string" && item.thumb) {
        const img = document.createElement("img");
        img.src = item.thumb.startsWith("data:")
          ? item.thumb
          : `data:image/jpeg;base64,${item.thumb}`;
        img.loading = "lazy";
        cell.appendChild(img);
      }
      const label = document.createElement("div");
      label.className = "ig-label";
      const ts = document.createElement("span");
      ts.textContent = this.fmtDateTime(item.epoch);
      const tag = document.createElement("span");
      tag.className = `ig-tag ${this.catTone(item.reason)}`;
      tag.textContent = (item.reason || "?").replace(/_/g, " ").toUpperCase();
      label.append(ts, tag);
      cell.appendChild(label);
      cell.addEventListener("click", () => this.openLightbox(item));
      els.igGrid.appendChild(cell);
    }
  },

  _lbToken: 0,

  async openLightbox(item) {
    const els = this.els;
    const token = ++this._lbToken;
    els.lbCanvas.width = 0; // clear any previous overlay
    els.lbAnalysis.innerHTML = "";
    // show the thumbnail immediately, then swap in the full-size image
    if (typeof item.thumb === "string" && item.thumb) {
      els.lbImg.src = item.thumb.startsWith("data:")
        ? item.thumb
        : `data:image/jpeg;base64,${item.thumb}`;
    }
    els.lbMeta.textContent =
      `${this.fmtDateTime(item.epoch)} · ${(item.reason || "?").replace(/_/g, " ").toUpperCase()} · ${item.name || ""}`;
    els.lightbox.hidden = false;
    if (OmniNative.available && item.name) {
      try {
        const r = await OmniNative.request("sp1.intruderImage", item.name, 20000);
        if (r.image && token === this._lbToken) {
          els.lbImg.src = `data:image/jpeg;base64,${r.image}`;
        }
      } catch (e) {
        /* thumbnail stays */
      }
    }
    if (token === this._lbToken) this.analyzeLightbox(token);
  },

  // ── Human (vladmandic/human) neural analysis of the opened snapshot ──
  _human: null,
  _humanLoad: null,
  _prewarmed: false,

  // First inference compiles WebGL shaders (~30s). Kick that off in the
  // background once the gallery has content, so clicking a photo is fast.
  prewarmHuman() {
    if (this._prewarmed) return;
    this._prewarmed = true;
    setTimeout(async () => {
      try {
        const human = await this.ensureHuman();
        const c = document.createElement("canvas");
        c.width = 256;
        c.height = 256;
        await human.detect(c);
        this._prewarmDone = true;
      } catch (e) {
        /* prewarm is best-effort */
      }
    }, 1500);
  },

  ensureHuman() {
    if (this._humanLoad) return this._humanLoad;
    this._humanLoad = new Promise((resolve, reject) => {
      const sc = document.createElement("script");
      sc.src = "vendor/human.js";
      sc.onload = resolve;
      sc.onerror = () => reject(new Error("human.js failed to load"));
      document.head.appendChild(sc);
    }).then(() => {
      const NS = window.Human;
      const Cls = NS.Human || NS.default || NS;
      this._human = new Cls({
        modelBasePath: "vendor/models/",
        backend: "webgl",
        warmup: "none",
        filter: { enabled: false },
        face: {
          enabled: true,
          detector: { rotation: false, maxDetected: 5 },
          mesh: { enabled: true },
          iris: { enabled: false },
          emotion: { enabled: true },
          description: { enabled: true },
          antispoof: { enabled: false },
          liveness: { enabled: false },
        },
        body: { enabled: true, maxDetected: 2 },
        hand: { enabled: false },
        object: { enabled: false },
        segmentation: { enabled: false },
        gesture: { enabled: true },
      });
      return this._human;
    });
    this._humanLoad.catch(() => { this._humanLoad = null; }); // allow retry
    return this._humanLoad;
  },

  async analyzeLightbox(token) {
    const els = this.els;
    const img = els.lbImg;
    const line = (cls, html) => `<div class="lb-line ${cls}">${html}</div>`;
    const pct = (v) => `${Math.round((v || 0) * 100)}%`;
    els.lbAnalysis.innerHTML = line("dim", "LOADING NEURAL MODELS&hellip;");
    try {
      const human = await this.ensureHuman();
      if (token !== this._lbToken) return;
      if (!img.complete) {
        await new Promise((res, rej) => {
          img.addEventListener("load", res, { once: true });
          img.addEventListener("error", rej, { once: true });
        });
      }
      if (token !== this._lbToken) return;
      els.lbAnalysis.innerHTML = line("dim",
        this._prewarmDone ? "ANALYZING&hellip;" : "ANALYZING&hellip; FIRST RUN COMPILES SHADERS (~30S)");
      const res = await human.detect(img);
      this._prewarmDone = true;
      if (token !== this._lbToken) return;

      // overlay: canvas at source resolution, CSS-scaled onto the image
      const canvas = els.lbCanvas;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const drawOpts = {
        color: "rgba(53, 214, 255, 0.85)",
        labelColor: "rgba(234, 252, 255, 0.95)",
        shadowColor: "transparent",
        lineWidth: 2,
        pointSize: 2,
        roundRect: 0,
        font: '14px "Share Tech Mono", monospace',
        drawBoxes: true,
        drawLabels: false, // labels clutter the frame; the readout panel has the data
        drawPoints: true,
        drawPolygons: false,
        drawGaze: false,
        drawAttention: false,
      };
      await human.draw.face(canvas, res.face, drawOpts);
      await human.draw.body(canvas, res.body, drawOpts);

      // readout
      const out = [];
      out.push(line("", `<span class="tag">SCAN</span>${res.face.length} FACE · ${res.body.length} BODY · ` +
        `${Math.round(res.performance?.total || 0)}MS · ${human.tf.getBackend().toUpperCase()}`));
      res.face.forEach((f, i) => {
        const emo = (f.emotion && f.emotion[0])
          ? `${f.emotion[0].emotion.toUpperCase()} ${pct(f.emotion[0].score)}` : "—";
        const gender = f.gender && f.gender !== "unknown"
          ? `${f.gender.toUpperCase()} ${pct(f.genderScore)}` : "GENDER —";
        const age = f.age ? `AGE ~${Math.round(f.age)}` : "AGE —";
        out.push(line("", `<span class="tag">FACE ${i + 1}</span>${age} · ${gender} · ${emo} · CONF ${pct(f.score)}`));
      });
      res.body.forEach((b, i) => {
        out.push(line("", `<span class="tag">BODY ${i + 1}</span>POSE CONF ${pct(b.score)} · ${b.keypoints.length} KEYPOINTS`));
      });
      const gestures = (res.gesture || []).map((g) => g.gesture).slice(0, 4);
      if (gestures.length) {
        out.push(line("", `<span class="tag">CUES</span>${gestures.join(" · ").toUpperCase()}`));
      }
      if (!res.face.length && !res.body.length) {
        out.push(line("warn", "NO PERSON DETECTED IN FRAME"));
      }
      els.lbAnalysis.innerHTML = out.join("");
    } catch (e) {
      if (token !== this._lbToken) return;
      els.lbAnalysis.innerHTML = line("alert", `ANALYSIS FAILED — ${(e && e.message) || e}`);
    }
  },

  mockGallery() {
    const now = Date.now() / 1000;
    const svg = (label, color) =>
      "data:image/svg+xml;utf8," +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240">` +
          `<rect width="320" height="240" fill="#081a2e"/>` +
          `<circle cx="160" cy="105" r="52" fill="none" stroke="${color}" stroke-width="2" opacity="0.7"/>` +
          `<text x="160" y="215" fill="${color}" font-family="monospace" font-size="15" text-anchor="middle">${label}</text>` +
        `</svg>`
      );
    const reasons = ["wrong_gesture", "keyboard", "mouse", "snap", "wrong_gesture", "keyboard"];
    const colors = { wrong_gesture: "#ff4d5e", keyboard: "#ffc857", mouse: "#ffc857", snap: "#35d6ff" };
    return reasons.map((r, i) => ({
      name: `mock_${i}.jpg`,
      epoch: now - i * 3700,
      reason: r,
      thumb: svg(r.replace("_", " ").toUpperCase(), colors[r]),
    }));
  },

  // The native side scans a deep log tail and hands us the most recent
  // state-changing marker line. Every release path in security_protocol.py
  // logs "[OPEN]", so this classification is exact.
  deriveState(s) {
    const line = typeof s.stateLine === "string" ? s.stateLine : null;
    if (!line) return { mode: "UNKNOWN", ts: "" };
    const ts = (line.match(/^\[(\d{2}:\d{2}:\d{2})\]/) || [])[1] || "";
    let attempts = null;
    if (typeof s.failLine === "string") {
      const m = s.failLine.match(/\[FAIL\] 해제 실패 (\d+)\/(\d+)/);
      if (m) attempts = `${m[1]}/${m[2]}`;
    }
    if (line.includes("입력 차단 활성화")) return { mode: "LOCKDOWN", phase: "SHADE", ts, attempts };
    if (line.includes("[LOCK] UNLOCK 선택")) return { mode: "LOCKDOWN", phase: "AUTH", ts, attempts };
    if (line.includes("[LOCKOUT]")) return { mode: "LOCKDOWN", phase: "LOCKOUT", ts, attempts };
    return { mode: "UNLOCKED", ts };
  },

  translate(line) {
    const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)$/);
    const ts = m ? m[1] : "";
    const body = m ? m[2] : line;

    if (body.includes("제스처 인식:")) {
      const g = body.match(/제스처 인식:\s*\S*\s*(\w+)/);
      return { ts, msg: `GESTURE DETECTED — ${g ? g[1].toUpperCase() : "?"}`, tone: "" };
    }
    if (body.includes("[REMOTE] 명령 수신:")) {
      const c = body.match(/명령 수신:\s*(\w+)/);
      return { ts, msg: `REMOTE COMMAND — ${c ? c[1].toUpperCase() : "?"}`, tone: "warn" };
    }
    for (const e of this.EVENT_MAP) {
      if (e.label && body.includes(e.match)) return { ts, msg: e.msg || e.label, tone: e.tone };
    }
    return { ts, msg: "SYSTEM EVENT", tone: "" };
  },

  setState(tone, text, since) {
    this.els.stateMod.className = `mod mod-state${tone ? " " + tone : ""}`;
    this.els.state.textContent = text;
    this.els.since.textContent = since || "";
  },

  setKv(el, text, tone) {
    el.textContent = text;
    el.className = tone || "";
  },

  fmtDuration(sec) {
    if (!isFinite(sec) || sec < 0) return "—";
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d}D ${h}H ${m}M`;
    if (h > 0) return `${h}H ${m}M`;
    return `${m}M ${Math.floor(sec % 60)}S`;
  },

  fmtBytes(b) {
    if (typeof b !== "number") return "—";
    if (b >= 1 << 30) return (b / (1 << 30)).toFixed(2) + " GB";
    if (b >= 1 << 20) return (b / (1 << 20)).toFixed(1) + " MB";
    return Math.round(b / 1024) + " KB";
  },

  fmtClock(epoch) {
    if (typeof epoch !== "number") return "—";
    const d = new Date(epoch * 1000);
    const pad = (x) => String(x).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  },

  setMeter(barEl, ratio, hot) {
    const segs = barEl.children;
    const on = Math.round(Math.max(0, Math.min(1, ratio)) * segs.length);
    for (let i = 0; i < segs.length; i++) {
      segs[i].className = i < on ? (hot && i >= segs.length * 0.7 ? "on hot" : "on") : "";
    }
  },

  render(s) {
    const state = this.deriveState(s);
    const running = !!s.watcherRunning;
    const els = this.els;
    const pad = (x) => String(x).padStart(2, "0");

    // refresh the gallery whenever the snapshot count changes (and on first sync)
    if (OmniNative.available && s.intruderCount !== this._lastIntruderCount) {
      this._lastIntruderCount = s.intruderCount;
      this.fetchGallery();
    }

    // top strip + sidebar dot
    els.link.textContent = "LINK ACTIVE";
    els.link.className = "ts-item ok";

    // system state module
    if (!running) {
      this.setState("alert", "OFFLINE", "MONITORING PROCESS IS NOT RUNNING");
      els.navDot.className = "nav-dot alert";
    } else if (state.mode === "LOCKDOWN") {
      const bits = [`PHASE ${state.phase}`];
      if (state.ts) bits.push(`SINCE ${state.ts}`);
      this.setState("alert", "LOCKDOWN", bits.join(" · "));
      els.navDot.className = "nav-dot alert";
    } else if (state.mode === "UNLOCKED") {
      this.setState("ok", "UNLOCKED", `MONITORING${state.ts ? " · ARMED SINCE " + state.ts : ""}`);
      els.navDot.className = "nav-dot ok";
    } else {
      this.setState("", "UNKNOWN", "NO STATE MARKERS IN LOG");
      els.navDot.className = "nav-dot off";
    }

    // unlock-fail segments
    const maxAttempts = s.maxUnlockAttempts || 5;
    const failN = state.attempts ? parseInt(state.attempts, 10) : 0;
    els.attempts.innerHTML = "";
    for (let i = 0; i < maxAttempts; i++) {
      const seg = document.createElement("i");
      if (i < failN) seg.className = "on";
      els.attempts.appendChild(seg);
    }
    els.attemptsN.textContent = `${failN}/${maxAttempts}`;

    // watcher module (PAUSED = SIGSTOPped while Omni hand control uses the camera)
    els.wState.textContent = running ? (s.watcherStopped ? "PAUSED" : "RUNNING") : "OFFLINE";
    els.wState.className = `watcher-state ${running ? (s.watcherStopped ? "warn" : "ok") : "alert"}`;
    els.wPid.textContent = running ? s.watcherPid : "—";
    els.wUptime.textContent =
      running && typeof s.watcherSince === "number" ? this.fmtDuration(s.now - s.watcherSince) : "—";
    const cpu = typeof s.watcherCpu === "number" ? s.watcherCpu : null;
    els.wCpu.textContent = cpu !== null ? cpu.toFixed(1) + "%" : "—";
    this.setMeter(els.wCpuBar, cpu !== null ? cpu / 100 : 0, true);
    const mem = typeof s.watcherMemBytes === "number" ? s.watcherMemBytes : null;
    els.wMem.textContent = mem !== null ? this.fmtBytes(mem) : "—";
    this.setMeter(els.wMemBar, mem !== null ? mem / (4 * (1 << 30)) : 0, true);

    // components checklist
    const comps = [
      ["APP BUNDLE", !!s.appBundle, ""],
      ["GESTURE MODEL", !!s.modelPresent, typeof s.modelSizeBytes === "number" ? this.fmtBytes(s.modelSizeBytes) : ""],
      ["CONFIG.LOCAL", !!s.configPresent, ""],
    ];
    els.components.innerHTML = "";
    for (const [name, ok, extra] of comps) {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = extra ? `${name} · ${extra}` : name;
      const st = document.createElement("span");
      st.className = ok ? "st" : "st miss";
      st.textContent = ok ? "OK" : "MISSING";
      li.append(label, st);
      els.components.appendChild(li);
    }

    // autostart
    this.setKv(els.aInstalled, s.autostartInstalled ? "INSTALLED" : "NOT INSTALLED",
      s.autostartInstalled ? "ok" : "dim");
    this.setKv(els.aLoaded, s.agentLoaded ? "YES" : "NO", s.agentLoaded ? "ok" : "dim");
    els.aLabel.textContent = typeof s.agentLabel === "string" ? s.agentLabel : "—";

    // log file
    els.lSize.textContent = this.fmtBytes(s.logSizeBytes);
    els.lMtime.textContent = this.fmtClock(s.logMtime);
    els.lLines.textContent = `${(s.logTail || []).length} LINES`;

    // hex stream — real bytes from the latest log lines
    const hexSrc = (s.logTail || []).slice(-10).join(" ");
    let hex = "";
    for (let i = 0; i < Math.min(hexSrc.length, 220); i++) {
      const h = hexSrc.charCodeAt(i).toString(16).toUpperCase().padStart(2, "0").slice(-2);
      hex += i % 8 === 5 ? `<b>${h}</b> ` : h + " ";
    }
    els.hexstream.innerHTML = hex || "NO DATA";

    // gesture activity from log tail
    const gestures = ["Open_Palm", "Closed_Fist", "Thumb_Up", "Thumb_Down", "Victory", "Pointing_Up", "ILoveYou"];
    const counts = {};
    let total = 0;
    const perMin = {};
    for (const line of s.logTail || []) {
      const g = line.match(/제스처 인식:\s*\S*\s*(\w+)/);
      if (g) {
        counts[g[1]] = (counts[g[1]] || 0) + 1;
        total++;
      }
      const t = line.match(/^\[(\d{2}):(\d{2}):\d{2}\]/);
      if (t) {
        const key = `${t[1]}:${t[2]}`;
        perMin[key] = (perMin[key] || 0) + 1;
      }
    }
    const maxCount = Math.max(1, ...Object.values(counts));
    els.gTotal.textContent = `${total} EVENTS IN BUFFER`;
    els.gRows.innerHTML = "";
    for (const g of gestures) {
      const n = counts[g] || 0;
      const row = document.createElement("div");
      row.className = "gest-row";
      const name = document.createElement("span");
      name.className = "gest-name";
      name.textContent = g.replace("_", " ").toUpperCase();
      const track = document.createElement("div");
      track.className = "gest-track";
      const fill = document.createElement("div");
      fill.className = "gest-fill";
      fill.style.width = `${(n / maxCount) * 100}%`;
      track.appendChild(fill);
      const num = document.createElement("span");
      num.className = "gest-n";
      num.textContent = String(n);
      row.append(name, track, num);
      els.gRows.appendChild(row);
    }

    // events-per-minute sparkline (last 30 minute buckets in the buffer)
    const minutes = Object.keys(perMin).sort();
    const last30 = minutes.slice(-30);
    const sparkMax = Math.max(1, ...last30.map((k) => perMin[k]));
    const bars = els.spark.children;
    for (let i = 0; i < bars.length; i++) {
      const key = last30[last30.length - bars.length + i];
      const v = key ? perMin[key] : 0;
      bars[i].style.height = `${Math.max(5, (v / sparkMax) * 100)}%`;
      bars[i].className = v === sparkMax && v > 0 ? "hi" : "";
    }
    els.sparkNote.textContent = last30.length
      ? `${last30[0]}–${last30[last30.length - 1]}`
      : "";

    // ntfy link
    if (s.ntfyReachable === true) this.setKv(els.nServer, "ONLINE", "ok");
    else if (s.ntfyReachable === false) this.setKv(els.nServer, "UNREACHABLE", "alert");
    else this.setKv(els.nServer, "NOT IN USE", "dim");
    els.nLat.textContent = typeof s.ntfyLatencyMs === "number" ? `${s.ntfyLatencyMs} MS` : "—";
    this.setKv(els.nProvider, (s.notifyProvider || "none").toUpperCase(),
      s.notifyProvider === "none" ? "dim" : "");
    this.setKv(els.nTopic, s.ntfyTopicSet ? "CONFIGURED" : "NOT SET", s.ntfyTopicSet ? "ok" : "dim");

    // remote control
    this.setKv(els.rEnabled, s.remoteEnabled ? "ENABLED" : "DISABLED", s.remoteEnabled ? "ok" : "dim");
    this.setKv(els.rUnlock, s.remoteEnabled ? (s.remoteUnlockAllowed ? "ALLOWED" : "BLOCKED") : "—",
      s.remoteEnabled ? (s.remoteUnlockAllowed ? "ok" : "warn") : "dim");

    // intrusions
    const n = s.intruderCount || 0;
    els.iCount.textContent = String(n);
    els.iCount.className = `big-num${n > 0 ? " alert" : ""}`;
    els.iLast.textContent =
      typeof s.lastIntrusionAt === "number" ? this.fmtClock(s.lastIntrusionAt) : "NONE";

    // cam watch
    els.scanSweep.className = `scan-sweep${running ? "" : " paused"}`;
    els.sModel.textContent = s.modelPresent ? "MEDIAPIPE OK" : "MISSING";

    // event feed (newest first)
    const tail = (s.logTail || []).slice(-16).reverse();
    els.feed.innerHTML = "";
    if (!tail.length) {
      els.feed.innerHTML = '<li class="feed-empty">NO EVENTS LOGGED</li>';
    } else {
      for (const line of tail) {
        const ev = this.translate(line);
        const li = document.createElement("li");
        const ts = document.createElement("span");
        ts.className = "feed-ts";
        ts.textContent = ev.ts || "--:--:--";
        const msg = document.createElement("span");
        msg.className = `feed-msg${ev.tone ? " " + ev.tone : ""}`;
        msg.textContent = ev.msg;
        li.append(ts, msg);
        els.feed.appendChild(li);
      }
    }

    const now = new Date();
    els.sync.textContent = `SYNC ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  },

  renderBridgeOffline() {
    this.setState("warn", "BRIDGE OFFLINE", "OPEN THE OMNI OS MAC APP FOR LIVE STATUS");
    this.els.navDot.className = "nav-dot off";
    this.els.link.textContent = "LINK OFFLINE";
    this.els.link.className = "ts-item alert";
    this.els.sync.textContent = "SYNC —";
  },

  // sample payload for browser development (?mock=1)
  mockPayload() {
    const now = Date.now() / 1000;
    const mkLines = [];
    const gest = ["Open_Palm", "Closed_Fist", "Thumb_Up", "Thumb_Down", "Pointing_Up"];
    for (let i = 60; i > 0; i--) {
      const d = new Date((now - i * 45) * 1000);
      const p = (x) => String(x).padStart(2, "0");
      mkLines.push(
        `[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}] 제스처 인식: · ${gest[i % gest.length]}`
      );
    }
    return {
      now,
      watcherPid: 9385,
      watcherRunning: true,
      watcherSince: now - 4123,
      watcherCpu: 42.1,
      watcherMemBytes: 1250000000,
      stateLine: "[17:37:41] [OPEN] 락다운 해제",
      failLine: null,
      logTail: mkLines,
      logSizeBytes: 52645,
      logMtime: now - 12,
      intruderCount: 0,
      lastIntrusionAt: null,
      autostartInstalled: true,
      agentLabel: "com.geonhee.security-protocol-1",
      agentLoaded: true,
      appBundle: true,
      modelPresent: true,
      modelSizeBytes: 8373440,
      configPresent: true,
      notifyProvider: "ntfy",
      ntfyTopicSet: true,
      remoteEnabled: true,
      remoteUnlockAllowed: true,
      maxUnlockAttempts: 5,
      ntfyReachable: true,
      ntfyLatencyMs: 501,
    };
  },
});

// ---------- module: Render 3D (three.js model viewer) ----------
OmniOS.register("r3d", {
  FORMATS: ["glb", "gltf", "fbx", "obj", "dae", "3mf", "stl", "ply"],
  _three: null,
  _threeLoad: null,
  _ctx: null,
  _model: null,
  _mode: "full",
  _blobUrls: [],
  _lights: null,
  _lightsOn: true,

  init() {
    const $ = (id) => document.getElementById(id);
    this.els = {
      panel: $("panel-r3d"),
      viewport: $("r3d-viewport"),
      drop: $("r3d-drop"),
      input: $("r3d-input"),
      stats: $("r3d-stats"),
      file: $("r3d-file"),
      modes: $("r3d-modes"),
    };
    $("r3d-open").addEventListener("click", () => this.els.input.click());
    $("r3d-load").addEventListener("click", () => this.els.input.click());
    this.els.input.addEventListener("change", () => {
      if (this.els.input.files.length) this.loadFiles([...this.els.input.files]);
      this.els.input.value = "";
    });

    const panel = this.els.panel;
    panel.addEventListener("dragover", (e) => {
      e.preventDefault();
      panel.classList.add("dragging");
    });
    panel.addEventListener("dragleave", (e) => {
      if (e.target === panel) panel.classList.remove("dragging");
    });
    panel.addEventListener("drop", (e) => {
      e.preventDefault();
      panel.classList.remove("dragging");
      if (e.dataTransfer.files.length) this.loadFiles([...e.dataTransfer.files]);
    });

    this.els.modes.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => this.setMode(b.dataset.mode)));

    this.els.lights = $("r3d-lights");
    this.els.lights.addEventListener("click", () => this.toggleLights());

    // hand gesture control
    this.els.hands = $("r3d-hands");
    this.els.handsHud = $("r3d-hands-hud");
    this.els.rhStatus = $("rh-status");
    this.els.rhSp1 = $("rh-sp1");
    this.els.rhPip = $("rh-pip");
    this.els.hands.addEventListener("click", () => this.toggleHands());
    // leaving the panel always stops hand mode (and resumes the SP-1 watcher)
    document.addEventListener("omni:panel", (e) => {
      if (e.detail !== "r3d" && this._hands.on) this.stopHands();
    });

    // lighting sliders: key intensity / ambient intensity / shadow strength
    this.els.lightbar = $("r3d-lightbar");
    this.els.sliders = {
      key: { input: $("r3d-sl-key"), val: $("r3d-sl-key-v"), digits: 1 },
      amb: { input: $("r3d-sl-amb"), val: $("r3d-sl-amb-v"), digits: 2 },
      shadow: { input: $("r3d-sl-shadow"), val: $("r3d-sl-shadow-v"), digits: 2 },
    };
    for (const s of Object.values(this.els.sliders)) {
      s.input.addEventListener("input", () => this.applyLightSettings());
    }
  },

  applyLightSettings() {
    const sl = this.els.sliders;
    const key = parseFloat(sl.key.input.value);
    const amb = parseFloat(sl.amb.input.value);
    const shadow = parseFloat(sl.shadow.input.value);
    sl.key.val.textContent = key.toFixed(sl.key.digits);
    sl.amb.val.textContent = amb.toFixed(sl.amb.digits);
    sl.shadow.val.textContent = shadow.toFixed(sl.shadow.digits);
    if (!this._lights) return;
    this._lights.key.intensity = key;
    this._lights.hemi.intensity = amb;
    this._lights.fill.intensity = amb / 3;
    if ("intensity" in this._lights.key.shadow) {
      this._lights.key.shadow.intensity = shadow; // scales self-shadow darkness
    }
    this._lights.catcher.material.opacity = 0.4 * shadow;
  },

  toggleLights() {
    this._lightsOn = !this._lightsOn;
    this.els.lights.textContent = this._lightsOn ? "LIGHTS ON" : "LIGHTS OFF";
    this.els.lights.classList.toggle("active", this._lightsOn);
    this.applyLights();
  },

  applyLights() {
    if (!this._lights) return; // viewport not built yet; initViewport applies state
    const on = this._lightsOn;
    this._lights.hemi.visible = on;
    this._lights.key.visible = on;
    this._lights.fill.visible = on;
    this._lights.flat.visible = !on;
    this._lights.catcher.visible = on; // no shadows in flat mode
    if (this.els.lightbar) this.els.lightbar.classList.toggle("disabled", !on);
  },

  ensureThree() {
    if (this._threeLoad) return this._threeLoad;
    this._threeLoad = (async () => {
      const THREE = await import("three");
      const [
        { OrbitControls },
        { STLLoader },
        { OBJLoader },
        { MTLLoader },
        { GLTFLoader },
        { FBXLoader },
        { PLYLoader },
        { ThreeMFLoader },
        { ColladaLoader },
      ] = await Promise.all([
        import("./vendor/three/examples/jsm/controls/OrbitControls.js"),
        import("./vendor/three/examples/jsm/loaders/STLLoader.js"),
        import("./vendor/three/examples/jsm/loaders/OBJLoader.js"),
        import("./vendor/three/examples/jsm/loaders/MTLLoader.js"),
        import("./vendor/three/examples/jsm/loaders/GLTFLoader.js"),
        import("./vendor/three/examples/jsm/loaders/FBXLoader.js"),
        import("./vendor/three/examples/jsm/loaders/PLYLoader.js"),
        import("./vendor/three/examples/jsm/loaders/3MFLoader.js"),
        import("./vendor/three/examples/jsm/loaders/ColladaLoader.js"),
      ]);
      this._three = { THREE, OrbitControls, STLLoader, OBJLoader, MTLLoader,
        GLTFLoader, FBXLoader, PLYLoader, ThreeMFLoader, ColladaLoader };
      return this._three;
    })();
    this._threeLoad.catch(() => { this._threeLoad = null; });
    return this._threeLoad;
  },

  initViewport() {
    if (this._ctx) return;
    const { THREE, OrbitControls } = this._three;
    const vp = this.els.viewport;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(vp.clientWidth || 640, vp.clientHeight || 480);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    vp.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      45, (vp.clientWidth || 640) / (vp.clientHeight || 480), 0.01, 5000);
    camera.position.set(4.5, 3.2, 5.5);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    // lit rig (hemisphere + key + fill) vs flat rig (uniform ambient, no shading).
    // Ambient terms stay low so shadowed cavities actually read dark.
    const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x0a1a2a, 0.75);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 3.4);
    key.position.set(5, 10, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -6;
    key.shadow.camera.right = 6;
    key.shadow.camera.top = 6;
    key.shadow.camera.bottom = -6;
    key.shadow.camera.near = 0.1;
    key.shadow.camera.far = 40;
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.02;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x88bbff, 0.25);
    fill.position.set(-6, -3, -5);
    scene.add(fill);
    const flat = new THREE.AmbientLight(0xffffff, 1.5);
    scene.add(flat);

    // invisible ground that only catches the drop shadow (grid is just lines)
    const catcher = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2),
      new THREE.ShadowMaterial({ opacity: 0.4 })
    );
    catcher.receiveShadow = true;
    scene.add(catcher);

    this._lights = { hemi, key, fill, flat, catcher };
    this.applyLights();
    this.applyLightSettings(); // pick up current slider values

    const grid = new THREE.GridHelper(12, 24, 0x35d6ff, 0x123048);
    grid.material.transparent = true;
    grid.material.opacity = 0.35;
    scene.add(grid);

    this._ctx = { renderer, scene, camera, controls };
    new ResizeObserver(() => this.resize()).observe(vp);

    const loop = () => {
      requestAnimationFrame(loop);
      if (!this.els.panel.classList.contains("active")) return;
      controls.update();
      renderer.render(scene, camera);
    };
    loop();
  },

  resize() {
    if (!this._ctx) return;
    const vp = this.els.viewport;
    const w = vp.clientWidth, h = vp.clientHeight;
    if (!w || !h) return;
    this._ctx.camera.aspect = w / h;
    this._ctx.camera.updateProjectionMatrix();
    this._ctx.renderer.setSize(w, h);
  },

  revokeBlobs() {
    for (const u of this._blobUrls) URL.revokeObjectURL(u);
    this._blobUrls = [];
  },

  async loadFiles(files) {
    this.els.stats.textContent = "LOADING…";
    try {
      const t = await this.ensureThree();
      this.initViewport();
      const { THREE } = t;

      const main = files
        .map((f) => ({ f, ext: f.name.split(".").pop().toLowerCase() }))
        .filter((x) => this.FORMATS.includes(x.ext))
        .sort((a, b) => this.FORMATS.indexOf(a.ext) - this.FORMATS.indexOf(b.ext))[0];
      if (!main) throw new Error("unsupported format");

      // companion files (mtl, textures, .bin) resolve through blob URLs by basename
      this.revokeBlobs();
      const urlMap = {};
      for (const f of files) {
        const u = URL.createObjectURL(f);
        this._blobUrls.push(u);
        urlMap[f.name.toLowerCase()] = u;
      }
      const manager = new THREE.LoadingManager();
      manager.setURLModifier((url) => {
        if (url.startsWith("blob:") || url.startsWith("data:")) return url;
        const base = decodeURIComponent(url.split("/").pop().split("?")[0]).toLowerCase();
        return urlMap[base] || url;
      });

      const obj = await this.parseModel(t, main, urlMap[main.f.name.toLowerCase()], files, manager, urlMap);
      this.setModel(obj, main.f.name);
    } catch (e) {
      this.els.stats.textContent =
        `LOAD FAILED — ${String((e && e.message) || e).toUpperCase().slice(0, 60)}`;
    }
  },

  parseModel(t, main, url, files, manager, urlMap) {
    const load = (loader) =>
      new Promise((res, rej) => loader.load(url, res, undefined, rej));
    switch (main.ext) {
      case "stl":
        return load(new t.STLLoader(manager)).then((g) => this.meshFromGeometry(g));
      case "ply":
        return load(new t.PLYLoader(manager)).then((g) => this.meshFromGeometry(g));
      case "obj": {
        const objLoader = new t.OBJLoader(manager);
        const mtlFile = files.find((f) => f.name.toLowerCase().endsWith(".mtl"));
        if (!mtlFile) return load(objLoader);
        return new Promise((res, rej) =>
          new t.MTLLoader(manager).load(urlMap[mtlFile.name.toLowerCase()], res, undefined, rej)
        ).then((mtl) => {
          mtl.preload();
          objLoader.setMaterials(mtl);
          return load(objLoader);
        });
      }
      case "glb":
      case "gltf":
        return load(new t.GLTFLoader(manager)).then((g) => g.scene);
      case "fbx":
        return load(new t.FBXLoader(manager));
      case "3mf":
        return load(new t.ThreeMFLoader(manager));
      case "dae":
        return load(new t.ColladaLoader(manager)).then((d) => d.scene);
    }
  },

  meshFromGeometry(geometry) {
    const { THREE } = this._three;
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    const hasColor = !!geometry.attributes.color;
    const mat = new THREE.MeshStandardMaterial({
      color: hasColor ? 0xffffff : 0x9fb8cc,
      roughness: 0.7,
      metalness: 0.15,
      vertexColors: hasColor,
    });
    return new THREE.Mesh(geometry, mat);
  },

  setModel(obj, name) {
    const { THREE } = this._three;
    const { scene, camera, controls } = this._ctx;
    if (this._model) {
      scene.remove(this._model);
      this.disposeObject(this._model);
    }
    this._model = obj;
    scene.add(obj);

    let meshes = 0, verts = 0, tris = 0;
    obj.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      o.castShadow = true;
      o.receiveShadow = true; // self-shadowing darkens holes and cavities
      o.userData._origMat = o.material;
      const g = o.geometry;
      const n = g.attributes.position ? g.attributes.position.count : 0;
      verts += n;
      tris += Math.round(g.index ? g.index.count / 3 : n / 3);
    });

    // normalize: fit into a ~4 unit box, then wrap in a pivot group whose
    // origin is the model center — hand-gesture rotation spins around it
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    obj.scale.setScalar(4 / maxDim);
    const box2 = new THREE.Box3().setFromObject(obj);
    const center = box2.getCenter(new THREE.Vector3());
    const sizeY = box2.max.y - box2.min.y;
    obj.position.sub(center);
    const pivot = new THREE.Group();
    pivot.add(obj);
    pivot.position.y = sizeY / 2;
    scene.remove(this._model);
    scene.add(pivot);
    this._model = pivot;

    controls.target.set(0, sizeY / 2, 0);
    camera.position.set(4.5, 3.2, 5.5);
    controls.update();

    this.els.drop.hidden = true;
    this.els.file.textContent = name.toUpperCase();
    const fmt = (x) => x >= 1e6 ? (x / 1e6).toFixed(1) + "M" : x >= 1e3 ? (x / 1e3).toFixed(1) + "K" : String(x);
    this.els.stats.textContent =
      `${name.split(".").pop().toUpperCase()} · ${meshes} MESH · ${fmt(verts)} VERTS · ${fmt(tris)} TRIS`;
    this.setMode(this._mode);
  },

  disposeObject(root) {
    root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      for (const key of ["_origMat", "_colorMat", "_textureMat"]) {
        const m = o.userData && o.userData[key];
        if (!m) continue;
        for (const mat of Array.isArray(m) ? m : [m]) {
          if (mat.map) mat.map.dispose && mat.map.dispose();
          mat.dispose && mat.dispose();
        }
      }
    });
    this.revokeBlobs();
  },

  TEX_SLOTS: ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap",
    "emissiveMap", "bumpMap", "alphaMap", "specularMap", "displacementMap", "lightMap"],

  convMaterial(m, mode) {
    const c = m.clone();
    if (mode === "color") {
      for (const s of this.TEX_SLOTS) if (s in c && c[s]) c[s] = null;
    } else if (mode === "texture") {
      if (c.map) {
        if (c.color) c.color.set(0xffffff);
      } else {
        if (c.color) c.color.set(0x8fa8bb);
      }
      c.vertexColors = false;
    }
    c.needsUpdate = true;
    return c;
  },

  setMode(mode) {
    this._mode = mode;
    this.els.modes.querySelectorAll("button").forEach((b) =>
      b.classList.toggle("active", b.dataset.mode === mode));
    if (!this._model) return;
    const { THREE } = this._three;
    if (!this._wireMat) {
      this._wireMat = new THREE.MeshBasicMaterial({
        color: 0x35d6ff,
        wireframe: true,
        transparent: true,
        opacity: 0.75,
      });
    }
    this._model.traverse((o) => {
      if (!o.isMesh) return;
      const orig = o.userData._origMat;
      if (mode === "full") {
        o.material = orig;
      } else if (mode === "wireframe") {
        o.material = this._wireMat;
      } else {
        const key = `_${mode}Mat`;
        if (!o.userData[key]) {
          o.userData[key] = Array.isArray(orig)
            ? orig.map((x) => this.convMaterial(x, mode))
            : this.convMaterial(orig, mode);
        }
        o.material = o.userData[key];
      }
    });
  },

  // ── hand gesture control (vladmandic/human hand tracking) ──
  // While active, the SP-1 gesture watcher is SIGSTOPped via the native bridge
  // so waving at the camera can never trigger a lockdown.
  _hands: { on: false, human: null, load: null, video: null, stream: null,
    busy: false, raf: 0, prev: null, sp1Paused: false },

  HAND_CONNECTIONS: [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],
    [10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]],

  ensureHandHuman() {
    const H = this._hands;
    if (H.load) return H.load;
    H.load = (async () => {
      if (!window.Human) {
        await new Promise((res, rej) => {
          const sc = document.createElement("script");
          sc.src = "vendor/human.js";
          sc.onload = res;
          sc.onerror = () => rej(new Error("human.js failed to load"));
          document.head.appendChild(sc);
        });
      }
      const NS = window.Human;
      const Cls = NS.Human || NS.default || NS;
      H.human = new Cls({
        modelBasePath: "vendor/models/",
        backend: "webgl",
        warmup: "none",
        filter: { enabled: false },
        face: { enabled: false },
        body: { enabled: false },
        object: { enabled: false },
        segmentation: { enabled: false },
        gesture: { enabled: false },
        hand: { enabled: true, maxDetected: 2, minConfidence: 0.5 },
      });
      await H.human.load();
      return H.human;
    })();
    H.load.catch(() => { H.load = null; });
    return H.load;
  },

  async toggleHands() {
    if (this._hands.on) {
      this.stopHands();
      return;
    }
    const H = this._hands;
    this.els.hands.textContent = "HANDS \u2026";
    try {
      // pause SP-1's watcher first — its trigger gesture must not fire while
      // the user waves hands to control the 3D view
      if (OmniNative.available) {
        try {
          const r = await OmniNative.request("sp1.pause");
          H.sp1Paused = !!r.paused;
        } catch (e) {
          H.sp1Paused = false;
        }
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("camera API unavailable");
      }
      H.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" },
        audio: false,
      });
      H.video = document.createElement("video");
      H.video.srcObject = H.stream;
      H.video.muted = true;
      H.video.playsInline = true;
      await H.video.play();
      this.els.handsHud.hidden = false;
      this.els.rhSp1.hidden = !H.sp1Paused;
      this.els.rhStatus.textContent = "LOADING HAND MODELS\u2026";
      await this.ensureHandHuman();
      H.on = true;
      H.prev = null;
      this.els.hands.textContent = "HANDS ON";
      this.els.hands.classList.add("active");
      this.els.rhStatus.textContent = "TRACKING\u2026";
      this.handLoop();
    } catch (e) {
      this.stopHands();
      this.els.stats.textContent =
        `HANDS FAILED \u2014 ${String((e && e.message) || e).toUpperCase().slice(0, 50)}`;
    }
  },

  stopHands() {
    const H = this._hands;
    H.on = false;
    if (H.raf) cancelAnimationFrame(H.raf);
    H.raf = 0;
    if (H.stream) {
      for (const t of H.stream.getTracks()) t.stop();
      H.stream = null;
    }
    H.video = null;
    H.prev = null;
    this.els.handsHud.hidden = true;
    this.els.hands.textContent = "HANDS OFF";
    this.els.hands.classList.remove("active");
    if (H.sp1Paused && OmniNative.available) {
      OmniNative.request("sp1.resume").catch(() => {});
    }
    H.sp1Paused = false;
  },

  handLoop() {
    const H = this._hands;
    const step = async () => {
      if (!H.on) return;
      H.raf = requestAnimationFrame(step);
      if (H.busy || !H.video || H.video.readyState < 2) return;
      H.busy = true;
      try {
        const res = await H.human.detect(H.video);
        if (H.on) this.processHands(res.hand || []);
      } catch (e) {
        /* keep looping */
      }
      H.busy = false;
    };
    step();
  },

  processHands(hands) {
    const H = this._hands;
    const vw = (H.video && H.video.videoWidth) || 640;
    const vh = (H.video && H.video.videoHeight) || 480;

    const parsed = hands.slice(0, 2).map((h) => {
      const kp = h.keypoints || [];
      if (kp.length < 21) return null;
      const d = (a, b) => Math.hypot(kp[a][0] - kp[b][0], kp[a][1] - kp[b][1]);
      const ref = Math.max(1, d(0, 9)); // wrist -> middle knuckle = hand scale
      const pinch = d(4, 8) / ref < 0.4; // thumb tip near index tip
      const px = 1 - (kp[4][0] + kp[8][0]) / 2 / vw; // mirrored for natural motion
      const py = (kp[4][1] + kp[8][1]) / 2 / vh;
      return { kp, pinch, px, py };
    }).filter(Boolean);

    const pinches = parsed.filter((p) => p.pinch);
    const prev = H.prev;
    let status = parsed.length ? `${parsed.length} HAND${parsed.length > 1 ? "S" : ""} \u00b7 PINCH TO GRAB` : "SHOW HANDS";

    if (pinches.length === 2) {
      const [a, b] = pinches;
      const dist = Math.hypot(a.px - b.px, a.py - b.py);
      const cx = (a.px + b.px) / 2;
      const cy = (a.py + b.py) / 2;
      if (prev && prev.type === "two") {
        const zoomF = dist > 0.01 ? prev.dist / dist : 1;
        this.zoomBy(Math.max(0.85, Math.min(1.18, zoomF)));
        this.panBy(cx - prev.cx, cy - prev.cy);
      }
      H.prev = { type: "two", dist, cx, cy };
      status = "ZOOM / PAN";
    } else if (pinches.length === 1) {
      const p = pinches[0];
      if (prev && prev.type === "one") {
        const dx = p.px - prev.x;
        const dy = p.py - prev.y;
        if (this._model) {
          this._model.rotation.y += dx * 5;
          this._model.rotation.x += dy * 3;
        }
      }
      H.prev = { type: "one", x: p.px, y: p.py };
      status = "ROTATE";
    } else {
      H.prev = null;
    }

    this.els.rhStatus.textContent = status;
    this.drawPip(parsed, vw, vh);
  },

  zoomBy(f) {
    if (!this._ctx) return;
    const { camera, controls } = this._ctx;
    const v = camera.position.clone().sub(controls.target).multiplyScalar(f);
    const len = v.length();
    if (len < 1.2) v.setLength(1.2);
    if (len > 60) v.setLength(60);
    camera.position.copy(controls.target).add(v);
  },

  panBy(dx, dy) {
    if (!this._ctx) return;
    const { THREE } = this._three;
    const { camera, controls } = this._ctx;
    const k = camera.position.distanceTo(controls.target) * 1.2;
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const up = new THREE.Vector3(0, 1, 0);
    const right = forward.clone().cross(up).normalize();
    const offset = right.multiplyScalar(-dx * k).addScaledVector(up, dy * k);
    controls.target.add(offset);
    camera.position.add(offset);
  },

  drawPip(parsed, vw, vh) {
    const c = this.els.rhPip;
    const ctx = c.getContext("2d");
    const w = c.width;
    const h = c.height;
    ctx.clearRect(0, 0, w, h);
    const video = this._hands.video;
    if (video && video.readyState >= 2) {
      ctx.save();
      ctx.scale(-1, 1);
      ctx.drawImage(video, -w, 0, w, h);
      ctx.restore();
      ctx.fillStyle = "rgba(2, 8, 19, 0.4)";
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.fillStyle = "#020813";
      ctx.fillRect(0, 0, w, h);
    }
    const sx = w / vw;
    const sy = h / vh;
    for (const p of parsed) {
      const pt = (i) => [w - p.kp[i][0] * sx, p.kp[i][1] * sy];
      ctx.strokeStyle = p.pinch ? "rgba(61, 255, 168, 0.9)" : "rgba(53, 214, 255, 0.8)";
      ctx.lineWidth = 1;
      for (const [a, b] of this.HAND_CONNECTIONS) {
        const [x1, y1] = pt(a);
        const [x2, y2] = pt(b);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.fillStyle = p.pinch ? "#3dffa8" : "#35d6ff";
      for (let i = 0; i < 21; i++) {
        const [x, y] = pt(i);
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
      }
    }
  },
});
