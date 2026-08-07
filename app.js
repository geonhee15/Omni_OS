// OMNI_OS core
// Future apps get integrated by registering themselves as modules here.
const OmniOS = {
  version: "0.3.0",
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

  request(cmd, timeoutMs = 8000) {
    if (!this.available) return Promise.reject(new Error("bridge offline"));
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        delete this._pending[id];
        reject(new Error("bridge timeout"));
      }, timeoutMs);
      this._pending[id] = { resolve, timer };
      window.webkit.messageHandlers.omni.postMessage({ id, cmd });
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
    };
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

    // watcher module
    els.wState.textContent = running ? "RUNNING" : "OFFLINE";
    els.wState.className = `watcher-state ${running ? "ok" : "alert"}`;
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
