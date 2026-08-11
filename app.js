// OMNI_OS core
// Future apps get integrated by registering themselves as modules here.
const OmniOS = {
  version: "0.14.0",
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
    { match: "더블 클랩 감지", label: "DOUBLE CLAP — LOCKDOWN TRIGGER", tone: "warn" },
    { match: "클랩 1/2 감지", label: "CLAP 1/2 DETECTED", tone: "" },
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

  _visible: false,

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
      start: $("sp1-start"),
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
    this.els.start.addEventListener("click", () => this.startWatcher());
    this.els.lightbox.addEventListener("click", () => {
      this._lbToken++; // cancels any in-flight analysis render
      this.els.lightbox.hidden = true;
      this.els.lbImg.src = "";
      this.els.lbCanvas.width = 0;
      this.els.lbAnalysis.innerHTML = "";
    });
    this.buildBars();
    this.refresh();
    // full-rate polling only while the panel is on screen; in the background
    // it drops to 1/6 rate so the status shell (sidebar dot) stays fresh
    // without spawning ps/launchctl every 5s
    document.addEventListener("omni:panel", (e) => {
      this._visible = e.detail === "sp1";
      if (this._visible) this.refresh();
    });
    let tick = 0;
    setInterval(() => {
      tick++;
      if (this._visible || tick % 6 === 0) this.refresh();
    }, this.POLL_MS);
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

  // Panel START button: bring the watcher up (launchctl bootstrap or app
  // bundle) and poll until the panel reflects the running state.
  async startWatcher() {
    if (!OmniNative.available) return;
    const btn = this.els.start;
    btn.disabled = true;
    btn.textContent = "STARTING…";
    try {
      await OmniNative.request("sp1.start", null, 20000);
      for (let i = 0; i < 8; i++) {
        await new Promise((res) => setTimeout(res, 1000));
        const s = await OmniNative.request("sp1.status");
        this.render(s);
        if (s.watcherRunning) break;
      }
    } catch (e) {
      /* next 5s poll shows the real state */
    }
    btn.disabled = false;
    btn.textContent = "▷ START WATCHER";
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
    const handPause = !!(OmniOS.modules.r3d && OmniOS.modules.r3d._hands &&
      OmniOS.modules.r3d._hands.sp1Paused);
    els.start.hidden = true; // unhidden only when genuinely offline below
    if (!running) {
      if (handPause) {
        this.setState("warn", "PAUSED", "WATCHER SUSPENDED FOR HAND CONTROL");
        els.navDot.className = "nav-dot off";
      } else {
        this.setState("alert", "OFFLINE", "MONITORING PROCESS IS NOT RUNNING");
        els.navDot.className = "nav-dot alert";
        els.start.hidden = !OmniNative.available;
      }
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

    // watcher module (PAUSED = stopped while Omni hand control uses the camera)
    els.wState.textContent = running
      ? (s.watcherStopped ? "PAUSED" : "RUNNING")
      : (handPause ? "PAUSED" : "OFFLINE");
    els.wState.className = `watcher-state ${running
      ? (s.watcherStopped ? "warn" : "ok")
      : (handPause ? "warn" : "alert")}`;
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
    this.els.start.hidden = true;
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
  FORMATS: ["glb", "gltf", "fbx", "obj", "dae", "3mf", "step", "stp", "iges", "igs", "brep", "stl", "ply"],
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
      tabs: $("r3d-tabs"),
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
    this.els.rhVideo = $("rh-video");
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

    // trackpad pinch (spread = explode, squeeze = reassemble).
    // WebKit delivers GestureEvents; Chromium delivers ctrl+wheel.
    const canvas = renderer.domElement;
    const activeParts = () => {
      const ws = this._workspaces[this._activeWs];
      return ws && ws.parts ? ws : null;
    };
    if (typeof window.GestureEvent !== "undefined") {
      canvas.addEventListener("gesturestart", (e) => {
        const ws = activeParts();
        if (!ws) return;
        e.preventDefault();
        this._pinchBase = { scale: e.scale, explode: ws.explode };
      }, { passive: false });
      canvas.addEventListener("gesturechange", (e) => {
        const ws = activeParts();
        if (!ws || !this._pinchBase) return;
        e.preventDefault();
        this.setExplode(this._pinchBase.explode + (e.scale - this._pinchBase.scale) * 1.4);
        this.els.stats.textContent = `EXPLODE ${Math.round(ws.explode * 100)}%`;
      }, { passive: false });
      canvas.addEventListener("gestureend", (e) => {
        e.preventDefault();
        this._pinchBase = null;
        const ws = activeParts();
        if (ws) this.els.stats.textContent = ws.statsText;
      }, { passive: false });
    } else {
      canvas.addEventListener("wheel", (e) => {
        if (!e.ctrlKey) return; // plain scroll stays with orbit zoom
        const ws = activeParts();
        if (!ws) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.setExplode(ws.explode - e.deltaY * 0.012);
        this.els.stats.textContent = `EXPLODE ${Math.round(ws.explode * 100)}%`;
      }, { capture: true, passive: false });
    }

    this._ctx = { renderer, scene, camera, controls };
    new ResizeObserver(() => this.resize()).observe(vp);

    let lastT = performance.now();
    const loop = () => {
      requestAnimationFrame(loop);
      if (!this.els.panel.classList.contains("active")) return;
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;
      this.tickAssembleAnim(now);
      // explode momentum: a hard two-fist yank coasts the explode to its end
      if (this._explodeVel) {
        const ws = this._workspaces[this._activeWs];
        if (ws && ws.parts) {
          let f = ws.explode + this._explodeVel * dt;
          this._explodeVel *= Math.exp(-dt / 0.9);
          if (f >= 1.6) { f = 1.6; this._explodeVel = 0; }
          if (f <= 0) { f = 0; this._explodeVel = 0; }
          if (Math.abs(this._explodeVel) < 0.05) this._explodeVel = 0;
          this.setExplode(f);
          this.els.stats.textContent = this._explodeVel
            ? `EXPLODE ${Math.round(ws.explode * 100)}%`
            : ws.statsText;
        } else {
          this._explodeVel = 0;
        }
      }
      // flick momentum: keeps spinning after a fast pinch release, with decay
      if (this._spin && this._model) {
        this._model.rotation.y += this._spin.y * dt;
        this._model.rotation.x += this._spin.x * dt;
        const decay = Math.exp(-dt / 0.6);
        this._spin.y *= decay;
        this._spin.x *= decay;
        if (Math.hypot(this._spin.x, this._spin.y) < 0.04) this._spin = null;
      }
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
    this.els.stats.textContent = "LOADING\u2026";
    try {
      const t = await this.ensureThree();
      this.initViewport();
      const { THREE } = t;

      const extOf = (n) => n.split(".").pop().toLowerCase();
      const models = files
        .filter((f) => this.FORMATS.includes(extOf(f.name)))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      if (!models.length) throw new Error("unsupported format");

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

      const raws = [];
      for (const f of models) {
        this.els.stats.textContent = `LOADING ${f.name.toUpperCase()}\u2026`;
        const obj = await this.parseModel(t, f, extOf(f.name), urlMap, files, manager);
        raws.push({ obj, name: f.name });
      }

      if (raws.length === 1) {
        this.addWorkspace(raws[0].obj, raws[0].name, true);
      } else {
        // one workspace per part, plus an ASSEMBLY workspace that keeps every
        // part in its native coordinates — parts exported in a shared frame
        // (CAD assemblies, split print models) snap together automatically
        const asm = new THREE.Group();
        raws.forEach((r, i) => {
          const clone = r.obj.clone(true);
          this.colorizePart(clone, i);
          asm.add(clone);
        });
        raws.forEach((r) => this.addWorkspace(r.obj, r.name, false));
        this.addWorkspace(asm, `ASSEMBLY (${raws.length})`, true);
      }
    } catch (e) {
      this.els.stats.textContent =
        `LOAD FAILED \u2014 ${String((e && e.message) || e).toUpperCase().slice(0, 60)}`;
    }
  },

  parseModel(t, file, ext, urlMap, files, manager) {
    const url = urlMap[file.name.toLowerCase()];
    const load = (loader) =>
      new Promise((res, rej) => loader.load(url, res, undefined, rej));
    switch (ext) {
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
      case "step":
      case "stp":
      case "iges":
      case "igs":
      case "brep":
        return this.parseCad(t, file, ext);
    }
  },

  // ── CAD formats (STEP/IGES/BREP) via OpenCascade WASM ──
  ensureOcct() {
    if (this._occtLoad) return this._occtLoad;
    this._occtLoad = (async () => {
      if (!window.occtimportjs) {
        await new Promise((res, rej) => {
          const sc = document.createElement("script");
          sc.src = "vendor/occt/occt-import-js.js";
          sc.onload = res;
          sc.onerror = () => rej(new Error("occt-import-js failed to load"));
          document.head.appendChild(sc);
        });
      }
      this._occt = await window.occtimportjs({
        locateFile: () => "vendor/occt/occt-import-js.wasm",
      });
      return this._occt;
    })();
    this._occtLoad.catch(() => { this._occtLoad = null; });
    return this._occtLoad;
  },

  async parseCad(t, file, ext) {
    const { THREE } = t;
    const occt = await this.ensureOcct();
    const buf = new Uint8Array(await file.arrayBuffer());
    const fn = ext === "iges" || ext === "igs" ? "ReadIgesFile"
      : ext === "brep" ? "ReadBrepFile" : "ReadStepFile";
    const res = occt[fn](buf, null);
    if (!res || !res.success || !res.meshes || !res.meshes.length) {
      throw new Error("CAD parse failed");
    }
    // meshes arrive with assembly transforms already applied
    const group = new THREE.Group();
    for (const m of res.meshes) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position",
        new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
      if (m.attributes.normal) {
        geo.setAttribute("normal",
          new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
      } else {
        geo.computeVertexNormals();
      }
      if (m.index) geo.setIndex(new THREE.Uint32BufferAttribute(m.index.array, 1));
      const hasColor = Array.isArray(m.color);
      const mat = new THREE.MeshStandardMaterial({
        color: hasColor ? new THREE.Color(m.color[0], m.color[1], m.color[2]) : 0x9fb8cc,
        roughness: 0.65,
        metalness: 0.2,
      });
      if (!hasColor) mat.userData.autoDefault = true;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = m.name || "";
      group.add(mesh);
    }
    return group;
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
    if (!hasColor) mat.userData.autoDefault = true;
    return new THREE.Mesh(geometry, mat);
  },

  // distinct colors for untextured parts inside an assembly view
  PART_PALETTE: [0x35d6ff, 0xffc857, 0x3dffa8, 0xff7ab8, 0x8f9dff, 0xffa15e,
    0x7de8d8, 0xd0ff6e, 0xc79bff, 0xff9d9d],

  colorizePart(obj, i) {
    const { THREE } = this._three;
    let mat = null;
    obj.traverse((o) => {
      if (!o.isMesh) return;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      if (!ms.every((m) => m && m.userData && m.userData.autoDefault)) return;
      if (!mat) {
        mat = new THREE.MeshStandardMaterial({
          color: this.PART_PALETTE[i % this.PART_PALETTE.length],
          roughness: 0.7,
          metalness: 0.15,
        });
      }
      o.material = mat;
    });
  },

  // ── workspaces: every load becomes a named tab ──
  _workspaces: [],
  _activeWs: -1,
  _wsSeq: 0,

  addWorkspace(obj, name, activate) {
    const { THREE } = this._three;

    let meshes = 0, verts = 0, tris = 0;
    obj.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      o.castShadow = true;
      o.receiveShadow = true; // self-shadowing darkens holes and cavities
      o.userData._origMat = o.material;
      const g = o.geometry;
      g.userData._refs = (g.userData._refs || 0) + 1; // shared with assembly clones
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m && m.userData) m.userData._refs = (m.userData._refs || 0) + 1;
      }
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

    // explode vectors: for multi-part groups, each top-level part gets a
    // direction pointing away from the assembly center (drives the assemble
    // intro animation and the explode gestures)
    let parts = null;
    if ((obj.isGroup || obj.type === "Group") && obj.children.length > 1) {
      pivot.updateWorldMatrix(true, true);
      const whole = new THREE.Box3().setFromObject(pivot);
      const centerW = whole.getCenter(new THREE.Vector3());
      const s = obj.getWorldScale(new THREE.Vector3()).x || 1;
      parts = obj.children.map((node) => {
        const c = new THREE.Box3().setFromObject(node).getCenter(new THREE.Vector3());
        return {
          node,
          base: node.position.clone(),
          dir: c.clone().sub(centerW).divideScalar(s),
          y: c.y,
        };
      });
    }

    const fmt = (x) => x >= 1e6 ? (x / 1e6).toFixed(1) + "M" : x >= 1e3 ? (x / 1e3).toFixed(1) + "K" : String(x);
    const ext = name.includes(".") ? name.split(".").pop().toUpperCase() : "GROUP";
    const ws = {
      id: ++this._wsSeq,
      name,
      group: pivot,
      midY: sizeY / 2,
      mode: "full",
      cam: null,
      parts,
      introOrder: parts ? parts.slice().sort((a, b) => a.y - b.y) : null,
      explode: 0,
      introPlayed: false,
      anim: null,
      statsText: `${ext} \u00b7 ${meshes} MESH \u00b7 ${fmt(verts)} VERTS \u00b7 ${fmt(tris)} TRIS`
        + (parts ? ` \u00b7 ${parts.length} PARTS` : ""),
    };
    this._workspaces.push(ws);
    if (activate || this._activeWs < 0) {
      this.switchWorkspace(this._workspaces.length - 1);
    } else {
      this.renderTabs();
    }
  },

  switchWorkspace(i) {
    const { scene, camera, controls } = this._ctx;
    const cur = this._workspaces[this._activeWs];
    if (cur) {
      scene.remove(cur.group);
      cur.cam = { pos: camera.position.clone(), target: controls.target.clone() };
    }
    this._activeWs = i;
    const ws = this._workspaces[i];
    this._model = ws ? ws.group : null;
    this._spin = null;
    if (ws) {
      scene.add(ws.group);
      if (ws.cam) {
        camera.position.copy(ws.cam.pos);
        controls.target.copy(ws.cam.target);
      } else {
        camera.position.set(4.5, 3.2, 5.5);
        controls.target.set(0, ws.midY, 0);
      }
      controls.update();
      this.els.drop.hidden = true;
      this.els.file.textContent = ws.name.toUpperCase();
      this.els.stats.textContent = ws.statsText;
      this.setMode(ws.mode);
      if (ws.parts && !ws.introPlayed) this.playAssembleIntro(ws);
    } else {
      this.els.drop.hidden = false;
      this.els.file.textContent = "\u2014";
      this.els.stats.textContent = "NO MODEL";
    }
    this.renderTabs();
  },

  closeWorkspace(i) {
    const ws = this._workspaces[i];
    if (!ws) return;
    const wasActive = i === this._activeWs;
    if (wasActive) this._ctx.scene.remove(ws.group);
    this._workspaces.splice(i, 1);
    this.disposeObject(ws.group);
    if (this._activeWs > i) this._activeWs--;
    if (wasActive) {
      this._activeWs = -1;
      this.switchWorkspace(Math.min(i, this._workspaces.length - 1));
    } else {
      this.renderTabs();
    }
  },

  renderTabs() {
    const bar = this.els.tabs;
    bar.hidden = this._workspaces.length === 0;
    bar.innerHTML = "";
    this._workspaces.forEach((ws, i) => {
      const tab = document.createElement("div");
      tab.className = `r3d-tab${i === this._activeWs ? " active" : ""}`;
      const label = document.createElement("span");
      label.className = "r3d-tab-label";
      label.textContent = ws.name.toUpperCase();
      const x = document.createElement("span");
      x.className = "r3d-tab-x";
      x.textContent = "\u2715";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeWorkspace(i);
      });
      tab.append(label, x);
      tab.addEventListener("click", () => this.switchWorkspace(i));
      bar.appendChild(tab);
    });
  },

  // ── explode / assemble ──
  setExplode(f) {
    const ws = this._workspaces[this._activeWs];
    if (!ws || !ws.parts) return;
    ws.anim = null; // gestures cancel the intro animation
    ws.explode = Math.max(0, Math.min(1.6, f));
    for (const p of ws.parts) {
      p.node.position.copy(p.base).addScaledVector(p.dir, ws.explode);
    }
  },

  playAssembleIntro(ws) {
    ws.introPlayed = true;
    ws.anim = { t0: performance.now() };
    // start fully exploded so there is no assembled flash before the first tick
    for (const p of ws.parts) {
      p.node.position.copy(p.base).addScaledVector(p.dir, 1.1);
    }
  },

  // called every render frame; parts fly in one by one, bottom-up
  tickAssembleAnim(now) {
    const ws = this._workspaces[this._activeWs];
    if (!ws || !ws.anim || !ws.parts) return;
    const t = (now - ws.anim.t0) / 1000 - 0.25; // brief hold before the first part
    let done = true;
    ws.introOrder.forEach((p, i) => {
      const lt = (t - i * 0.28) / 0.6;
      const cl = Math.max(0, Math.min(1, lt));
      if (cl < 1) done = false;
      const ease = 1 - Math.pow(1 - cl, 3);
      p.node.position.copy(p.base).addScaledVector(p.dir, (1 - ease) * 1.1);
    });
    if (done) {
      ws.anim = null;
      ws.explode = 0;
    }
  },

  disposeObject(root) {
    root.traverse((o) => {
      if (o.geometry) {
        const refs = (o.geometry.userData._refs || 1) - 1;
        o.geometry.userData._refs = refs;
        if (refs <= 0) o.geometry.dispose();
      }
      if (!o.userData) return;
      const orig = o.userData._origMat;
      for (const mat of Array.isArray(orig) ? orig : orig ? [orig] : []) {
        const refs = ((mat.userData && mat.userData._refs) || 1) - 1;
        if (mat.userData) mat.userData._refs = refs;
        if (refs <= 0) {
          if (mat.map && mat.map.dispose) mat.map.dispose();
          mat.dispose && mat.dispose();
        }
      }
      // per-workspace mode clones are never shared — dispose material only
      // (their texture maps are shared with the original)
      for (const key of ["_colorMat", "_textureMat"]) {
        const m = o.userData[key];
        for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
          mat.dispose && mat.dispose();
        }
      }
    });
  },

  TEX_SLOTS: ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap",
    "emissiveMap", "bumpMap", "alphaMap", "specularMap", "displacementMap", "lightMap"],

  convMaterial(m, mode) {
    const c = m.clone();
    c.userData = {}; // clone JSON-copies refcounts/flags — clones own none of that
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
    const ws = this._workspaces[this._activeWs];
    if (ws) ws.mode = mode;
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

  // MediaPipe Tasks HandLandmarker — purpose-built video hand tracker
  // (GPU delegate + temporal tracking), far smoother than a per-frame detector.
  ensureTracker() {
    const H = this._hands;
    if (H.load) return H.load;
    H.load = (async () => {
      const mp = await import("./vendor/mediapipe/vision_bundle.js");
      const fileset = await mp.FilesetResolver.forVisionTasks("vendor/mediapipe/wasm");
      const make = (delegate) =>
        mp.HandLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: "vendor/mediapipe/hand_landmarker.task",
            delegate,
          },
          runningMode: "VIDEO",
          numHands: 2,
          minHandDetectionConfidence: 0.4,
          minHandPresenceConfidence: 0.4,
          minTrackingConfidence: 0.4,
        });
      try {
        H.tracker = await make("GPU");
      } catch (e) {
        H.tracker = await make("CPU");
      }
      return H.tracker;
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
      await this.acquireCamera();
      this.els.handsHud.hidden = false;
      this.els.rhSp1.hidden = !H.sp1Paused;
      this.els.rhStatus.textContent = "LOADING HAND TRACKER\u2026";
      await this.ensureTracker();
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
    if (this.els.rhVideo) this.els.rhVideo.srcObject = null;
    H.video = null;
    H.prev = null;
    H.smooth = null;
    H.handState = null;
    H.display = null;
    H.targetHands = null;
    H.axisLock = null;
    this.els.handsHud.hidden = true;
    this.els.hands.textContent = "HANDS OFF";
    this.els.hands.classList.remove("active");
    if (H.sp1Paused && OmniNative.available) {
      OmniNative.request("sp1.resume").catch(() => {});
    }
    H.sp1Paused = false;
  },

  // getUserMedia into the in-DOM PIP <video> (WebKit suspends playback of
  // off-DOM/unrendered videos after ~1s — the element must stay visible),
  // with auto-reconnect when the track dies or gets muted by the system.
  async acquireCamera() {
    const H = this._hands;
    H.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
    for (const t of H.stream.getTracks()) {
      t.addEventListener("ended", () => {
        if (H.on) this.restartCamera();
      });
      t.addEventListener("mute", () => {
        if (!H.on) return;
        this.els.rhStatus.textContent = "CAMERA MUTED — RECOVERING…";
        setTimeout(() => {
          if (H.on && t.muted) this.restartCamera();
        }, 2000);
      });
      t.addEventListener("unmute", () => {
        if (H.on) this.els.rhStatus.textContent = "TRACKING…";
      });
    }
    H.video = this.els.rhVideo;
    H.video.srcObject = H.stream;
    await H.video.play();
  },

  async restartCamera() {
    const H = this._hands;
    this.els.rhStatus.textContent = "CAMERA LOST — RECONNECTING…";
    try {
      if (H.stream) for (const t of H.stream.getTracks()) t.stop();
      await this.acquireCamera();
      this.els.rhStatus.textContent = "TRACKING…";
    } catch (e) {
      this.stopHands();
      this.els.stats.textContent = "HANDS FAILED — CAMERA LOST";
    }
  },

  handLoop() {
    const H = this._hands;
    H.failCount = 0;
    H.lastDetectAt = 0;
    H.lastVideoTime = -1;
    const step = async () => {
      if (!H.on) return;
      H.raf = requestAnimationFrame(step);
      // PIP skeleton interpolates toward the latest result every frame (60fps),
      // decoupled from inference — motion stays fluid
      this.drawPip();
      if (H.busy || !H.video || H.video.readyState < 2 || !H.tracker) return;
      const now = performance.now();
      if (now - H.lastDetectAt < 33) return; // inference at ~30fps
      if (H.video.currentTime === H.lastVideoTime) return; // no new frame yet
      H.lastDetectAt = now;
      H.lastVideoTime = H.video.currentTime;
      H.busy = true;
      try {
        const res = H.tracker.detectForVideo(H.video, now);
        H.failCount = 0;
        if (H.on) this.processHands(res);
      } catch (e) {
        // tracker crashed — rebuild it in place
        H.failCount++;
        if (H.failCount >= 3 && H.on) {
          this.els.rhStatus.textContent = "TRACKER STALLED — RESTARTING…";
          H.failCount = 0;
          H.tracker = null;
          H.load = null;
          try {
            await this.ensureTracker();
            if (H.on) this.els.rhStatus.textContent = "TRACKING…";
          } catch (e2) {
            this.stopHands();
            this.els.stats.textContent = "HANDS FAILED — TRACKER CRASHED";
            return;
          }
        }
      }
      H.busy = false;
    };
    step();
  },

  processHands(result) {
    const H = this._hands;
    const now = performance.now();
    const dt = Math.max(0.008, Math.min(0.1, (now - (H.lastProcessAt || now - 33)) / 1000));
    H.lastProcessAt = now;

    const lms = result.landmarks || [];
    const handed = result.handedness || result.handednesses || [];

    // exponential smoothing per hand (keyed by handedness so left/right keep
    // their own filter state between frames)
    H.smooth = H.smooth || {};
    const seen = new Set();
    const parsed = lms.slice(0, 2).map((lm, i) => {
      if (!lm || lm.length < 21) return null;
      const label = handed[i] && handed[i][0] ? handed[i][0].categoryName : `H${i}`;
      seen.add(label);
      let s = H.smooth[label];
      if (!s) s = H.smooth[label] = { pts: lm.map((p) => ({ x: p.x, y: p.y })) };
      const a = 0.55;
      for (let k = 0; k < 21; k++) {
        s.pts[k].x += (lm[k].x - s.pts[k].x) * a;
        s.pts[k].y += (lm[k].y - s.pts[k].y) * a;
      }
      const P = s.pts;
      // 4:3 aspect weighting so pinch distance is isotropic in screen space
      const d = (m, n) => Math.hypot((P[m].x - P[n].x) * 4, (P[m].y - P[n].y) * 3);
      const ref = Math.max(0.001, d(0, 9)); // wrist -> middle knuckle
      // fist: all four fingertips curled back toward the wrist
      const curl = (d(8, 0) + d(12, 0) + d(16, 0) + d(20, 0)) / 4 / ref;
      const fist = curl < 1.3;
      const pinch = !fist && d(4, 8) / ref < 0.38;
      const px = 1 - (P[4].x + P[8].x) / 2; // mirrored for natural motion
      const py = (P[4].y + P[8].y) / 2;
      // palm center (for fist tracking)
      const cx = 1 - (P[0].x + P[5].x + P[9].x + P[13].x + P[17].x) / 5;
      const cy = (P[0].y + P[5].y + P[9].y + P[13].y + P[17].y) / 5;
      return { label, pts: P, pinch, fist, px, py, cx, cy };
    }).filter(Boolean);
    for (const k of Object.keys(H.smooth)) if (!seen.has(k)) delete H.smooth[k];

    // per-hand pinch lifecycle: velocity (for flick momentum) + stroke arming
    // (for axis lock: pinch a straight bottom\u2192up stroke and HOLD \u2192 Y-axis lock,
    //  left\u2192right stroke and HOLD \u2192 X-axis lock; other hand then rotates)
    H.handState = H.handState || {};
    for (const p of parsed) {
      let hs = H.handState[p.label];
      if (!hs) hs = H.handState[p.label] = {};
      if (p.pinch && !hs.pinching) {
        hs.pinching = true;
        hs.start = { x: p.px, y: p.py };
        hs.vel = { x: 0, y: 0 };
        hs.stroke = null;
        hs.heading = null; // circle-gesture tracking (Z-axis lock)
        hs.turn = 0;
        hs.circle = false;
        hs.stillFrames = 0;
        this._spin = null; // grabbing stops any residual spin
      } else if (p.pinch && hs.pinching) {
        const dx = p.px - (hs.px !== undefined ? hs.px : p.px);
        const dy = p.py - (hs.py !== undefined ? hs.py : p.py);
        hs.vel.x += (dx / dt - hs.vel.x) * 0.35;
        hs.vel.y += (dy / dt - hs.vel.y) * 0.35;
        if (Math.abs(dx) + Math.abs(dy) > 0.004) hs.lastMoveAt = now;
        // circle gesture: consistent heading rotation past ~300\u00b0, then hold
        // still while pinched \u2192 Z-axis lock (tracked before the stroke check
        // so a curving path can never mis-arm the straight-stroke locks)
        if (Math.hypot(dx, dy) > 0.003) {
          const h = Math.atan2(dy, dx);
          if (hs.heading !== null) {
            let dh = h - hs.heading;
            while (dh > Math.PI) dh -= 2 * Math.PI;
            while (dh < -Math.PI) dh += 2 * Math.PI;
            if (hs.turn !== 0 && Math.sign(dh) !== Math.sign(hs.turn) && Math.abs(dh) > 0.15) {
              hs.turn = dh; // direction reversed \u2014 restart the sweep
            } else {
              hs.turn += dh;
            }
          }
          hs.heading = h;
          hs.stillFrames = 0;
          if (Math.abs(hs.turn) > 5.2) hs.circle = true;
        } else if (hs.pinching) {
          hs.stillFrames++;
          if (hs.circle && !hs.stroke && !H.axisLock && hs.stillFrames >= 4) {
            hs.stroke = "z";
            H.axisLock = { axis: "z", hand: p.label };
          }
        }
        // straight-stroke locks only when the path hasn't been curving
        if (!hs.stroke && !H.axisLock && Math.abs(hs.turn) < 1.5) {
          const sx = p.px - hs.start.x;
          const sy = p.py - hs.start.y;
          if (sy < -0.22 && Math.abs(sy) > 2.2 * Math.abs(sx)) hs.stroke = "y"; // bottom\u2192up
          else if (sx > 0.22 && Math.abs(sx) > 2.2 * Math.abs(sy)) hs.stroke = "x"; // left\u2192right
          if (hs.stroke) H.axisLock = { axis: hs.stroke, hand: p.label };
        }
      } else if (!p.pinch && hs.pinching) {
        hs.pinching = false;
        this.onPinchRelease(hs);
      }
      hs.px = p.px;
      hs.py = p.py;
    }
    for (const [label, hs] of Object.entries(H.handState)) {
      if (!seen.has(label)) {
        // hand flew out of frame while pinching \u2192 same as a flick release
        if (hs.pinching) {
          hs.pinching = false;
          this.onPinchRelease(hs);
        }
        delete H.handState[label];
      }
    }
    if (H.axisLock) {
      const hs = H.handState[H.axisLock.hand];
      if (!hs || !hs.pinching) H.axisLock = null; // lock hand let go
    }

    const pinches = parsed.filter((p) => p.pinch);
    const fists = parsed.filter((p) => p.fist);
    const prev = H.prev;
    let status = parsed.length
      ? `${parsed.length} HAND${parsed.length > 1 ? "S" : ""} \u00b7 PINCH TO GRAB`
      : "SHOW HANDS";
    const ws = this._workspaces[this._activeWs];

    // fists just released after a hard yank \u2192 explode coasts to the end
    if (prev && prev.type === "fists" && fists.length < 2) {
      if (Math.abs(H.explodeVel || 0) > 0.6) {
        this._explodeVel = Math.max(-3.5, Math.min(3.5, H.explodeVel));
      }
      H.explodeVel = 0;
    }

    if (fists.length === 2 && ws && ws.parts) {
      // both fists: pull apart to explode the assembly, bring together to rebuild
      const [a, b] = fists;
      const dist = Math.hypot(a.cx - b.cx, a.cy - b.cy);
      if (prev && prev.type === "fists") {
        const dd = (dist - prev.dist) * 2.4;
        this.setExplode(ws.explode + dd);
        H.explodeVel = (H.explodeVel || 0) + (dd / dt - (H.explodeVel || 0)) * 0.4;
      } else {
        H.explodeVel = 0;
        this._explodeVel = 0; // fresh grab stops any coasting
      }
      H.prev = { type: "fists", dist };
      status = `EXPLODE ${Math.round(ws.explode * 100)}%`;
      this.els.stats.textContent = ws.statsText;
    } else if (H.axisLock) {
      const other = pinches.find((p) => p.label !== H.axisLock.hand);
      status = `${H.axisLock.axis.toUpperCase()}-AXIS LOCK` +
        (other ? "" : " \u00b7 PINCH OTHER HAND");
      if (other) {
        if (prev && prev.type === "axis" && prev.label === other.label) {
          const dx = other.px - prev.x;
          const dy = other.py - prev.y;
          if (this._model) {
            if (H.axisLock.axis === "y") this._model.rotation.y += dx * 5;
            else if (H.axisLock.axis === "x") this._model.rotation.x += dy * 4;
            else this._model.rotation.z += dx * 4;
          }
        }
        H.prev = { type: "axis", label: other.label, x: other.px, y: other.py };
      } else {
        H.prev = null;
      }
    } else if (pinches.length === 2) {
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
      if (prev && prev.type === "one" && prev.label === p.label) {
        const dx = p.px - prev.x;
        const dy = p.py - prev.y;
        if (this._model) {
          this._model.rotation.y += dx * 5;
          this._model.rotation.x += dy * 3;
        }
      }
      H.prev = { type: "one", label: p.label, x: p.px, y: p.py };
      status = "ROTATE";
    } else {
      H.prev = null;
    }

    this.els.rhStatus.textContent = status;
    H.targetHands = parsed; // drawPip interpolates toward these
  },

  // flick release \u2192 the model keeps spinning with decay (cinematic);
  // a still-hand release leaves it exactly where you put it \u2014 momentum only
  // fires when the hand was actually moving within 150ms of letting go
  onPinchRelease(hs) {
    const vx = (hs.vel && hs.vel.x) || 0;
    const vy = (hs.vel && hs.vel.y) || 0;
    const speed = Math.hypot(vx, vy);
    const moving = hs.lastMoveAt && performance.now() - hs.lastMoveAt < 150;
    if (speed > 0.9 && moving && this._model) {
      const clamp = (v, m) => Math.max(-m, Math.min(m, v));
      this._spin = { y: clamp(vx * 5, 7), x: clamp(vy * 3, 5) };
    }
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

  // skeleton overlay only — the live video renders underneath as a real
  // <video> element (mirrored via CSS). Runs every rAF and interpolates the
  // displayed skeleton toward the latest tracker result, so it glides at
  // 60fps even though inference runs at ~30fps.
  drawPip() {
    const H = this._hands;
    const c = this.els.rhPip;
    const ctx = c.getContext("2d");
    const w = c.width;
    const h = c.height;
    ctx.clearRect(0, 0, w, h);

    const targets = H.targetHands || [];
    H.display = H.display || {};
    const seen = new Set();
    for (const t of targets) {
      seen.add(t.label);
      let d = H.display[t.label];
      if (!d) d = H.display[t.label] = { pts: t.pts.map((p) => ({ x: p.x, y: p.y })) };
      const a = 0.45;
      for (let i = 0; i < 21; i++) {
        d.pts[i].x += (t.pts[i].x - d.pts[i].x) * a;
        d.pts[i].y += (t.pts[i].y - d.pts[i].y) * a;
      }
      d.pinch = t.pinch;
    }
    for (const k of Object.keys(H.display)) if (!seen.has(k)) delete H.display[k];

    for (const d of Object.values(H.display)) {
      const pt = (i) => [(1 - d.pts[i].x) * w, d.pts[i].y * h];
      ctx.strokeStyle = d.pinch ? "rgba(61, 255, 168, 0.9)" : "rgba(53, 214, 255, 0.8)";
      ctx.lineWidth = 1.2;
      for (const [a, b] of this.HAND_CONNECTIONS) {
        const [x1, y1] = pt(a);
        const [x2, y2] = pt(b);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.fillStyle = d.pinch ? "#3dffa8" : "#35d6ff";
      for (let i = 0; i < 21; i++) {
        const [x, y] = pt(i);
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
      }
    }
  },
});

// ---------- module: ARC-SCAN (rotating ToF lidar point cloud) ----------
// ESP32 streams {"a": servoAngle 0-180, "d": [7 distances mm]} over ws://ip:81.
// Sensor channels 0(top)..6(bottom) are tilted +30..-30 deg on the mast.
// In the app the socket is relayed natively (plain ws:// is mixed content for
// the omni:// secure origin); in a browser it falls back to a JS WebSocket.
OmniOS.register("arc", {
  TILTS: [30, 20, 10, 0, -10, -20, -30],
  CH_HEIGHTS: [0.19, 0.16, 0.14, 0.11, 0.09, 0.06, 0.03], // sensor z on mast (m)
  MAX_POINTS: 300000,
  MIN_MM: 40,
  MAX_MM: 4000,

  _enabled: false,
  _linked: false,
  _ws: null,
  _three: null,
  _ctx: null,
  _count: 0,
  _writeIdx: 0,
  _msgCount: 0,
  _lastRateAt: 0,
  _rate: 0,

  init() {
    const $ = (id) => document.getElementById(id);
    this.els = {
      panel: $("panel-arc"),
      viewport: $("arc-viewport"),
      status: $("arc-status"),
      stats: $("arc-stats"),
      side: $("arc-side"),
      hint: $("arc-hint"),
      ip: $("arc-ip"),
      connect: $("arc-connect"),
      clear: $("arc-clear"),
      size: $("arc-size"),
      navDot: $("arc-nav-dot"),
    };
    this.els.ip.value = localStorage.getItem("arc-ip") || "";
    this.els.connect.addEventListener("click", () => this.toggle());
    this.els.ip.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.toggle();
    });
    this.els.clear.addEventListener("click", () => this.clearCloud());
    this.els.size.addEventListener("input", () => {
      if (this._ctx) this._ctx.material.size = parseFloat(this.els.size.value) / 100;
    });
    this.buildSide();

    // native relay pushes messages/states here
    window.OmniArc = {
      _msg: (m) => this.onMessage(m),
      _state: (s) => {
        if (s === "closed") this.onClosed();
      },
    };
  },

  buildSide() {
    const side = this.els.side;
    side.innerHTML = "";
    this._chEls = [];
    for (let i = 0; i < 7; i++) {
      const row = document.createElement("div");
      row.className = "arc-ch";
      const name = document.createElement("span");
      name.textContent = `CH${i}`;
      const tilt = document.createElement("span");
      tilt.textContent = `${this.TILTS[i] > 0 ? "+" : ""}${this.TILTS[i]}\u00b0`;
      const bar = document.createElement("div");
      bar.className = "arc-bar";
      const fill = document.createElement("i");
      fill.style.width = "0%";
      bar.appendChild(fill);
      const val = document.createElement("span");
      val.className = "val";
      val.textContent = "\u2014";
      row.append(name, tilt, bar, val);
      side.appendChild(row);
      this._chEls.push({ fill, val });
    }
    const az = document.createElement("div");
    az.className = "arc-az";
    az.textContent = "AZIMUTH \u2014";
    side.appendChild(az);
    this._azEl = az;
    side.hidden = true;
  },

  async ensureThree() {
    if (this._three) return this._three;
    const THREE = await import("three");
    const { OrbitControls } = await import("./vendor/three/examples/jsm/controls/OrbitControls.js");
    this._three = { THREE, OrbitControls };
    return this._three;
  },

  async initViewport() {
    if (this._ctx) return;
    const { THREE, OrbitControls } = await this.ensureThree();
    const vp = this.els.viewport;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(vp.clientWidth || 640, vp.clientHeight || 480);
    vp.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      55, (vp.clientWidth || 640) / (vp.clientHeight || 480), 0.01, 200);
    camera.position.set(-3.4, 2.6, 3.8);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0.8, 0);

    const grid = new THREE.GridHelper(8, 16, 0x35d6ff, 0x123048);
    grid.material.transparent = true;
    grid.material.opacity = 0.3;
    scene.add(grid);

    // scanner mast marker at the origin
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.05, 0.24, 12),
      new THREE.MeshBasicMaterial({ color: 0x35d6ff })
    );
    mast.position.y = 0.12;
    scene.add(mast);

    // live azimuth sweep indicator
    const azGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0.02, 0),
      new THREE.Vector3(4, 0.02, 0),
    ]);
    const azLine = new THREE.Line(azGeo,
      new THREE.LineBasicMaterial({ color: 0x35d6ff, transparent: true, opacity: 0.4 }));
    scene.add(azLine);

    // point cloud (preallocated ring buffer)
    const positions = new Float32Array(this.MAX_POINTS * 3);
    const colors = new Float32Array(this.MAX_POINTS * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setDrawRange(0, 0);
    const material = new THREE.PointsMaterial({
      size: parseFloat(this.els.size.value) / 100,
      vertexColors: true,
      sizeAttenuation: true,
    });
    const cloud = new THREE.Points(geo, material);
    cloud.frustumCulled = false;
    scene.add(cloud);

    this._ctx = { renderer, scene, camera, controls, geo, positions, colors, material, azLine };
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
    const w = vp.clientWidth;
    const h = vp.clientHeight;
    if (!w || !h) return;
    this._ctx.camera.aspect = w / h;
    this._ctx.camera.updateProjectionMatrix();
    this._ctx.renderer.setSize(w, h);
  },

  wsUrl() {
    let addr = this.els.ip.value.trim();
    if (!addr) return null;
    if (!addr.includes(":")) addr += ":81";
    return `ws://${addr}`;
  },

  async toggle() {
    if (this._enabled) {
      this.disconnect("DISCONNECTED");
      return;
    }
    const url = this.wsUrl();
    if (!url) return;
    localStorage.setItem("arc-ip", this.els.ip.value.trim());
    await this.initViewport();
    this._enabled = true;
    this.els.connect.textContent = "DISCONNECT";
    this.openSocket(url);
  },

  async openSocket(url) {
    this.setStatus("CONNECTING\u2026", "");
    if (OmniNative.available) {
      try {
        await OmniNative.request("arc.connect", url);
      } catch (e) {
        this.onClosed();
      }
      return; // link confirmed by the first pushed message
    }
    // browser fallback: plain JS WebSocket
    try {
      this._ws = new WebSocket(url);
      this._ws.onmessage = (e) => {
        try {
          this.onMessage(JSON.parse(e.data));
        } catch (_) {}
      };
      this._ws.onclose = () => this.onClosed();
      this._ws.onerror = () => {};
    } catch (e) {
      this.onClosed();
    }
  },

  disconnect(label) {
    this._enabled = false;
    this._linked = false;
    if (this._retry) clearTimeout(this._retry);
    if (OmniNative.available) OmniNative.request("arc.disconnect").catch(() => {});
    if (this._ws) {
      try { this._ws.close(); } catch (_) {}
      this._ws = null;
    }
    this.els.connect.textContent = "CONNECT";
    this.setStatus(label || "DISCONNECTED", "");
    this.els.navDot.className = "nav-dot off";
    this.els.side.hidden = true;
    this.els.hint.hidden = false;
  },

  onClosed() {
    if (!this._enabled) return;
    this._linked = false;
    this.setStatus("LINK LOST \u2014 RETRYING\u2026", "alert");
    this.els.navDot.className = "nav-dot alert";
    if (this._retry) clearTimeout(this._retry);
    this._retry = setTimeout(() => {
      if (this._enabled) this.openSocket(this.wsUrl());
    }, 3000);
  },

  setStatus(text, tone) {
    this.els.status.textContent = text;
    this.els.status.className = `ts-item${tone ? " " + tone : ""}`;
  },

  onMessage(msg) {
    if (!this._enabled || !msg || !Array.isArray(msg.d)) return;
    if (!this._linked) {
      this._linked = true;
      this.setStatus("LINKED \u00b7 STREAMING", "ok");
      this.els.navDot.className = "nav-dot ok";
      this.els.hint.hidden = true;
      this.els.side.hidden = false;
    }
    const a = typeof msg.a === "number" ? msg.a : 0;
    for (let ch = 0; ch < Math.min(7, msg.d.length); ch++) {
      const mm = msg.d[ch];
      this.updateChannel(ch, mm);
      if (typeof mm === "number" && mm >= this.MIN_MM && mm <= this.MAX_MM) {
        this.addPoint(a, ch, mm);
      }
    }
    if (this._azEl) this._azEl.textContent = `AZIMUTH ${a}\u00b0`;
    if (this._ctx) this._ctx.azLine.rotation.y = (a * Math.PI) / 180;

    this._msgCount++;
    const now = performance.now();
    if (now - this._lastRateAt > 1000) {
      this._rate = this._msgCount;
      this._msgCount = 0;
      this._lastRateAt = now;
    }
    this.els.stats.textContent =
      `${this._count.toLocaleString()} PTS \u00b7 ${this._rate}/S`;
  },

  updateChannel(ch, mm) {
    const el = this._chEls && this._chEls[ch];
    if (!el) return;
    const valid = typeof mm === "number" && mm >= this.MIN_MM && mm <= this.MAX_MM;
    el.val.textContent = valid ? `${mm}` : "\u2014";
    el.fill.style.width = valid ? `${Math.min(100, (mm / this.MAX_MM) * 100)}%` : "0%";
  },

  addPoint(aDeg, ch, mm) {
    const c = this._ctx;
    if (!c) return;
    const th = (this.TILTS[ch] * Math.PI) / 180;   // elevation
    const ph = (aDeg * Math.PI) / 180;             // azimuth
    const r = mm / 1000;
    const horiz = r * Math.cos(th);
    const x = horiz * Math.cos(ph);
    const z = -horiz * Math.sin(ph);
    const y = r * Math.sin(th) + this.CH_HEIGHTS[ch];

    const i = this._writeIdx;
    c.positions[i * 3] = x;
    c.positions[i * 3 + 1] = y;
    c.positions[i * 3 + 2] = z;

    // color by height: deep blue (floor) -> cyan -> near-white (ceiling)
    const t = Math.max(0, Math.min(1, y / 2.4));
    let cr, cg, cb;
    if (t < 0.5) {
      const k = t / 0.5;
      cr = 0.04 + (0.21 - 0.04) * k;
      cg = 0.29 + (0.84 - 0.29) * k;
      cb = 0.43 + (1.0 - 0.43) * k;
    } else {
      const k = (t - 0.5) / 0.5;
      cr = 0.21 + (0.92 - 0.21) * k;
      cg = 0.84 + (0.99 - 0.84) * k;
      cb = 1.0;
    }
    c.colors[i * 3] = cr;
    c.colors[i * 3 + 1] = cg;
    c.colors[i * 3 + 2] = cb;

    this._writeIdx = (this._writeIdx + 1) % this.MAX_POINTS;
    this._count = Math.min(this._count + 1, this.MAX_POINTS);
    c.geo.attributes.position.needsUpdate = true;
    c.geo.attributes.color.needsUpdate = true;
    c.geo.setDrawRange(0, this._count);
  },

  clearCloud() {
    this._count = 0;
    this._writeIdx = 0;
    if (this._ctx) this._ctx.geo.setDrawRange(0, 0);
    this.els.stats.textContent = "0 PTS";
  },
});

// ---------- module: Arduino IDE (arduino-cli + serial monitor/plotter) ----------
// Backend is the arduino-cli bundled with Arduino IDE.app, driven through the
// native bridge: streamed job output, sketchbook listing, a POSIX serial port.
OmniOS.register("ide", {
  FQBN_CHIPS: {
    ESP32: "esp32:esp32:esp32",
    UNO: "arduino:avr:uno",
    NANO: "arduino:avr:nano",
    MEGA: "arduino:avr:mega",
  },
  MAX_LOG: 2500,

  _sketch: null,
  _running: false,
  _monOpen: false,
  _serialBuf: "",
  _series: {},
  _plotColors: ["#35d6ff", "#ffc857", "#3dffa8", "#ff7ab8", "#8f9dff", "#ffa15e"],

  init() {
    const $ = (id) => document.getElementById(id);
    this.els = {
      panel: $("panel-ino"),
      cli: $("ino-cli"),
      job: $("ino-job"),
      sketches: $("ino-sketches"),
      sketchNote: $("ino-sketch-note"),
      open: $("ino-open"),
      port: $("ino-port"),
      refresh: $("ino-refresh"),
      fqbn: $("ino-fqbn"),
      fqbnList: $("ino-fqbn-list"),
      chips: $("ino-fqbn-chips"),
      libQ: $("ino-lib-q"),
      libSearch: $("ino-lib-search"),
      libResults: $("ino-lib-results"),
      libInstalled: $("ino-lib-installed"),
      libCount: $("ino-lib-count"),
      fileTabs: $("ino-filetabs"),
      editor: $("ino-editor"),
      editorEmpty: $("ino-editor-empty"),
      save: $("ino-save"),
      saveNote: $("ino-save-note"),
      verify: $("ino-verify"),
      upload: $("ino-upload"),
      stop: $("ino-stop"),
      file: $("ino-file"),
      tabs: $("ino-tabs"),
      out: $("ino-out"),
      mon: $("ino-mon"),
      monToggle: $("ino-mon-toggle"),
      baud: $("ino-baud"),
      send: $("ino-send"),
      sendBtn: $("ino-send-btn"),
      plot: $("ino-plot"),
      legend: $("ino-legend"),
      views: {
        code: $("ino-view-code"),
        out: $("ino-view-out"),
        mon: $("ino-view-mon"),
        plot: $("ino-view-plot"),
      },
    };

    this.els.fqbn.value = localStorage.getItem("ino-fqbn") || "";
    this.els.fqbn.addEventListener("change", () =>
      localStorage.setItem("ino-fqbn", this.els.fqbn.value.trim()));
    // live board search: type a board name (e.g. "s3", "uno") to pick its FQBN
    this.els.fqbn.addEventListener("input", () => this.suggestBoards());
    this.els.fqbn.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.els.fqbnList.innerHTML = "";
    });
    this.els.chips.querySelectorAll(".chip").forEach((c) =>
      c.addEventListener("click", () => {
        this.els.fqbn.value = this.FQBN_CHIPS[c.textContent] || "";
        localStorage.setItem("ino-fqbn", this.els.fqbn.value);
      }));

    this.els.tabs.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => this.showTab(b.dataset.tab)));
    this.els.verify.addEventListener("click", () => this.verify());
    this.els.upload.addEventListener("click", () => this.upload());
    this.els.stop.addEventListener("click", () =>
      OmniNative.request("arduino.cancel").catch(() => {}));
    this.els.open.addEventListener("click", () => this.pickSketch());
    this.els.refresh.addEventListener("click", () => this.refreshPorts());
    this.els.libSearch.addEventListener("click", () => this.libSearch());
    this.els.libQ.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.libSearch();
    });
    this.els.save.addEventListener("click", () => this.saveCurrent());
    this.els.monToggle.addEventListener("click", () => this.toggleMonitor());
    this.els.sendBtn.addEventListener("click", () => this.serialSend());
    this.els.send.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.serialSend();
    });

    // native push endpoints
    window.OmniArduino = {
      _out: (line, isErr) => this.onJobLine(line, isErr),
      _done: (code) => this.onJobDone(code),
      _serial: (b64) => this.onSerialChunk(b64),
      _serialClosed: () => this.onSerialClosed(),
    };

    if (!OmniNative.available) {
      this.els.cli.textContent = "CLI \u2014 APP ONLY";
      this.log(this.els.out, "ARDUINO TOOLCHAIN REQUIRES THE OMNI OS MAC APP", "sys");
      return;
    }
    // querying the toolchain spawns arduino-cli several times — only do it
    // once the user actually opens this panel
    document.addEventListener("omni:panel", (e) => {
      if (e.detail === "ino" && !this._booted) {
        this._booted = true;
        this.bootstrap();
      }
    });
  },

  async bootstrap() {
    try {
      const env = await OmniNative.request("arduino.env");
      if (!env.cli) {
        this.els.cli.textContent = "CLI MISSING";
        this.els.cli.className = "ts-item alert";
        this.log(this.els.out, "arduino-cli not found \u2014 install Arduino IDE or brew install arduino-cli", "err");
        return;
      }
      this.els.cli.textContent = "CLI READY";
      this.els.cli.className = "ts-item ok";
      const s = await OmniNative.request("arduino.sketches");
      this.renderSketches(s.sketches || []);
      await this.refreshPorts();
      await this.libInstalled();
      this.loadBoards(); // biggest query — let it finish in the background
    } catch (e) {
      this.els.cli.textContent = "CLI ERROR";
      this.els.cli.className = "ts-item alert";
    }
  },

  // ── logging / tabs ──

  log(el, text, cls) {
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = text;
    el.appendChild(line);
    while (el.childNodes.length > this.MAX_LOG) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  },

  showTab(name) {
    this.els.tabs.querySelectorAll("button").forEach((b) =>
      b.classList.toggle("active", b.dataset.tab === name));
    for (const [k, v] of Object.entries(this.els.views)) v.hidden = k !== name;
    if (name === "plot") this.resizePlot();
    if (name === "code" && this._cm) this._cm.refresh();
  },

  setJob(text, tone) {
    this.els.job.textContent = text;
    this.els.job.className = `ts-item${tone ? " " + tone : ""}`;
  },

  // ── cli jobs ──

  async runStream(args, label) {
    if (this._running) return false;
    this._running = true;
    this.els.stop.hidden = false;
    this.setJob(label, "warn");
    this.log(this.els.out, `$ arduino-cli ${args.join(" ")}`, "sys");
    try {
      const r = await OmniNative.request("arduino.run",
        JSON.stringify({ args }), 15000);
      if (!r.ok) throw new Error("busy or cli missing");
      return true;
    } catch (e) {
      this._running = false;
      this.els.stop.hidden = true;
      this.setJob("IDLE", "");
      this.log(this.els.out, `failed to start: ${e.message}`, "err");
      return false;
    }
  },

  onJobLine(line, isErr) {
    this.log(this.els.out, line, isErr ? "err" : "");
  },

  onJobDone(code) {
    this._running = false;
    this.els.stop.hidden = true;
    this.setJob(code === 0 ? "DONE" : `EXIT ${code}`, code === 0 ? "ok" : "alert");
    this.log(this.els.out, code === 0 ? "\u2713 success" : `\u2717 exited with code ${code}`,
      code === 0 ? "okl" : "err");
    if (this._reopenAfterJob) {
      this._reopenAfterJob = false;
      this.toggleMonitor();
    }
  },

  // ── sketch selection ──

  renderSketches(list) {
    const box = this.els.sketches;
    box.innerHTML = "";
    this.els.sketchNote.textContent = `${list.length} IN SKETCHBOOK`;
    for (const s of list) {
      const it = document.createElement("div");
      it.className = "ino-item";
      it.textContent = s.name;
      it.title = s.path;
      it.addEventListener("click", () => this.selectSketch(s.path, s.name, it));
      box.appendChild(it);
    }
  },

  selectSketch(path, name, el) {
    this._sketch = path;
    this.els.file.textContent = name.toUpperCase();
    this.els.sketches.querySelectorAll(".ino-item").forEach((x) =>
      x.classList.toggle("active", x === el));
    this.openCode(path);
  },

  async pickSketch() {
    try {
      const r = await OmniNative.request("arduino.pickSketch", null, 120000);
      if (!r.path) return;
      let p = r.path;
      if (p.endsWith(".ino")) p = p.slice(0, p.lastIndexOf("/"));
      this.selectSketch(p, p.split("/").pop(), null);
    } catch (e) {}
  },

  // ── code editor ──
  _cm: null,
  _files: [],       // [{name, doc, dirty}]
  _fileIdx: -1,

  ensureEditor() {
    if (this._cm) return this._cm;
    if (typeof window.CodeMirror === "undefined") return null; // scripts still loading
    this._cm = window.CodeMirror(this.els.editor, {
      mode: "text/x-c++src",
      lineNumbers: true,
      indentUnit: 2,
      tabSize: 2,
      styleActiveLine: false,
      extraKeys: {
        "Cmd-S": () => this.saveCurrent(),
        "Ctrl-S": () => this.saveCurrent(),
      },
    });
    this._cm.on("change", () => {
      const f = this._files[this._fileIdx];
      if (f && !f.dirty) {
        f.dirty = true;
        this.renderFileTabs();
      }
    });
    return this._cm;
  },

  async openCode(path) {
    if (!OmniNative.available) return;
    this.showTab("code");
    try {
      const r = await OmniNative.request("arduino.readSketch",
        JSON.stringify({ dir: path }), 15000);
      if (!r.ok) throw new Error(r.error || "read failed");
      const cm = this.ensureEditor();
      if (!cm) return;
      this.els.editorEmpty.hidden = true;
      this._files = (r.files || []).map((f) => ({
        name: f.name,
        doc: window.CodeMirror.Doc(f.content, "text/x-c++src"),
        dirty: false,
      }));
      this._fileIdx = -1;
      this.renderFileTabs();
      if (this._files.length) this.showFile(0);
      else this.els.editorEmpty.hidden = false;
    } catch (e) {
      this.log(this.els.out, `open failed: ${e.message}`, "err");
    }
  },

  showFile(i) {
    const cm = this.ensureEditor();
    const f = this._files[i];
    if (!cm || !f) return;
    this._fileIdx = i;
    cm.swapDoc(f.doc);
    cm.refresh();
    cm.focus();
    this.renderFileTabs();
  },

  renderFileTabs() {
    const bar = this.els.fileTabs;
    bar.innerHTML = "";
    this._files.forEach((f, i) => {
      const t = document.createElement("div");
      t.className = `ino-ftab${i === this._fileIdx ? " active" : ""}`;
      t.textContent = f.name;
      if (f.dirty) {
        const d = document.createElement("span");
        d.className = "dirty";
        d.textContent = "\u25cf";
        t.appendChild(d);
      }
      t.addEventListener("click", () => this.showFile(i));
      bar.appendChild(t);
    });
  },

  async saveFile(i) {
    const f = this._files[i];
    if (!f || !f.dirty) return true;
    try {
      const r = await OmniNative.request("arduino.writeFile",
        JSON.stringify({ name: f.name, content: f.doc.getValue() }), 15000);
      if (!r.ok) throw new Error(r.error || "write failed");
      f.dirty = false;
      this.renderFileTabs();
      return true;
    } catch (e) {
      this.log(this.els.out, `save ${f.name} failed: ${e.message}`, "err");
      this.els.saveNote.textContent = `SAVE FAILED \u2014 ${e.message}`.toUpperCase();
      return false;
    }
  },

  async saveCurrent() {
    if (this._fileIdx >= 0 && await this.saveFile(this._fileIdx)) {
      this.els.saveNote.textContent =
        `SAVED ${this._files[this._fileIdx].name.toUpperCase()}`;
    }
  },

  async saveAllDirty() {
    for (let i = 0; i < this._files.length; i++) {
      if (this._files[i].dirty && !(await this.saveFile(i))) return false;
    }
    return true;
  },

  // ── build / upload ──

  async verify() {
    const fqbn = this.els.fqbn.value.trim();
    if (!this._sketch) return this.log(this.els.out, "select a sketch first", "err");
    if (!fqbn) return this.log(this.els.out, "set an FQBN (board) first", "err");
    if (!(await this.saveAllDirty())) return;
    this.showTab("out");
    this.runStream(["compile", "--fqbn", fqbn, this._sketch], "COMPILING\u2026");
  },

  async upload() {
    const fqbn = this.els.fqbn.value.trim();
    const port = this.els.port.value;
    if (!this._sketch) return this.log(this.els.out, "select a sketch first", "err");
    if (!fqbn) return this.log(this.els.out, "set an FQBN (board) first", "err");
    if (!port) return this.log(this.els.out, "no port selected \u2014 refresh ports", "err");
    if (!(await this.saveAllDirty())) return;
    this.showTab("out");
    if (this._monOpen) {
      // the port can't be shared with the uploader
      this._reopenAfterJob = true;
      this.toggleMonitor();
    }
    this.runStream(["compile", "--fqbn", fqbn, "-p", port, "-u", this._sketch],
      "UPLOADING\u2026");
  },

  // ── boards / ports ──

  async refreshPorts() {
    try {
      const r = await OmniNative.request("arduino.ports", null, 30000);
      const ports = r.ports || [];
      const sel = this.els.port;
      const prev = localStorage.getItem("ino-port") || sel.value;
      sel.innerHTML = "";
      for (const p of ports) {
        const addr = p.address;
        if (!addr || addr.includes("Bluetooth") || addr.includes("debug-console")) continue;
        const opt = document.createElement("option");
        opt.value = addr;
        opt.textContent = p.board
          ? `${addr.replace("/dev/cu.", "")} \u00b7 ${p.board}`
          : addr.replace("/dev/cu.", "");
        if (p.fqbn && !this.els.fqbn.value) this.els.fqbn.value = p.fqbn;
        sel.appendChild(opt);
      }
      if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
      sel.onchange = () => localStorage.setItem("ino-port", sel.value);
      if (!sel.options.length) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "no boards found";
        sel.appendChild(opt);
      }
    } catch (e) {
      this.log(this.els.out, `port scan failed: ${e.message}`, "err");
    }
  },

  // full board catalog from the installed cores (for FQBN search)
  async loadBoards() {
    try {
      const r = await OmniNative.request("arduino.boards", null, 60000);
      this._boards = r.boards || [];
    } catch (e) {
      this._boards = [];
    }
  },

  suggestBoards() {
    const q = this.els.fqbn.value.trim().toLowerCase();
    const box = this.els.fqbnList;
    box.innerHTML = "";
    if (!q || q.length < 2 || !this._boards || !this._boards.length) return;
    if (q.split(":").length >= 3) return; // already a full FQBN — don't nag
    const hits = this._boards.filter((b) =>
      (b.name || "").toLowerCase().includes(q) ||
      (b.fqbn || "").toLowerCase().includes(q)).slice(0, 10);
    for (const b of hits) {
      const it = document.createElement("div");
      it.className = "ino-item";
      const name = document.createElement("span");
      name.textContent = b.name;
      const f = document.createElement("span");
      f.className = "sub";
      f.textContent = b.fqbn;
      it.append(name, f);
      it.addEventListener("click", () => {
        this.els.fqbn.value = b.fqbn;
        localStorage.setItem("ino-fqbn", b.fqbn);
        box.innerHTML = "";
      });
      box.appendChild(it);
    }
  },

  // ── libraries ──

  async libSearch() {
    const q = this.els.libQ.value.trim();
    if (!q) return;
    this.els.libResults.innerHTML = '<div class="ino-item">searching\u2026</div>';
    try {
      const r = await OmniNative.request("arduino.libSearch",
        JSON.stringify({ q }), 40000);
      const libs = r.libs || [];
      const box = this.els.libResults;
      box.innerHTML = "";
      if (!libs.length) box.innerHTML = '<div class="ino-item">no results</div>';
      for (const lib of libs.slice(0, 12)) {
        const it = document.createElement("div");
        it.className = "ino-item";
        it.title = lib.sentence || "";
        const name = document.createElement("span");
        name.textContent = lib.name;
        const ver = document.createElement("span");
        ver.className = "sub";
        ver.textContent = lib.version || "";
        it.append(name, ver);
        it.addEventListener("click", () => this.libInstall(lib.name));
        box.appendChild(it);
      }
    } catch (e) {
      this.els.libResults.innerHTML = '<div class="ino-item">search failed</div>';
    }
  },

  libInstall(name) {
    this.showTab("out");
    this.runStream(["lib", "install", name], "INSTALLING LIB\u2026").then((ok) => {
      if (ok) {
        const iv = setInterval(() => {
          if (!this._running) {
            clearInterval(iv);
            this.libInstalled();
          }
        }, 500);
      }
    });
  },

  async libInstalled() {
    try {
      const r = await OmniNative.request("arduino.libList", null, 30000);
      const libs = r.libs || [];
      const box = this.els.libInstalled;
      box.innerHTML = "";
      this.els.libCount.textContent = String(libs.length);
      for (const lib of libs.slice(0, 40)) {
        const it = document.createElement("div");
        it.className = "ino-item";
        const name = document.createElement("span");
        name.textContent = lib.name || "?";
        const ver = document.createElement("span");
        ver.className = "sub";
        ver.textContent = lib.version || "";
        it.append(name, ver);
        box.appendChild(it);
      }
    } catch (e) {}
  },

  // ── serial monitor / plotter ──

  async toggleMonitor() {
    if (this._monOpen) {
      OmniNative.request("arduino.serialClose").catch(() => {});
      this.onSerialClosed();
      return;
    }
    const port = this.els.port.value;
    if (!port) return this.log(this.els.mon, "no port selected", "err");
    const baud = parseInt(this.els.baud.value, 10) || 115200;
    try {
      const r = await OmniNative.request("arduino.serialOpen",
        JSON.stringify({ port, baud }));
      if (!r.ok) throw new Error(r.error || "open failed");
      this._monOpen = true;
      this._serialBuf = "";
      this._series = {};
      this.els.monToggle.textContent = "CLOSE";
      this.els.monToggle.classList.add("active");
      this.log(this.els.mon, `\u25cf ${port} @ ${baud}`, "okl");
    } catch (e) {
      this.log(this.els.mon, `open failed: ${e.message}`, "err");
    }
  },

  onSerialClosed() {
    if (!this._monOpen) return;
    this._monOpen = false;
    this.els.monToggle.textContent = "OPEN";
    this.els.monToggle.classList.remove("active");
    this.log(this.els.mon, "\u25cb port closed", "sys");
  },

  serialSend() {
    if (!this._monOpen) return;
    const text = this.els.send.value;
    this.els.send.value = "";
    OmniNative.request("arduino.serialSend",
      JSON.stringify({ data: text + "\n" })).catch(() => {});
    this.log(this.els.mon, `> ${text}`, "sys");
  },

  onSerialChunk(b64) {
    let text = "";
    try {
      text = decodeURIComponent(escape(atob(b64)));
    } catch (e) {
      try { text = atob(b64); } catch (_) { return; }
    }
    this._serialBuf += text;
    let idx;
    while ((idx = this._serialBuf.indexOf("\n")) >= 0) {
      const line = this._serialBuf.slice(0, idx).replace(/\r$/, "");
      this._serialBuf = this._serialBuf.slice(idx + 1);
      if (line.length) {
        this.log(this.els.mon, line, "");
        this.plotLine(line);
      }
    }
    if (this._serialBuf.length > 4096) this._serialBuf = ""; // runaway guard
  },

  // Arduino serial-plotter protocol: "a:1 b:2" or "1,2,3" or "1 2 3"
  plotLine(line) {
    const parts = line.trim().split(/[\s,\t]+/).filter(Boolean);
    if (!parts.length || parts.length > 6) return;
    const vals = [];
    for (let i = 0; i < parts.length; i++) {
      let label = `V${i + 1}`;
      let vs = parts[i];
      const ci = vs.indexOf(":");
      if (ci > 0) {
        label = vs.slice(0, ci);
        vs = vs.slice(ci + 1);
      }
      const v = parseFloat(vs);
      if (!isFinite(v)) return; // non-numeric line — not plotter data
      vals.push([label, v]);
    }
    for (const [label, v] of vals) {
      let s = this._series[label];
      if (!s) {
        if (Object.keys(this._series).length >= 6) continue;
        s = this._series[label] = { data: [], color: this._plotColors[Object.keys(this._series).length] };
      }
      s.data.push(v);
      if (s.data.length > 600) s.data.shift();
    }
    if (!this.els.views.plot.hidden) this.drawPlot();
  },

  resizePlot() {
    const c = this.els.plot;
    const r = c.getBoundingClientRect();
    if (r.width && r.height) {
      c.width = r.width * (window.devicePixelRatio || 1);
      c.height = r.height * (window.devicePixelRatio || 1);
    }
    this.drawPlot();
  },

  drawPlot() {
    const c = this.els.plot;
    const ctx = c.getContext("2d");
    const w = c.width;
    const h = c.height;
    ctx.clearRect(0, 0, w, h);
    const names = Object.keys(this._series);
    if (!names.length) return;
    let min = Infinity, max = -Infinity;
    for (const n of names) {
      for (const v of this._series[n].data) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!isFinite(min)) return;
    if (max - min < 1e-9) { max += 1; min -= 1; }
    const pad = (max - min) * 0.1;
    min -= pad; max += pad;

    // grid
    ctx.strokeStyle = "rgba(53, 214, 255, 0.12)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 5; i++) {
      const y = (h * i) / 5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    for (const n of names) {
      const s = this._series[n];
      ctx.strokeStyle = s.color;
      ctx.lineWidth = Math.max(1.2, (window.devicePixelRatio || 1));
      ctx.beginPath();
      s.data.forEach((v, i) => {
        const x = (i / 599) * w;
        const y = h - ((v - min) / (max - min)) * h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    // legend
    this.els.legend.innerHTML = names.map((n) => {
      const last = this._series[n].data[this._series[n].data.length - 1];
      return `<span style="color:${this._series[n].color}">\u25a0 ${n} ${last !== undefined ? last.toFixed(2) : ""}</span>`;
    }).join("");
  },
});
