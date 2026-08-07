// OMNI_OS core
// Future apps get integrated by registering themselves as modules here.
const OmniOS = {
  version: "0.2.0",
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
    this.els = {
      banner: document.getElementById("sp1-banner"),
      state: document.getElementById("sp1-state"),
      since: document.getElementById("sp1-since"),
      sync: document.getElementById("sp1-sync"),
      feed: document.getElementById("sp1-feed"),
      navDot: document.getElementById("sp1-nav-dot"),
      watcher: document.querySelector("#card-watcher .card-value"),
      watcherSub: document.querySelector("#card-watcher .card-sub"),
      ntfy: document.querySelector("#card-ntfy .card-value"),
      notify: document.querySelector("#card-notify .card-value"),
      notifySub: document.querySelector("#card-notify .card-sub"),
      remote: document.querySelector("#card-remote .card-value"),
      remoteSub: document.querySelector("#card-remote .card-sub"),
      autostart: document.querySelector("#card-autostart .card-value"),
      intrusions: document.querySelector("#card-intrusions .card-value"),
      components: document.querySelector("#card-components .card-value"),
      componentsSub: document.querySelector("#card-components .card-sub"),
    };
    this.refresh();
    setInterval(() => this.refresh(), this.POLL_MS);
  },

  async refresh() {
    if (!OmniNative.available) {
      this.renderBridgeOffline();
      return;
    }
    try {
      const s = await OmniNative.request("sp1.status");
      this.render(s);
    } catch (e) {
      this.setBanner("warn", "SYNC ERROR", "native bridge did not respond");
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

  setBanner(tone, text, since) {
    this.els.banner.className = `state-banner ${tone}`;
    this.els.state.textContent = text;
    this.els.since.textContent = since || "";
  },

  setCard(el, text, tone) {
    el.textContent = text;
    el.className = `card-value${tone ? " " + tone : ""}`;
  },

  render(s) {
    const state = this.deriveState(s);
    const running = !!s.watcherRunning;

    // banner + sidebar dot
    if (!running) {
      this.setBanner("alert", "WATCHER OFFLINE", "monitoring process is not running");
      this.els.navDot.className = "nav-dot alert";
    } else if (state.mode === "LOCKDOWN") {
      const bits = [`PHASE ${state.phase}`];
      if (state.ts) bits.push(`SINCE ${state.ts}`);
      if (state.attempts) bits.push(`FAILED ATTEMPTS ${state.attempts}`);
      this.setBanner("alert", "LOCKDOWN ACTIVE", bits.join(" · "));
      this.els.navDot.className = "nav-dot alert";
    } else if (state.mode === "UNLOCKED") {
      this.setBanner("ok", "UNLOCKED · MONITORING", state.ts ? `ARMED SINCE ${state.ts}` : "");
      this.els.navDot.className = "nav-dot ok";
    } else {
      this.setBanner("", "STATE UNKNOWN", "no state markers found in log");
      this.els.navDot.className = "nav-dot off";
    }

    // cards
    if (running) {
      this.setCard(this.els.watcher, "RUNNING", "ok");
      this.els.watcherSub.textContent = `pid ${s.watcherPid}`;
    } else {
      this.setCard(this.els.watcher, "OFFLINE", "alert");
      this.els.watcherSub.textContent = "gesture monitor process";
    }

    if (s.ntfyReachable === true) this.setCard(this.els.ntfy, "ONLINE", "ok");
    else if (s.ntfyReachable === false) this.setCard(this.els.ntfy, "UNREACHABLE", "alert");
    else this.setCard(this.els.ntfy, "NOT IN USE", "dim");

    const provider = (s.notifyProvider || "none").toUpperCase();
    this.setCard(this.els.notify, provider, provider === "NONE" ? "dim" : "ok");
    this.els.notifySub.textContent =
      provider === "NTFY" ? (s.ntfyTopicSet ? "topic configured" : "no topic set") : "push provider";

    if (s.remoteEnabled) {
      this.setCard(this.els.remote, "ENABLED", "ok");
      this.els.remoteSub.textContent = s.remoteUnlockAllowed ? "remote unlock allowed" : "remote unlock blocked";
    } else {
      this.setCard(this.els.remote, "DISABLED", "dim");
      this.els.remoteSub.textContent = "phone commands";
    }

    this.setCard(this.els.autostart, s.autostartInstalled ? "INSTALLED" : "NOT INSTALLED",
      s.autostartInstalled ? "ok" : "dim");

    const n = s.intruderCount || 0;
    this.setCard(this.els.intrusions, String(n), n > 0 ? "alert" : "ok");

    const comp = [s.appBundle, s.modelPresent, s.configPresent];
    const okCount = comp.filter(Boolean).length;
    this.setCard(this.els.components, `${okCount}/3 OK`, okCount === 3 ? "ok" : "warn");
    const missing = [];
    if (!s.appBundle) missing.push("bundle");
    if (!s.modelPresent) missing.push("model");
    if (!s.configPresent) missing.push("config");
    this.els.componentsSub.textContent = missing.length ? `missing: ${missing.join(", ")}` : "bundle / model / config";

    // event feed (newest first)
    const tail = (s.logTail || []).slice(-9).reverse();
    this.els.feed.innerHTML = "";
    if (!tail.length) {
      this.els.feed.innerHTML = '<li class="feed-empty">NO EVENTS LOGGED</li>';
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
        this.els.feed.appendChild(li);
      }
    }

    const now = new Date();
    const pad = (x) => String(x).padStart(2, "0");
    this.els.sync.textContent = `SYNC ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  },

  renderBridgeOffline() {
    this.setBanner("warn", "NATIVE BRIDGE OFFLINE", "open the Omni OS mac app to see live status");
    this.els.navDot.className = "nav-dot off";
    this.els.sync.textContent = "SYNC —";
  },
});
