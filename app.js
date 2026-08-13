// OMNI_OS core
// Future apps get integrated by registering themselves as modules here.
const OmniOS = {
  version: "0.27.1",
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

// ---------- module: PROJECTS (in-app project registry) ----------
OmniOS.register("proj", {
  els: null,
  _items: [],
  _loaded: false,
  STATUS_CYCLE: ["planning", "active", "paused", "done"],

  init() {
    const $ = (id) => document.getElementById(id);
    this.els = {
      summary: $("pj-summary"), newBtn: $("pj-new"),
      empty: $("pj-empty"), list: $("pj-list"),
      modal: $("pj-modal"),
      fName: $("pjf-name"), fType: $("pjf-type"), fPriority: $("pjf-priority"),
      fStatus: $("pjf-status"),
      fDesc: $("pjf-desc"), fTags: $("pjf-tags"), fTarget: $("pjf-target"),
      fLink: $("pjf-link"), fCancel: $("pjf-cancel"), fCreate: $("pjf-create"),
      editor: $("pj-editor"), edName: $("pj-ed-name"), edHost: $("pj-ed-host"),
      edHint: $("pj-ed-hint"), edTools: $("pj-ed-tools"), edClose: $("pj-ed-close"),
    };
    this.els.edClose.addEventListener("click", () => this.closeEditor());
    this.els.edTools.querySelectorAll("button[data-tool]").forEach((b) =>
      b.addEventListener("click", () => this.mountPanel(b.dataset.tool)));
    window.addEventListener("mousedown", (e) => {
      if (this._ctx && !this._ctx.contains(e.target)) this.hideMenu();
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.hideMenu();
    });
    window.addEventListener("blur", () => this.hideMenu());
    this.els.newBtn.addEventListener("click", () => this.openForm());
    this.els.fCancel.addEventListener("click", () => this.closeForm());
    this.els.fCreate.addEventListener("click", () => this.create());
    this.els.fName.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.create();
    });
    this.els.modal.addEventListener("mousedown", (e) => {
      if (e.target === this.els.modal) this.closeForm();
    });
    for (const group of [this.els.fType, this.els.fPriority, this.els.fStatus]) {
      group.querySelectorAll("button").forEach((b) =>
        b.addEventListener("click", () => {
          group.querySelectorAll("button").forEach((x) =>
            x.classList.toggle("active", x === b));
        }));
    }
    document.addEventListener("omni:panel", (e) => {
      if (e.detail === "proj" && !this._loaded) this.load();
      if (e.detail !== "proj") {
        this.hideMenu();
        if (!this.els.editor.hidden) this.closeEditor();
      }
    });
  },

  async load() {
    this._loaded = true;
    try {
      if (OmniNative.available) {
        const r = await OmniNative.request("store.read",
          JSON.stringify({ name: "projects" }), 8000);
        this._items = r && r.data ? JSON.parse(r.data) : [];
      } else {
        this._items = JSON.parse(localStorage.getItem("omni.projects") || "[]");
      }
    } catch (e) {
      this._items = [];
    }
    this.render();
  },

  async persist() {
    const data = JSON.stringify(this._items);
    try {
      if (OmniNative.available) {
        await OmniNative.request("store.write",
          JSON.stringify({ name: "projects", data }), 8000);
      } else {
        localStorage.setItem("omni.projects", data);
      }
    } catch (e) {}
  },

  openForm() {
    const E = this.els;
    E.fName.value = "";
    E.fDesc.value = "";
    E.fTags.value = "";
    E.fTarget.value = "";
    E.fLink.value = "";
    const pick = (group, v) => group.querySelectorAll("button").forEach((b) =>
      b.classList.toggle("active", b.dataset.v === v));
    pick(E.fType, "software");
    pick(E.fPriority, "med");
    pick(E.fStatus, "planning");
    E.modal.hidden = false;
    E.fName.focus();
  },

  closeForm() {
    this.els.modal.hidden = true;
  },

  picked(group) {
    const b = group.querySelector("button.active");
    return b ? b.dataset.v : null;
  },

  create() {
    const E = this.els;
    const name = E.fName.value.trim();
    if (!name) {
      E.fName.focus();
      E.fName.style.borderColor = "var(--alert)";
      setTimeout(() => { E.fName.style.borderColor = ""; }, 900);
      return;
    }
    const link = E.fLink.value.trim();
    this._items.unshift({
      id: `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
      name,
      type: this.picked(E.fType) || "software",
      priority: this.picked(E.fPriority) || "med",
      desc: E.fDesc.value.trim(),
      tags: E.fTags.value.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 6),
      target: E.fTarget.value || null,
      link: /^https?:\/\//i.test(link) ? link : null,
      status: this.picked(E.fStatus) || "planning",
      createdAt: Date.now(),
    });
    this.persist();
    this.render();
    this.closeForm();
  },

  cycleStatus(item) {
    const i = this.STATUS_CYCLE.indexOf(item.status);
    item.status = this.STATUS_CYCLE[(i + 1) % this.STATUS_CYCLE.length];
    this.persist();
    this.render();
  },

  remove(id) {
    this._items = this._items.filter((p) => p.id !== id);
    this.persist();
    this.render();
  },

  fmtDate(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },

  dday(target) {
    const t = new Date(`${target}T00:00:00`);
    const days = Math.ceil((t - new Date().setHours(0, 0, 0, 0)) / 86400000);
    if (days > 0) return { label: `D-${days}`, cls: days <= 7 ? "soon" : "" };
    if (days === 0) return { label: "D-DAY", cls: "soon" };
    return { label: `D+${-days}`, cls: "over" };
  },

  // ── row context menu: Reload / Link With Panel / Go To Connected / Editor ──
  _ctx: null,
  _r3dHome: null,

  panelChoices() {
    const out = [];
    document.querySelectorAll(".nav-item").forEach((btn) => {
      const key = btn.dataset.panel;
      if (key === "proj") return;
      out.push({ key, label: btn.querySelector(".nav-label").textContent });
    });
    return out;
  },

  hideMenu() {
    if (this._ctx) {
      this._ctx.remove();
      this._ctx = null;
    }
  },

  showMenu(p, x, y) {
    this.hideMenu();
    const menu = document.createElement("div");
    menu.className = "pj-ctx";
    const mkItem = (label, opts = {}) => {
      const it = document.createElement("div");
      it.className = `pj-ctx-item${opts.disabled ? " disabled" : ""}`;
      const span = document.createElement("span");
      span.textContent = label;
      it.appendChild(span);
      if (opts.hint) {
        const h = document.createElement("span");
        h.textContent = opts.hint;
        h.style.color = "rgba(111, 168, 201, 0.7)";
        it.appendChild(h);
      }
      if (opts.onClick) {
        it.addEventListener("click", () => {
          this.hideMenu();
          opts.onClick();
        });
      }
      menu.appendChild(it);
      return it;
    };
    const sep = () => {
      const s = document.createElement("div");
      s.className = "pj-ctx-sep";
      menu.appendChild(s);
    };

    mkItem("RELOAD", { onClick: () => window.location.reload() });
    sep();

    // Link With Panel — 사이드바 패널 서브메뉴
    const linkItem = mkItem("LINK WITH PANEL", { hint: "\u25B8" });
    const sub = document.createElement("div");
    sub.className = "pj-ctx-sub";
    for (const c of this.panelChoices()) {
      const it = document.createElement("div");
      it.className = "pj-ctx-item";
      it.textContent = (p.linkedPanel === c.key ? "\u25C6 " : "") + c.label;
      it.addEventListener("click", () => {
        p.linkedPanel = c.key;
        this.persist();
        this.render();
        this.hideMenu();
      });
      sub.appendChild(it);
    }
    if (p.linkedPanel) {
      const s2 = document.createElement("div");
      s2.className = "pj-ctx-sep";
      sub.appendChild(s2);
      const un = document.createElement("div");
      un.className = "pj-ctx-item";
      un.textContent = "UNLINK";
      un.addEventListener("click", () => {
        delete p.linkedPanel;
        this.persist();
        this.render();
        this.hideMenu();
      });
      sub.appendChild(un);
    }
    linkItem.appendChild(sub);

    const linkedLabel = p.linkedPanel
      ? (this.panelChoices().find((c) => c.key === p.linkedPanel) || {}).label
      : null;
    mkItem("GO TO CONNECTED PANEL", {
      disabled: !linkedLabel,
      hint: linkedLabel || "",
      onClick: linkedLabel
        ? () => OmniOS.modules.nav.show(p.linkedPanel)
        : null,
    });
    sep();
    mkItem("EDITOR", { onClick: () => this.openEditor(p) });

    document.body.appendChild(menu);
    this._ctx = menu;
    // 화면 밖으로 나가지 않게 클램프 + 서브메뉴 방향 결정
    const r = menu.getBoundingClientRect();
    const px = Math.min(x, window.innerWidth - r.width - 8);
    const py = Math.min(y, window.innerHeight - r.height - 8);
    menu.style.left = `${Math.max(4, px)}px`;
    menu.style.top = `${Math.max(4, py)}px`;
    if (px + r.width + 180 > window.innerWidth) sub.classList.add("flip-left");
  },

  // ── project editor: 기존 패널을 도구로 이식 (도구 여러 개, 홈 위치 기억) ──
  _edProject: null,
  _homes: {},

  openEditor(p) {
    this._edProject = p;
    this.els.edName.textContent = p.name.toUpperCase();
    this.els.editor.hidden = false;
    this.els.list.hidden = true;
    this.els.empty.hidden = true;
    this.els.edHint.hidden = false;
    this.syncToolChips(null);
  },

  syncToolChips(key) {
    this.els.edTools.querySelectorAll("button[data-tool]").forEach((b) =>
      b.classList.toggle("active", b.dataset.tool === key));
  },

  mountPanel(key) {
    const panel = document.getElementById(`panel-${key}`);
    if (!panel) return;
    if (panel.classList.contains("pj-embedded")) return; // 이미 이 도구
    this.unmountPanel(); // 다른 도구가 올라와 있으면 먼저 원위치
    if (!this._homes[panel.id]) {
      this._homes[panel.id] = {
        parent: panel.parentElement,
        next: panel.nextElementSibling,
      };
    }
    this.els.edHost.appendChild(panel);
    panel.classList.add("active", "pj-embedded");
    this.els.edHint.hidden = true;
    this.syncToolChips(key);
    const mod = OmniOS.modules[key];
    if (mod && mod.resize) mod.resize();
  },

  unmountPanel() {
    const panel = document.querySelector(".pj-ed-host .panel.pj-embedded");
    if (!panel) return;
    const home = this._homes[panel.id];
    panel.classList.remove("pj-embedded");
    if (home) home.parent.insertBefore(panel, home.next);
    // 사이드바에서 그 패널이 선택돼 있을 때만 계속 표시
    const cur = document.querySelector(".nav-item.active");
    panel.classList.toggle("active",
      !!cur && `panel-${cur.dataset.panel}` === panel.id);
    this.syncToolChips(null);
  },

  closeEditor() {
    this.unmountPanel();
    this._edProject = null;
    this.els.editor.hidden = true;
    this.render();
  },

  render() {
    const E = this.els;
    const items = this._items;
    const inEditor = !E.editor.hidden;
    E.empty.hidden = inEditor || items.length > 0;
    E.list.hidden = inEditor || items.length === 0;
    const active = items.filter((p) => p.status === "active").length;
    const done = items.filter((p) => p.status === "done").length;
    E.summary.textContent = items.length
      ? `${items.length} PROJECTS \u00b7 ${active} ACTIVE \u00b7 ${done} DONE`
      : "\u2014";

    const TYPE_LABEL = { software: "SW", hardware: "HW", hybrid: "SW+HW" };
    E.list.textContent = "";
    for (const p of items) {
      const row = document.createElement("div");
      row.className = `pj-row${p.status === "done" ? " done" : ""}`;

      const type = document.createElement("span");
      type.className = `pj-type ${p.type}`;
      type.textContent = TYPE_LABEL[p.type] || "SW";
      row.appendChild(type);

      const name = document.createElement("span");
      name.className = "pj-name";
      if (p.link) {
        const a = document.createElement("a");
        a.href = "#";
        a.textContent = p.name.toUpperCase();
        a.title = p.link;
        a.addEventListener("click", (e) => {
          e.preventDefault();
          if (OmniNative.available) {
            OmniNative.request("open.url",
              JSON.stringify({ url: p.link })).catch(() => {});
          } else {
            window.open(p.link, "_blank");
          }
        });
        name.appendChild(a);
      } else {
        name.textContent = p.name.toUpperCase();
      }
      row.appendChild(name);

      const desc = document.createElement("span");
      desc.className = "pj-desc";
      desc.textContent = p.desc || "";
      row.appendChild(desc);

      const tags = document.createElement("span");
      tags.className = "pj-tags";
      (p.tags || []).slice(0, 3).forEach((t) => {
        const tag = document.createElement("span");
        tag.className = "pj-tag";
        tag.textContent = t.toUpperCase();
        tags.appendChild(tag);
      });
      if (p.linkedPanel) {
        const lk = document.createElement("span");
        lk.className = "pj-tag linked";
        const c = this.panelChoices().find((x) => x.key === p.linkedPanel);
        lk.textContent = `\u21C4 ${c ? c.label : p.linkedPanel}`;
        lk.title = "Linked panel";
        tags.appendChild(lk);
      }
      row.appendChild(tags);

      const prio = document.createElement("span");
      prio.className = `pj-prio ${p.priority}`;
      prio.textContent = { low: "\u25BD LOW", med: "\u25C7 MED",
        high: "\u25B3 HIGH", crit: "\u25B2 CRIT" }[p.priority] || "";
      row.appendChild(prio);

      const status = document.createElement("button");
      status.className = `pj-status-btn ${p.status}`;
      status.textContent = p.status.toUpperCase();
      status.title = "Click to change status";
      status.addEventListener("click", () => this.cycleStatus(p));
      row.appendChild(status);

      const dates = document.createElement("span");
      dates.className = "pj-dates";
      let dt = this.fmtDate(p.createdAt);
      dates.textContent = dt;
      if (p.target && p.status !== "done") {
        const dd = this.dday(p.target);
        const s = document.createElement("span");
        s.className = `dday ${dd.cls}`;
        s.textContent = ` \u00b7 ${dd.label}`;
        dates.appendChild(s);
      }
      row.appendChild(dates);

      const del = document.createElement("button");
      del.className = "pj-del";
      del.textContent = "\u2715";
      del.addEventListener("click", () => {
        if (del.classList.contains("confirm")) {
          this.remove(p.id);
        } else {
          del.classList.add("confirm");
          del.textContent = "SURE?";
          setTimeout(() => {
            del.classList.remove("confirm");
            del.textContent = "\u2715";
          }, 2000);
        }
      });
      row.appendChild(del);

      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.showMenu(p, e.clientX, e.clientY);
      });

      E.list.appendChild(row);
    }
  },
});

// ---------- module: SYSTEM MONITOR (mission control) ----------
OmniOS.register("sys", {
  els: null,
  _timer: null,
  _hist: { rx: [], tx: [], dr: [], dw: [] },
  _mockT: 0,

  init() {
    const $ = (id) => document.getElementById(id);
    this.els = {
      model: $("sy-model"), thermal: $("sy-thermal"), load: $("sy-load"),
      uptime: $("sy-uptime"),
      cpuGauge: $("sy-cpu-gauge"), cpuPct: $("sy-cpu-pct"), cores: $("sy-cores"),
      gpuMod: $("sy-gpu-mod"), gpuGauge: $("sy-gpu-gauge"), gpuPct: $("sy-gpu-pct"),
      memGauge: $("sy-mem-gauge"), memNote: $("sy-mem-note"),
      membar: $("sy-membar"), pressure: $("sy-pressure"),
      diskNote: $("sy-disk-note"), diskUsed: $("sy-disk-used"),
      diskBar: $("sy-disk-bar"), diskR: $("sy-disk-r"), diskW: $("sy-disk-w"),
      diskSpark: $("sy-disk-spark"),
      netRx: $("sy-net-rx"), netTx: $("sy-net-tx"),
      netRxSpark: $("sy-net-rx-spark"), netTxSpark: $("sy-net-tx-spark"),
      batMod: $("sy-bat-mod"), batGauge: $("sy-bat-gauge"),
      batState: $("sy-bat-state"), batHealth: $("sy-bat-health"),
      batCycles: $("sy-bat-cycles"), batTime: $("sy-bat-time"),
      top: $("sy-top"), osver: $("sy-osver"), ncores: $("sy-ncores"),
      ramTotal: $("sy-ram-total"),
    };
    // 패널이 보일 때만 1초 폴링
    document.addEventListener("omni:panel", (e) => {
      if (e.detail === "sys") this.startPolling();
      else this.stopPolling();
    });
  },

  startPolling() {
    if (this._timer) return;
    this.tick();
    this._timer = setInterval(() => this.tick(), 1000);
  },

  stopPolling() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  },

  async tick() {
    let d;
    if (OmniNative.available) {
      try {
        d = await OmniNative.request("sys.stats", null, 4000);
      } catch (e) {
        return;
      }
    } else {
      d = this.mock(); // 브라우저 개발 모드
    }
    if (d) this.render(d);
  },

  // 브라우저 개발용 가짜 지표 — 실제 앱에서는 네이티브 수집기 사용
  mock() {
    const t = this._mockT += 1;
    const wob = (base, amp, speed, ph) =>
      base + amp * (0.5 + 0.5 * Math.sin(t * speed + ph));
    const cores = Array.from({ length: 12 },
      (_, i) => Math.max(0, Math.min(1, wob(0.2, 0.6, 0.31, i * 1.7))));
    return {
      cpu: cores.reduce((s, v) => s + v, 0) / cores.length,
      cores,
      cpuModel: "MOCK CPU (BROWSER DEV)",
      gpu: Math.round(wob(15, 60, 0.23, 1)),
      load: [wob(2, 3, 0.1, 0), 2.5, 2.2],
      uptime: 137000 + t,
      mem: {
        total: 128 * 2 ** 30,
        wired: 9 * 2 ** 30,
        compressed: wob(2, 2, 0.05, 0) * 2 ** 30,
        active: wob(30, 20, 0.07, 2) * 2 ** 30,
        inactive: 20 * 2 ** 30,
        free: 40 * 2 ** 30,
        pressure: 1,
      },
      net: { rxRate: wob(0.2, 8, 0.4, 0) * 2 ** 20, txRate: wob(0.05, 1.5, 0.5, 2) * 2 ** 20 },
      disk: {
        total: 2048 * 2 ** 30, free: 959 * 2 ** 30,
        readRate: wob(0.1, 40, 0.6, 1) * 2 ** 20, writeRate: wob(0.05, 15, 0.7, 3) * 2 ** 20,
      },
      battery: {
        percent: 74, charging: t % 40 > 20, external: true,
        timeToEmpty: 312, timeToFull: -1, cycles: 195, health: 0.95,
      },
      thermal: 0,
      top: [
        { pid: 1201, cpu: wob(20, 60, 0.3, 0), mem: 4.1, name: "MockRenderer" },
        { pid: 88, cpu: wob(10, 25, 0.4, 1), mem: 2.0, name: "WindowServer" },
        { pid: 421, cpu: 8.2, mem: 1.2, name: "kernel_task" },
        { pid: 902, cpu: 4.0, mem: 6.3, name: "Safari" },
        { pid: 77, cpu: 2.1, mem: 0.4, name: "coreaudiod" },
        { pid: 3, cpu: 1.0, mem: 0.2, name: "launchd" },
      ],
      osver: "Version 26.0 (Mock)",
    };
  },

  fmtBytes(v) {
    if (v >= 2 ** 30) return `${(v / 2 ** 30).toFixed(1)} GB`;
    if (v >= 2 ** 20) return `${(v / 2 ** 20).toFixed(1)} MB`;
    return `${(v / 1024).toFixed(0)} KB`;
  },

  fmtRate(v) {
    if (v >= 2 ** 20) return `${(v / 2 ** 20).toFixed(1)} MB/S`;
    return `${(v / 1024).toFixed(0)} KB/S`;
  },

  // 원호 게이지: 0~100%를 -210°→30° 스윕으로
  gauge(cv, frac, label, color) {
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth || 150, H = cv.clientHeight || 120;
    const bw = Math.round(W * dpr), bh = Math.round(H * dpr);
    if (cv.width !== bw || cv.height !== bh) {
      cv.width = bw;
      cv.height = bh;
    }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 이후 좌표는 전부 CSS px — 레티나에서 선명
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H * 0.62, r = Math.min(W, H) * 0.46;
    const a0 = Math.PI * (-210 / 180), a1 = Math.PI * (30 / 180);
    ctx.lineWidth = 7;
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(53, 214, 255, 0.12)";
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a1);
    ctx.stroke();
    const f = Math.max(0, Math.min(1, frac));
    ctx.strokeStyle = color || "#35d6ff";
    ctx.shadowColor = color || "#35d6ff";
    ctx.shadowBlur = 8;
    if (f > 0.004) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, a0, a0 + (a1 - a0) * f);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#eafcff";
    ctx.font = "700 22px 'Orbitron', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(label, cx, cy + 8);
  },

  spark(cv, hist, color) {
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth || cv.width, H = cv.clientHeight || cv.height;
    const bw = Math.round(W * dpr), bh = Math.round(H * dpr);
    if (cv.width !== bw || cv.height !== bh) {
      cv.width = bw;
      cv.height = bh;
    }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (hist.length < 2) return;
    const max = Math.max(...hist, 1e-6);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    hist.forEach((v, i) => {
      const x = (i / (hist.length - 1)) * W;
      const y = H - 2 - (v / max) * (H - 6);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.lineTo(W, H);
    ctx.lineTo(0, H);
    ctx.closePath();
    ctx.fillStyle = color.replace(")", ", 0.12)").replace("rgb", "rgba");
    ctx.fill();
  },

  push(key, v) {
    const h = this._hist[key];
    h.push(v);
    if (h.length > 60) h.shift();
  },

  render(d) {
    const E = this.els;
    const THERMAL = ["NOMINAL", "FAIR", "SERIOUS", "CRITICAL"];

    E.model.textContent = (d.cpuModel || "").toUpperCase();
    const th = THERMAL[d.thermal] || "?";
    E.thermal.textContent = `THERMAL ${th}`;
    E.thermal.className = `ts-item${d.thermal >= 2 ? " alert" : d.thermal === 1 ? "" : " ok"}`;
    E.load.textContent = `LOAD ${(d.load || [0])[0].toFixed(2)}`;
    const up = d.uptime || 0;
    E.uptime.textContent =
      `UP ${Math.floor(up / 86400)}D ${Math.floor((up % 86400) / 3600)}H ` +
      `${Math.floor((up % 3600) / 60)}M`;

    // CPU
    const cpu = d.cpu || 0;
    this.gauge(E.cpuGauge, cpu, `${Math.round(cpu * 100)}%`,
      cpu > 0.85 ? "#ff4d5e" : cpu > 0.6 ? "#ffc857" : "#35d6ff");
    E.cpuPct.textContent = `${(d.cores || []).length} CORES`;
    const cores = d.cores || [];
    if (E.cores.childElementCount !== cores.length) {
      E.cores.textContent = "";
      cores.forEach(() => {
        const c = document.createElement("div");
        c.className = "sy-core";
        c.appendChild(document.createElement("i"));
        E.cores.appendChild(c);
      });
    }
    [...E.cores.children].forEach((c, i) => {
      c.firstChild.style.height = `${Math.round((cores[i] || 0) * 100)}%`;
    });

    // GPU
    if (typeof d.gpu === "number") {
      E.gpuMod.hidden = false;
      this.gauge(E.gpuGauge, d.gpu / 100, `${Math.round(d.gpu)}%`,
        d.gpu > 85 ? "#ff4d5e" : d.gpu > 60 ? "#ffc857" : "#35d6ff");
      E.gpuPct.textContent = "";
    } else {
      E.gpuMod.hidden = true;
    }

    // MEMORY
    const m = d.mem || {};
    const app = (m.active || 0) + (m.inactive || 0);
    const used = (m.wired || 0) + (m.compressed || 0) + app;
    const frac = m.total ? used / m.total : 0;
    this.gauge(E.memGauge, frac, `${Math.round(frac * 100)}%`,
      frac > 0.9 ? "#ff4d5e" : frac > 0.75 ? "#ffc857" : "#35d6ff");
    E.memNote.textContent =
      `${this.fmtBytes(used)} / ${this.fmtBytes(m.total || 0)}`;
    const segs = [
      [m.wired || 0, "#35d6ff"],
      [app, "#2f7bff"],
      [m.compressed || 0, "#b26bff"],
      [Math.max(0, (m.total || 0) - used), "rgba(53,214,255,0.15)"],
    ];
    if (E.membar.childElementCount !== segs.length) {
      E.membar.textContent = "";
      segs.forEach(() => E.membar.appendChild(document.createElement("i")));
    }
    [...E.membar.children].forEach((el, i) => {
      el.style.width = `${(segs[i][0] / (m.total || 1)) * 100}%`;
      el.style.background = segs[i][1];
    });
    const P = { 1: "NORMAL", 2: "WARNING", 4: "CRITICAL" };
    E.pressure.textContent = P[m.pressure] || "—";
    E.ramTotal.textContent = this.fmtBytes(m.total || 0);

    // DISK
    const dk = d.disk || {};
    const dUsed = (dk.total || 0) - (dk.free || 0);
    const dFrac = dk.total ? dUsed / dk.total : 0;
    E.diskNote.textContent = `${this.fmtBytes(dk.free || 0)} FREE`;
    E.diskUsed.textContent = `${Math.round(dFrac * 100)}%`;
    E.diskBar.style.setProperty("--w", `${dFrac * 100}%`);
    E.diskBar.innerHTML = `<i style="display:block;height:100%;width:${(dFrac * 100).toFixed(1)}%;background:${dFrac > 0.9 ? "#ff4d5e" : "#35d6ff"};"></i>`;
    E.diskR.textContent = this.fmtRate(dk.readRate || 0);
    E.diskW.textContent = this.fmtRate(dk.writeRate || 0);
    this.push("dr", dk.readRate || 0);
    this.push("dw", dk.writeRate || 0);
    this.spark(E.diskSpark, this._hist.dr.map((v, i) => v + this._hist.dw[i]), "rgb(53, 214, 255)");

    // NETWORK
    const n = d.net || {};
    E.netRx.textContent = this.fmtRate(n.rxRate || 0);
    E.netTx.textContent = this.fmtRate(n.txRate || 0);
    this.push("rx", n.rxRate || 0);
    this.push("tx", n.txRate || 0);
    this.spark(E.netRxSpark, this._hist.rx, "rgb(53, 214, 255)");
    this.spark(E.netTxSpark, this._hist.tx, "rgb(47, 123, 255)");

    // BATTERY
    const b = d.battery;
    if (b && b.percent >= 0) {
      E.batMod.hidden = false;
      this.gauge(E.batGauge, b.percent / 100, `${b.percent}%`,
        b.percent <= 15 ? "#ff4d5e" : b.charging ? "#3dffa8" : "#35d6ff");
      E.batState.textContent = b.charging ? "CHARGING"
        : b.external ? "AC POWER" : "ON BATTERY";
      E.batHealth.textContent =
        typeof b.health === "number" ? `${Math.round(b.health * 100)}%` : "—";
      E.batCycles.textContent = b.cycles >= 0 ? `${b.cycles}` : "—";
      const mins = b.charging ? b.timeToFull : b.timeToEmpty;
      E.batTime.textContent = mins > 0
        ? `${Math.floor(mins / 60)}H ${mins % 60}M ${b.charging ? "TO FULL" : "LEFT"}`
        : "—";
    } else {
      E.batMod.hidden = true;
    }

    // PROCESS TOP
    const rows = d.top || [];
    E.top.textContent = "";
    const maxCpu = Math.max(10, ...rows.map((r) => r.cpu));
    rows.forEach((r) => {
      const row = document.createElement("div");
      row.className = "sy-top-row";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = r.name;
      const bar = document.createElement("span");
      bar.className = "bar";
      const fill = document.createElement("i");
      fill.style.width = `${Math.min(100, (r.cpu / maxCpu) * 100)}%`;
      bar.appendChild(fill);
      const val = document.createElement("span");
      val.className = "val";
      val.textContent = `${r.cpu.toFixed(1)}%`;
      row.append(name, bar, val);
      E.top.appendChild(row);
    });

    E.osver.textContent = (d.osver || "").replace("Version ", "");
    E.ncores.textContent = `${cores.length}`;
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
        return load(new t.PLYLoader(manager)).then((g) =>
          g.index || g.attributes.normal
            ? this.meshFromGeometry(g)
            : this.pointsFromGeometry(g)); // faceless PLY = point cloud scan
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

  // point-cloud PLY (e.g. an ARC-SCAN export) — render as points, not triangles
  pointsFromGeometry(geometry) {
    const { THREE } = this._three;
    const hasColor = !!geometry.attributes.color;
    const mat = new THREE.PointsMaterial({
      size: 0.02,
      vertexColors: hasColor,
      color: hasColor ? 0xffffff : 0x9fb8cc,
      sizeAttenuation: true,
    });
    if (!hasColor) mat.userData.autoDefault = true;
    return new THREE.Points(geometry, mat);
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
      if (!o.isMesh && !o.isPoints) return; // point clouds (PLY scans) count too
      meshes++;
      o.userData._origMat = o.material;
      const g = o.geometry;
      g.userData._refs = (g.userData._refs || 0) + 1; // shared with assembly clones
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m && m.userData) m.userData._refs = (m.userData._refs || 0) + 1;
      }
      const n = g.attributes.position ? g.attributes.position.count : 0;
      verts += n;
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true; // self-shadowing darkens holes and cavities
        tris += Math.round(g.index ? g.index.count / 3 : n / 3);
      }
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

// ---------- module: CODE EDITOR (files + CodeMirror + PTY terminals) ----------
OmniOS.register("ce", {
  els: null,
  _cm: null,
  _files: [],       // {path, name, doc, dirty, mode}
  _active: -1,
  _root: null,
  _terms: [],       // {tid, term, fit, el, tab, dead, n}
  _termActive: -1,
  _termN: 0,
  _booted: false,

  MEDIA: {
    png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
    bmp: "image", svg: "image", ico: "image",
    mp3: "audio", wav: "audio", m4a: "audio", aac: "audio", flac: "audio", ogg: "audio",
    mp4: "video", mov: "video", m4v: "video", webm: "video",
  },

  MODES: {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "text/typescript", tsx: "text/typescript",
    json: { name: "javascript", json: true },
    html: "htmlmixed", htm: "htmlmixed",
    xml: "xml", svg: "xml", plist: "xml",
    css: "css",
    py: "python",
    sh: "shell", zsh: "shell", bash: "shell",
    md: "markdown", markdown: "markdown",
    yml: "yaml", yaml: "yaml",
    rs: "rust", go: "go", swift: "swift", toml: "toml",
    c: "text/x-csrc", h: "text/x-c++src", cpp: "text/x-c++src",
    hpp: "text/x-c++src", cc: "text/x-c++src", ino: "text/x-c++src",
    m: "text/x-objectivec", mm: "text/x-objectivec", java: "text/x-java",
  },

  init() {
    const $ = (id) => document.getElementById(id);
    this.els = {
      panel: $("panel-ce"),
      root: $("ce-root"), msg: $("ce-msg"), open: $("ce-open"),
      tree: $("ce-tree"), treeEmpty: $("ce-tree-empty"),
      tabs: $("ce-tabs"), editor: $("ce-editor"), editorEmpty: $("ce-editor-empty"),
      termwrap: $("ce-termwrap"), termtabs: $("ce-termtabs"),
      termNew: $("ce-term-new"), termToggle: $("ce-term-toggle"),
      termhost: $("ce-termhost"),
      viewer: $("ce-viewer"), newFile: $("ce-newfile"), run: $("ce-run"),
      nfModal: $("ce-modal"), nfName: $("ce-nf-name"), nfExt: $("ce-nf-ext"),
      nfDir: $("ce-nf-dir"), nfCancel: $("ce-nf-cancel"), nfCreate: $("ce-nf-create"),
    };
    this.els.run.addEventListener("click", () => this.runActive());
    this.els.newFile.addEventListener("click", () => this.openNewFile());
    this.els.nfCancel.addEventListener("click", () => { this.els.nfModal.hidden = true; });
    this.els.nfCreate.addEventListener("click", () => this.createFile());
    this.els.nfName.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.createFile();
    });
    this.els.nfModal.addEventListener("mousedown", (e) => {
      if (e.target === this.els.nfModal) this.els.nfModal.hidden = true;
    });
    this.els.open.addEventListener("click", () => this.openFolder());
    this.els.termNew.addEventListener("click", () => this.newTerm());
    this.els.termToggle.addEventListener("click", () => this.toggleTerms());
    window.addEventListener("resize", () => this.fitTerms());
    document.addEventListener("omni:panel", (e) => {
      if (e.detail === "ce") {
        this.boot();
        setTimeout(() => {
          if (this._cm) this._cm.refresh();
          this.fitTerms();
        }, 50);
      }
    });
    // 터미널 출력 푸시 수신 (네이티브 → JS)
    window.OmniCE = {
      _data: (tid, b64) => {
        const t = this._terms.find((x) => x.tid === tid);
        if (!t) return;
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        t.term.write(bytes);
      },
      _exit: (tid) => {
        const t = this._terms.find((x) => x.tid === tid);
        if (!t || t.dead) return;
        t.dead = true;
        t.term.write("\r\n\x1b[38;5;110m[PROCESS EXITED]\x1b[0m\r\n");
        this.renderTermTabs();
      },
    };
  },

  boot() {
    if (this._booted) return;
    this._booted = true;
    if (!OmniNative.available) {
      this.flash("BROWSER DEV \u2014 FILES & TERMINAL NEED THE NATIVE APP");
      this.els.open.disabled = true;
      this.els.termNew.disabled = true;
      return;
    }
    // 최근 폴더 자동 재오픈
    const last = localStorage.getItem("omni.ce.root");
    if (last) {
      OmniNative.request("ce.addRoot", JSON.stringify({ path: last }), 8000)
        .then((r) => {
          if (r && r.ok) this.setRoot(r.path);
        })
        .catch(() => {});
    }
  },

  flash(text, tone) {
    const el = this.els.msg;
    el.textContent = text;
    el.className = `ts-item${tone ? " " + tone : ""}`;
    clearTimeout(this._msgT);
    if (tone === "ok") {
      this._msgT = setTimeout(() => { el.textContent = ""; }, 2500);
    }
  },

  async openFolder() {
    try {
      const r = await OmniNative.request("ce.pickFolder", null, 120000);
      if (r && r.ok) {
        localStorage.setItem("omni.ce.root", r.path);
        this.setRoot(r.path);
      }
    } catch (e) {}
  },

  setRoot(path) {
    this._root = path;
    this._selDir = null; // {path, kidsEl, depth}
    this.els.newFile.disabled = false;
    this.els.root.textContent = path.replace(/^\/Users\/[^/]+/, "~").toUpperCase();
    this.els.treeEmpty.hidden = true;
    this.els.tree.querySelectorAll(".ce-node, .ce-kids").forEach((n) => n.remove());
    this.expandDir(path, this.els.tree, 0);
  },

  async expandDir(path, container, depth) {
    let r;
    try {
      r = await OmniNative.request("ce.tree", JSON.stringify({ path }), 10000);
    } catch (e) {
      return;
    }
    if (!r || !r.ok) return;
    for (const ent of r.entries) {
      const node = document.createElement("div");
      node.className = `ce-node${ent.dir ? " dir" : ""}`;
      node.style.paddingLeft = `${6 + depth * 12}px`;
      const glyph = document.createElement("span");
      glyph.className = "glyph";
      glyph.textContent = ent.dir ? "\u25B8" : "\u00B7";
      const label = document.createElement("span");
      label.textContent = ent.name;
      node.append(glyph, label);
      container.appendChild(node);
      const full = `${path}/${ent.name}`;
      if (ent.dir) {
        const kids = document.createElement("div");
        kids.className = "ce-kids";
        container.appendChild(kids);
        node.addEventListener("click", () => {
          const open = kids.classList.toggle("open");
          glyph.textContent = open ? "\u25BE" : "\u25B8";
          this._selDir = open ? { path: full, kidsEl: kids, depth: depth + 1 } : null;
          if (open && !kids.dataset.loaded) {
            kids.dataset.loaded = "1";
            this.expandDir(full, kids, depth + 1);
          }
        });
      } else {
        node.addEventListener("click", () => {
          this.els.tree.querySelectorAll(".ce-node.active")
            .forEach((n) => n.classList.remove("active"));
          node.classList.add("active");
          this.openFile(full);
        });
      }
    }
  },

  // ── RUN: 활성 파일을 자동 저장 후 터미널에서 언어별 러너로 실행 ──
  RUNNERS: {
    py: (f) => `python3 ${f}`,
    js: (f) => `node ${f}`,
    mjs: (f) => `node ${f}`,
    cjs: (f) => `node ${f}`,
    ts: (f) => `npx tsx ${f}`,
    tsx: (f) => `npx tsx ${f}`,
    sh: (f) => `sh ${f}`,
    zsh: (f) => `zsh ${f}`,
    bash: (f) => `bash ${f}`,
    swift: (f) => `swift ${f}`,
    go: (f) => `go run ${f}`,
    rs: (f) => `rustc ${f} -o /tmp/ce_run && /tmp/ce_run`,
    c: (f) => `clang ${f} -o /tmp/ce_run && /tmp/ce_run`,
    cpp: (f) => `clang++ -std=c++17 ${f} -o /tmp/ce_run && /tmp/ce_run`,
    cc: (f) => `clang++ -std=c++17 ${f} -o /tmp/ce_run && /tmp/ce_run`,
    m: (f) => `clang -fobjc-arc -framework Foundation ${f} -o /tmp/ce_run && /tmp/ce_run`,
    java: (f) => `java ${f}`,
    rb: (f) => `ruby ${f}`,
    php: (f) => `php ${f}`,
    pl: (f) => `perl ${f}`,
    lua: (f) => `lua ${f}`,
    html: (f) => `open ${f}`,
  },

  shq(s) {
    return `'${s.replace(/'/g, "'\\''")}'`;
  },

  async runActive() {
    const f = this._files[this._active];
    if (!f || !f.doc) {
      this.flash("OPEN A CODE FILE TO RUN", "alert");
      return;
    }
    const ext = f.name.split(".").pop().toLowerCase();
    const runner = this.RUNNERS[ext];
    if (!runner) {
      this.flash(`NO RUNNER FOR .${ext.toUpperCase()}`, "alert");
      return;
    }
    if (f.dirty) await this.saveActive(); // VSCode처럼 실행 전 자동 저장
    const dir = f.path.slice(0, f.path.lastIndexOf("/"));
    const cmd = `cd ${this.shq(dir)} && ${runner(this.shq(f.name))}`;
    await this.runInTerm(cmd);
  },

  async runInTerm(cmd) {
    let t = this._terms[this._termActive];
    if (!t || t.dead) {
      await this.newTerm();
      t = this._terms[this._termActive];
    }
    if (!t || t.tid == null) {
      this.flash("TERMINAL UNAVAILABLE", "alert");
      return;
    }
    if (this.els.termhost.hidden) this.toggleTerms();
    const bytes = new TextEncoder().encode(`${cmd}\n`);
    let bin = "";
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    OmniNative.request("ce.termWrite", JSON.stringify({
      tid: t.tid, data: btoa(bin),
    })).catch(() => {});
    t.term.focus();
  },

  // ── 새 파일: 이름 없으면 Untitled.txt(자동 넘버링), 있으면 이름.선택확장자 ──
  newFileTarget() {
    return this._selDir ? this._selDir.path : this._root;
  },

  openNewFile() {
    if (!this._root) return;
    this.els.nfName.value = "";
    this.els.nfExt.value = "txt";
    this.els.nfDir.textContent =
      `IN ${this.newFileTarget().replace(/^\/Users\/[^/]+/, "~")}`;
    this.els.nfModal.hidden = false;
    this.els.nfName.focus();
  },

  async createFile() {
    const dir = this.newFileTarget();
    if (!dir) return;
    let name = this.els.nfName.value.trim().replace(/[\/\\:]/g, "");
    const ext = this.els.nfExt.value;
    let existing = [];
    try {
      const t = await OmniNative.request("ce.tree", JSON.stringify({ path: dir }), 10000);
      existing = ((t && t.entries) || []).map((e) => e.name);
    } catch (e) {}
    if (!name) {
      // Untitled.txt → Untitled-2.txt → …
      name = `Untitled.${ext}`;
      let n = 2;
      while (existing.includes(name)) name = `Untitled-${n++}.${ext}`;
    } else if (!/\.[A-Za-z0-9]+$/.test(name)) {
      name = `${name}.${ext}`;
    }
    if (existing.includes(name)) {
      this.flash(`${name} ALREADY EXISTS`, "alert");
      return;
    }
    const path = `${dir}/${name}`;
    try {
      const r = await OmniNative.request("ce.write",
        JSON.stringify({ path, data: "" }), 10000);
      if (!r || !r.ok) throw new Error("write failed");
    } catch (e) {
      this.flash("CREATE FAILED", "alert");
      return;
    }
    this.els.nfModal.hidden = true;
    this.flash(`CREATED ${name}`, "ok");
    this.refreshDir();
    const kind = this.MEDIA[name.split(".").pop().toLowerCase()];
    if (!kind) this.openFile(path); // 텍스트 계열은 바로 편집
  },

  // 새 파일이 생긴 디렉토리만 다시 그린다 (트리 전체 접힘 방지)
  refreshDir() {
    if (this._selDir) {
      const { path, kidsEl, depth } = this._selDir;
      kidsEl.textContent = "";
      this.expandDir(path, kidsEl, depth);
    } else {
      const root = this._root;
      this.els.tree.querySelectorAll(":scope > .ce-node, :scope > .ce-kids")
        .forEach((n) => n.remove());
      this.expandDir(root, this.els.tree, 0);
    }
  },

  ensureCM() {
    if (this._cm) return this._cm;
    if (typeof window.CodeMirror === "undefined") return null;
    this._cm = window.CodeMirror(this.els.editor, {
      mode: "text/plain",
      lineNumbers: true,
      indentUnit: 2,
      tabSize: 4,
      extraKeys: {
        "Cmd-S": () => this.saveActive(),
        "Ctrl-S": () => this.saveActive(),
      },
    });
    this._cm.on("change", () => {
      const f = this._files[this._active];
      if (f && f.doc && !f.dirty) {
        f.dirty = true;
        this.renderTabs();
      }
    });
    return this._cm;
  },

  modeFor(name) {
    const ext = name.split(".").pop().toLowerCase();
    return this.MODES[ext] || "text/plain";
  },

  async openFile(path) {
    const existing = this._files.findIndex((f) => f.path === path);
    if (existing >= 0) {
      this.switchTab(existing);
      return;
    }
    const name0 = path.split("/").pop();
    const kind = this.MEDIA[name0.split(".").pop().toLowerCase()];
    if (kind) {
      this._files.push({ path, name: name0, media: kind, dirty: false });
      this.switchTab(this._files.length - 1);
      return;
    }
    let r;
    try {
      r = await OmniNative.request("ce.read", JSON.stringify({ path }), 15000);
    } catch (e) {
      return;
    }
    if (!r || !r.ok) {
      this.flash(r && r.binary ? "BINARY FILE \u2014 NOT EDITABLE"
        : r && r.tooBig ? "FILE OVER 5MB" : "READ FAILED", "alert");
      return;
    }
    const cm = this.ensureCM();
    if (!cm) return;
    const name = path.split("/").pop();
    const mode = this.modeFor(name);
    const doc = window.CodeMirror.Doc(r.text, mode);
    this._files.push({ path, name, doc, dirty: false });
    this.switchTab(this._files.length - 1);
  },

  switchTab(i) {
    const f = this._files[i];
    if (!f) return;
    this._active = i;
    this.els.editorEmpty.hidden = true;
    if (f.media) {
      this.showViewer(f);
    } else {
      this.els.viewer.hidden = true;
      this.els.viewer.textContent = "";
      const cm = this.ensureCM();
      cm.swapDoc(f.doc);
      setTimeout(() => cm.refresh(), 0);
      cm.focus();
    }
    this.renderTabs();
  },

  // 이미지/오디오/비디오 뷰어 — omni://local/__media__ 로 열린 폴더 안 파일 서빙
  showViewer(f) {
    const v = this.els.viewer;
    v.textContent = "";
    v.hidden = false;
    if (!OmniNative.available) {
      const note = document.createElement("div");
      note.className = "r3d-drop-sub";
      note.textContent = "MEDIA VIEWER REQUIRES THE NATIVE APP";
      v.appendChild(note);
      return;
    }
    const src = `omni://local/__media__?p=${encodeURIComponent(f.path)}`;
    let el;
    if (f.media === "image") {
      el = document.createElement("img");
      el.src = src;
      el.alt = f.name;
    } else if (f.media === "audio") {
      el = document.createElement("audio");
      el.controls = true;
      el.src = src;
    } else {
      el = document.createElement("video");
      el.controls = true;
      el.src = src;
    }
    el.addEventListener("error", () => {
      v.textContent = "";
      const note = document.createElement("div");
      note.className = "r3d-drop-sub";
      note.textContent = "CANNOT PREVIEW THIS FILE (EMPTY OR UNSUPPORTED CODEC)";
      v.appendChild(note);
      v.appendChild(meta());
    });
    const meta = () => {
      const m = document.createElement("div");
      m.className = "ce-viewer-meta";
      m.textContent = `${f.media.toUpperCase()} \u00b7 ${f.name}`;
      return m;
    };
    v.appendChild(el);
    v.appendChild(meta());
  },

  closeTab(i) {
    this._files.splice(i, 1);
    if (this._files.length === 0) {
      this._active = -1;
      this.els.editorEmpty.hidden = false;
      this.els.viewer.hidden = true;
      this.els.viewer.textContent = "";
      if (this._cm) this._cm.swapDoc(window.CodeMirror.Doc("", "text/plain"));
      this.renderTabs();
      return;
    }
    this.switchTab(Math.min(i, this._files.length - 1));
  },

  renderTabs() {
    const bar = this.els.tabs;
    bar.hidden = this._files.length === 0;
    bar.textContent = "";
    this._files.forEach((f, i) => {
      const tab = document.createElement("div");
      tab.className = `r3d-tab${i === this._active ? " active" : ""}`;
      const label = document.createElement("span");
      label.className = "r3d-tab-label";
      label.textContent = (f.dirty ? "\u25CF " : "") + f.name;
      label.title = f.path;
      const x = document.createElement("span");
      x.className = "r3d-tab-x";
      x.textContent = "\u2715";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeTab(i);
      });
      tab.append(label, x);
      tab.addEventListener("click", () => this.switchTab(i));
      bar.appendChild(tab);
    });
  },

  async saveActive() {
    const f = this._files[this._active];
    if (!f || !f.doc) return; // 미디어 탭은 저장 대상 아님
    try {
      const r = await OmniNative.request("ce.write",
        JSON.stringify({ path: f.path, data: f.doc.getValue() }), 15000);
      if (r && r.ok) {
        f.dirty = false;
        this.renderTabs();
        this.flash(`SAVED ${f.name}`, "ok");
      } else {
        this.flash("SAVE FAILED", "alert");
      }
    } catch (e) {
      this.flash("SAVE FAILED", "alert");
    }
  },

  // ── 터미널 (xterm.js + 네이티브 PTY) ──
  async newTerm() {
    if (typeof window.Terminal === "undefined") return;
    this.els.termhost.hidden = false;
    this.els.termToggle.textContent = "\u25BE";
    const el = document.createElement("div");
    el.className = "ce-terminal";
    this.els.termhost.appendChild(el);
    const term = new window.Terminal({
      fontFamily: "'Share Tech Mono', Menlo, monospace",
      fontSize: 12,
      cursorBlink: true,
      theme: {
        background: "#020813",
        foreground: "#bfe9f7",
        cursor: "#35d6ff",
        selectionBackground: "rgba(53, 214, 255, 0.3)",
      },
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const entry = { tid: null, term, fit, el, dead: false, n: ++this._termN };
    this._terms.push(entry);
    this.switchTerm(this._terms.length - 1);
    fit.fit();
    try {
      const r = await OmniNative.request("ce.termOpen", JSON.stringify({
        path: this._root || "", cols: term.cols, rows: term.rows,
      }), 10000);
      if (!r || !r.ok) throw new Error("term open failed");
      entry.tid = r.tid;
      term.onData((d) => {
        const bytes = new TextEncoder().encode(d);
        let bin = "";
        bytes.forEach((b) => { bin += String.fromCharCode(b); });
        OmniNative.request("ce.termWrite", JSON.stringify({
          tid: entry.tid, data: btoa(bin),
        })).catch(() => {});
      });
      term.onResize(({ cols, rows }) => {
        OmniNative.request("ce.termResize", JSON.stringify({
          tid: entry.tid, cols, rows,
        })).catch(() => {});
      });
      term.focus();
    } catch (e) {
      entry.dead = true;
      term.write("\x1b[38;5;203mTERMINAL UNAVAILABLE (NATIVE APP ONLY)\x1b[0m");
    }
    this.renderTermTabs();
  },

  switchTerm(i) {
    this._termActive = i;
    this._terms.forEach((t, k) => t.el.classList.toggle("active", k === i));
    this.renderTermTabs();
    const t = this._terms[i];
    if (t) {
      setTimeout(() => {
        t.fit.fit();
        t.term.focus();
      }, 0);
    }
  },

  closeTerm(i) {
    const t = this._terms[i];
    if (!t) return;
    if (t.tid != null) {
      OmniNative.request("ce.termClose", JSON.stringify({ tid: t.tid }))
        .catch(() => {});
    }
    t.term.dispose();
    t.el.remove();
    this._terms.splice(i, 1);
    if (this._terms.length === 0) {
      this._termActive = -1;
      this.els.termhost.hidden = true;
      this.els.termToggle.textContent = "\u25B4";
    } else {
      this.switchTerm(Math.min(i, this._terms.length - 1));
    }
    this.renderTermTabs();
  },

  renderTermTabs() {
    const bar = this.els.termtabs;
    bar.textContent = "";
    this._terms.forEach((t, i) => {
      const tab = document.createElement("span");
      tab.className = `ce-termtab${i === this._termActive ? " active" : ""}`
        + (t.dead ? " dead" : "");
      const label = document.createElement("span");
      label.textContent = `TERM ${t.n}`;
      const x = document.createElement("span");
      x.className = "x";
      x.textContent = "\u2715";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeTerm(i);
      });
      tab.append(label, x);
      tab.addEventListener("click", () => this.switchTerm(i));
      bar.appendChild(tab);
    });
  },

  toggleTerms() {
    const host = this.els.termhost;
    host.hidden = !host.hidden;
    this.els.termToggle.textContent = host.hidden ? "\u25B4" : "\u25BE";
    if (!host.hidden) this.fitTerms();
  },

  fitTerms() {
    const t = this._terms[this._termActive];
    if (t && !this.els.termhost.hidden) {
      try { t.fit.fit(); } catch (e) {}
    }
  },

  resize() {
    if (this._cm) this._cm.refresh();
    this.fitTerms();
  },
});

// ---------- module: ARC-SCAN (rotating ToF lidar point cloud) ----------
// ESP32 streams {"a": servoAngle 0-180, "d": [7 distances mm]} over ws://ip:81.
// Sensor channels 0(top)..6(bottom) are tilted +30..-30 deg on the mast.
// In the app the socket is relayed natively (plain ws:// is mixed content for
// the omni:// secure origin); in a browser it falls back to a JS WebSocket.
OmniOS.register("arc", {
  TILTS: [30, 20, 10, 0, -10, -20, -30],
  CH_SHADES: [0xeafcff, 0xbfeaff, 0x8fdcff, 0x35d6ff, 0x2fa8d8, 0x2b86b8, 0x275f8e],
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
    this.initWorkspaces();
    const $ = (id) => document.getElementById(id);
    this.els = {
      panel: $("panel-arc"),
      viewport: $("arc-viewport"),
      status: $("arc-status"),
      stats: $("arc-stats"),
      analytics: $("arc-analytics"),
      hist: $("arc-hist"),
      asMean: $("as-mean"),
      asMed: $("as-med"),
      asStd: $("as-std"),
      asValid: $("as-valid"),
      asSweeps: $("as-sweeps"),
      asRoom: $("as-room"),
      modes: $("arc-modes"),
      plan: $("arc-plan"),
      planCv: $("arc-plan-cv"),
      planArea: $("arc-plan-area"),
      savePly: $("arc-save"),
      toR3d: $("arc-to-r3d"),
      exp: $("arc-exp"),
      cmodes: $("arc-cmodes"),
      paint: $("arc-paint"),
      note: $("arc-note"),
      cplan: $("arc-cplan"),
      tabs: $("arc-tabs"),
      cplanCv: $("arc-cplan-cv"),
      creset: $("arc-creset"),
      recent: $("arc-recent"),
      load: $("arc-load"),
      loadInput: $("arc-load-input"),
      side: $("arc-side"),
      hint: $("arc-hint"),
      ip: $("arc-ip"),
      connect: $("arc-connect"),
      start: $("arc-start"),
      stop: $("arc-stop"),
      center: $("arc-center"),
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
    this.els.start.addEventListener("click", () => this.sendCmd("start"));
    this.els.modes.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => this.toggleLayer(b.dataset.mode)));
    this.els.savePly.addEventListener("click", () => this.exportPly(false));
    this.els.toR3d.addEventListener("click", () => this.exportPly(true));
    this.els.cmodes.querySelectorAll("button[data-cmode]").forEach((b) =>
      b.addEventListener("click", () => this.setColorMode(b.dataset.cmode)));
    this.els.creset.addEventListener("click", () => this.resetColors());
    this.els.paint.addEventListener("input", () => this.applyPaint());
    this.els.cplan.querySelectorAll(".cplan-sw").forEach((b) =>
      b.addEventListener("click", () => {
        this.els.paint.value = b.dataset.c;
        this.applyPaint();
      }));
    this.els.load.addEventListener("click", () => this.els.loadInput.click());
    this.els.viewport.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    this.els.viewport.addEventListener("drop", async (e) => {
      e.preventDefault();
      for (const f of Array.from(e.dataTransfer.files)) {
        if (!/\.ply$/i.test(f.name)) continue;
        await this.loadPlyCloud(await f.arrayBuffer(), f.name);
      }
    });
    this.els.loadInput.addEventListener("change", async () => {
      const f = this.els.loadInput.files && this.els.loadInput.files[0];
      this.els.loadInput.value = "";
      if (!f) return;
      const buf = await f.arrayBuffer();
      await this.loadPlyCloud(buf, f.name);
    });
    this.refreshRecents();

    // drag on either plan (FLOOR PLAN isolates, COLOR PLAN paints);
    // a plain click clears the selection
    const bindPlan = (cv) => {
      cv.addEventListener("mousedown", (e) => {
        this._dragCv = cv;
        this._dragStart = this.planXY(e, cv);
        this._dragCur = this._dragStart;
      });
      cv.addEventListener("mousemove", (e) => {
        if (!this._dragStart || this._dragCv !== cv) return;
        this._dragCur = this.planXY(e, cv);
        this.renderPlan();
        this.renderCPlan();
      });
    };
    bindPlan(this.els.planCv);
    bindPlan(this.els.cplanCv);
    window.addEventListener("mouseup", (e) => {
      if (!this._dragStart) return;
      const a = this._dragStart;
      const cv2 = this._dragCv;
      const b = this.planXY(e, cv2);
      this._dragStart = null;
      this._dragCur = null;
      this._dragCv = null;
      const sel = Math.hypot(b.px - a.px, b.pz - a.pz) < 6 ? null : {
        x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x),
        z0: Math.min(a.z, b.z), z1: Math.max(a.z, b.z),
      };
      if (cv2 === this.els.cplanCv) this.setPaintSel(sel); // COLOR PLAN paints
      else this.setSelection(sel);                          // FLOOR PLAN isolates
      this.renderPlan();
      this.renderCPlan();
    });
    this.resetStats();
    this.els.stop.addEventListener("click", () => this.sendCmd("stop"));
    this.els.center.addEventListener("click", () => this.sendCmd("center"));
    this.els.size.addEventListener("input", () => {
      if (this._ctx) this._ctx.material.size = parseFloat(this.els.size.value) / 100;
    });
    this.buildSide();
    this.initPanelResize(); // after buildSide — it wipes arc-side's children

    // native relay pushes messages/states here
    window.OmniArc = {
      _msg: (m) => this.onMessage(m),
      _state: (s) => {
        if (s === "open") this.onOpen();
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
    renderer.localClippingEnabled = true; // PLAN region selection clips the scene
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

    // point cloud (preallocated ring buffer, backed by the active workspace)
    const positions = this.activeWs().positions;
    const colors = this.activeWs().colors;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setDrawRange(0, this._count);
    const material = new THREE.PointsMaterial({
      size: parseFloat(this.els.size.value) / 100,
      vertexColors: true,
      sizeAttenuation: true,
    });
    const cloud = new THREE.Points(geo, material);
    cloud.frustumCulled = false;
    scene.add(cloud);

    this._ctx = { renderer, scene, camera, controls, geo, positions, colors, material, azLine, cloud };
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
      this._ws.onopen = () => this.onOpen();
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
    this._streaming = false;
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

  onOpen() {
    if (!this._enabled) return;
    this._linked = true;
    this._streaming = false;
    this.setStatus("LINKED \u00b7 PRESS START SCAN", "ok");
    this.els.navDot.className = "nav-dot ok";
    this.els.hint.hidden = true;
    this.els.side.hidden = false;
    this.els.analytics.hidden = false;
  },

  sendCmd(cmd) {
    if (!this._linked) return;
    if (OmniNative.available) {
      OmniNative.request("arc.send", cmd).catch(() => {});
    } else if (this._ws && this._ws.readyState === 1) {
      this._ws.send(cmd);
    }
    if (cmd === "start") this.setStatus("LINKED \u00b7 SCANNING\u2026", "ok");
    if (cmd === "stop") this.setStatus("LINKED \u00b7 PAUSED", "ok");
    if (cmd === "center") this.setStatus("LINKED \u00b7 SERVO CENTERED", "ok");
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
    if (!this._linked || !this._streaming) {
      this._linked = true;
      this._streaming = true;
      this.setStatus("LINKED \u00b7 STREAMING", "ok");
      this.els.navDot.className = "nav-dot ok";
      this.els.hint.hidden = true;
      this.els.side.hidden = false;
    }
    const a = typeof msg.a === "number" ? msg.a : 0;
    const az = Math.max(0, Math.min(180, Math.round(a)));
    const L = this.liveWs(); // stream accumulates here even while another tab is viewed
    for (let ch = 0; ch < Math.min(7, msg.d.length); ch++) {
      const mm = msg.d[ch];
      this.updateChannel(ch, mm);
      const valid = typeof mm === "number" && mm >= this.MIN_MM && mm <= this.MAX_MM;
      const S = L.st;
      S.total++;
      if (valid) {
        const p = this.addPoint(L, a, ch, mm);
        // latest-sweep grid (LINE/RETOUCH modes rebuild from this)
        const gi = ch * 181 + az;
        L.grid[gi * 3] = p.x;
        L.grid[gi * 3 + 1] = p.y;
        L.grid[gi * 3 + 2] = p.z;
        L.gridOk[gi] = 1;
        // running stats + histograms
        S.n++;
        S.sum += mm;
        S.sumsq += mm * mm;
        S.histD[Math.min(24, Math.floor(mm / 160))]++;
        S.histY[Math.max(0, Math.min(79, Math.floor((p.y + 0.5) / 4 * 80)))]++;
        S.histX[Math.max(0, Math.min(79, Math.floor((p.x + 4) / 8 * 80)))]++;
        S.histZ[Math.max(0, Math.min(79, Math.floor((p.z + 4) / 8 * 80)))]++;
        if (p.y > 0.15 && p.y < 2.3) { // walls & furniture, not floor/ceiling
          const cx = Math.floor((p.x + 4) / 8 * 160);
          const cz = Math.floor((p.z + 4) / 8 * 160);
          if (cx >= 0 && cx < 160 && cz >= 0 && cz < 160) {
            const oi = cz * 160 + cx;
            if (L.occ[oi] < 65535) L.occ[oi]++;
          }
        }
      } else {
        L.gridOk[ch * 181 + az] = 0;
      }
    }
    // sweep counter: count each time the servo reaches an end stop
    if ((az === 0 || az === 180) && this._lastEdge !== az) {
      this._lastEdge = az;
      L.st.edges++;
    }
    const nowMs = performance.now();
    if (nowMs - (this._anAt || 0) > 500 && this.activeWs().live) {
      this._anAt = nowMs;
      this.renderAnalytics();
      if (this._layers.line) this.buildLines();
      if (this._layers.retouch) this.buildRoom();
      if (this._layers.plan) this.renderPlan();
      this.renderCPlan();
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

  addPoint(ws, aDeg, ch, mm) {
    const c = this._ctx;
    if (!c) return;
    const th = (this.TILTS[ch] * Math.PI) / 180;   // elevation
    const ph = (aDeg * Math.PI) / 180;             // azimuth
    const r = mm / 1000;
    const horiz = r * Math.cos(th);
    const x = horiz * Math.cos(ph);
    const z = -horiz * Math.sin(ph);
    const y = r * Math.sin(th) + this.CH_HEIGHTS[ch];

    const i = ws.writeIdx;
    ws.positions[i * 3] = x;
    ws.positions[i * 3 + 1] = y;
    ws.positions[i * 3 + 2] = z;

    this.styleColor(x, y, z, ws.colors, i * 3, ws.paintLog);

    ws.writeIdx = (ws.writeIdx + 1) % this.MAX_POINTS;
    ws.count = Math.min(ws.count + 1, this.MAX_POINTS);
    if (ws === this.activeWs()) {
      c.geo.attributes.position.needsUpdate = true;
      c.geo.attributes.color.needsUpdate = true;
      c.geo.setDrawRange(0, ws.count);
    }
    return { x, y, z };
  },

  // ── color modes: CUSTOM (paint plan regions) / DIST (range from CH3) /
  // ORIGINAL (the original arc-scan web viewer's height rainbow) ──
  _cmode: "custom",
  _paint: null,

  hsl2rgb(h, s, l, out, o) {
    const hue2 = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    out[o] = hue2(p, q, h + 1 / 3);
    out[o + 1] = hue2(p, q, h);
    out[o + 2] = hue2(p, q, h - 1 / 3);
  },

  pointColor(x, y, z, out, o) {
    if (this._cmode === "dist") {
      // euclidean range from the CH3 (0-tilt) sensor, blue near -> red far
      const d = Math.hypot(x, y - this.CH_HEIGHTS[3], z);
      const t = Math.max(0, Math.min(1, d / 4));
      this.hsl2rgb(0.66 * (1 - t), 0.9, 0.55, out, o);
      return;
    }
    if (this._cmode === "original") {
      // arc-scan web viewer: 0m blue -> 2.5m red by height
      const t = Math.max(0, Math.min(1, y / 2.5));
      this.hsl2rgb(0.66 * (1 - t), 0.9, 0.55, out, o);
      return;
    }
    // CUSTOM base: HUD ramp — deep blue (floor) -> cyan -> near-white (ceiling)
    const t = Math.max(0, Math.min(1, y / 2.4));
    if (t < 0.5) {
      const k = t / 0.5;
      out[o] = 0.04 + (0.21 - 0.04) * k;
      out[o + 1] = 0.29 + (0.84 - 0.29) * k;
      out[o + 2] = 0.43 + (1.0 - 0.43) * k;
    } else {
      const k = (t - 0.5) / 0.5;
      out[o] = 0.21 + (0.92 - 0.21) * k;
      out[o + 1] = 0.84 + (0.99 - 0.84) * k;
      out[o + 2] = 1.0;
    }
  },

  // applied CUSTOM edits, replayed onto points, LINE, RETOUCH and new samples
  _paintLog: [],

  styleColor(x, y, z, out, o, log) {
    this.pointColor(x, y, z, out, o);
    if (this._cmode !== "custom") return;
    for (const P of (log || this._paintLog)) {
      if (x >= P.x0 && x <= P.x1 && z >= P.z0 && z <= P.z1) {
        out[o] = P.c[0];
        out[o + 1] = P.c[1];
        out[o + 2] = P.c[2];
      }
    }
  },

  recolorAll() {
    const c = this._ctx;
    if (!c) return;
    for (let i = 0; i < this._count; i++) {
      this.styleColor(c.positions[i * 3], c.positions[i * 3 + 1], c.positions[i * 3 + 2],
        c.colors, i * 3);
    }
    c.geo.attributes.color.needsUpdate = true;
  },

  retintLayers() {
    if (this._layers.line) this.buildLines();
    if (this._layers.retouch) this.buildRoom();
  },

  syncColorUi() {
    const m = this._cmode;
    this.els.cmodes.querySelectorAll("button[data-cmode]").forEach((b) =>
      b.classList.toggle("active", b.dataset.cmode === m));
    this.els.cplan.hidden = m !== "custom";
    this.els.note.textContent = m === "custom"
      ? "CUSTOM \u00b7 DRAG COLOR PLAN \u2192 PICK COLOR"
      : m === "dist"
        ? "COLORED BY DISTANCE FROM CH3"
        : "ORIGINAL VIEWER \u00b7 HEIGHT RAINBOW";
  },

  setColorMode(m) {
    if (this._cmode === m) return;
    this.setPaintSel(null); // pending paint highlight is mode-specific; isolation stays
    this._cmode = m;
    this.syncColorUi();
    this.recolorAll();
    this.retintLayers();
    if (this._layers.plan) this.renderPlan();
    this.renderCPlan();
  },

  // RESET: back to the signature HUD hologram ramp, custom edits wiped
  resetColors() {
    this.setPaintSel(null);
    this._paintLog = [];
    this._cmode = "custom";
    this.syncColorUi();
    this.recolorAll();
    this.retintLayers();
    if (this._layers.plan) this.renderPlan();
    this.renderCPlan();
    this.els.note.textContent = "HUD HOLOGRAM RESTORED";
  },

  // pending paint selection: indices + saved colors, highlighted until painted
  buildPaintSet() {
    const c = this._ctx;
    if (!c) return;
    const idx = [];
    for (let i = 0; i < this._count; i++) {
      if (this.inCSel(c.positions[i * 3], c.positions[i * 3 + 2])) idx.push(i);
    }
    if (!idx.length) return;
    const old = new Float32Array(idx.length * 3);
    idx.forEach((p, k) => {
      for (let d = 0; d < 3; d++) {
        old[k * 3 + d] = c.colors[p * 3 + d];
        c.colors[p * 3 + d] += (1 - c.colors[p * 3 + d]) * 0.6; // lift toward white
      }
    });
    c.geo.attributes.color.needsUpdate = true;
    this._paint = { idx, old, applied: false };
  },

  dropPaint(restore) {
    const P = this._paint, c = this._ctx;
    this._paint = null;
    if (!P || !c) return;
    if (restore && !P.applied) {
      P.idx.forEach((p, k) => {
        c.colors[p * 3] = P.old[k * 3];
        c.colors[p * 3 + 1] = P.old[k * 3 + 1];
        c.colors[p * 3 + 2] = P.old[k * 3 + 2];
      });
      c.geo.attributes.color.needsUpdate = true;
    }
  },

  applyPaint() {
    const P = this._paint, c = this._ctx;
    if (!P || !c) return;
    const hex = this.els.paint.value;
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    P.idx.forEach((p) => {
      c.colors[p * 3] = r;
      c.colors[p * 3 + 1] = g;
      c.colors[p * 3 + 2] = b;
    });
    P.applied = true;
    // log the edit so LINE/RETOUCH and future samples pick it up too
    const s = this._csel;
    if (s) {
      const entry = { x0: s.x0, x1: s.x1, z0: s.z0, z1: s.z1, c: [r, g, b] };
      if (P.logIdx != null) this._paintLog[P.logIdx] = entry;
      else P.logIdx = this._paintLog.push(entry) - 1;
    }
    c.geo.attributes.color.needsUpdate = true;
    this.retintLayers();
  },

  // ── floating panel resize: corner grip drag, double-click resets,
  // widths persist in localStorage ──
  initPanelResize() {
    let store = {};
    try { store = JSON.parse(localStorage.getItem("omni.arc.panelW") || "{}"); } catch (e) {}
    const save = () => {
      try { localStorage.setItem("omni.arc.panelW", JSON.stringify(store)); } catch (e) {}
    };
    const cfg = [
      { el: this.els.analytics, key: "an", corner: "br", min: 200, max: 480,
        onSize: () => this.renderAnalytics() },
      { el: this.els.side, key: "side", corner: "bl", min: 215, max: 520 },
      { el: this.els.plan, key: "plan", corner: "tr", min: 170, max: 560,
        onSize: () => this.renderPlan() },
      { el: this.els.cplan, key: "cplan", corner: "tl", min: 190, max: 560,
        onSize: () => this.renderCPlan() },
    ];
    for (const p of cfg) {
      if (!p.el) continue;
      const grip = document.createElement("div");
      grip.className = `arc-grip arc-grip-${p.corner}`;
      grip.title = "DRAG TO RESIZE \u00b7 DOUBLE-CLICK TO RESET";
      p.el.appendChild(grip);
      const apply = (w) => {
        if (w == null) {
          p.el.style.width = "";
        } else {
          w = Math.max(p.min, Math.min(p.max, Math.round(w)));
          p.el.style.width = `${w}px`;
        }
        if (p.onSize) p.onSize();
        return w;
      };
      if (store[p.key]) apply(store[p.key]);
      grip.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const sx = e.clientX;
        const sw = p.el.getBoundingClientRect().width;
        const dir = (p.corner === "br" || p.corner === "tr") ? 1 : -1;
        const move = (ev) => { store[p.key] = apply(sw + (ev.clientX - sx) * dir); };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          save();
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      });
      grip.addEventListener("dblclick", () => {
        delete store[p.key];
        apply(null);
        save();
      });
    }
  },

  // ── PLAN region selection: drag a rectangle to isolate that area in 3D ──
  _sel: null,
  _clip: null,

  planXY(e, cv) {
    cv = cv || this.els.planCv;
    const r = cv.getBoundingClientRect();
    const px = (e.clientX - r.left) * (cv.width / r.width);
    const pz = (e.clientY - r.top) * (cv.height / r.height);
    return { px, pz, x: (px / cv.width) * 8 - 4, z: (pz / cv.height) * 8 - 4 };
  },

  setSelection(sel) {
    this._sel = sel;
    if (sel && this._three) {
      const THREE = this._three.THREE;
      this._clip = [
        new THREE.Plane(new THREE.Vector3(1, 0, 0), -sel.x0),
        new THREE.Plane(new THREE.Vector3(-1, 0, 0), sel.x1),
        new THREE.Plane(new THREE.Vector3(0, 0, 1), -sel.z0),
        new THREE.Plane(new THREE.Vector3(0, 0, -1), sel.z1),
      ];
    } else {
      this._clip = null;
    }
    // apply to every scanned-content material (grid/mast stay visible)
    const apply = (m) => { m.clippingPlanes = this._clip; m.needsUpdate = true; };
    if (this._ctx) apply(this._ctx.material);
    if (this._lineSegs) for (const s of this._lineSegs) apply(s.material);
    if (this._roomGroup) this._roomGroup.traverse((o) => o.material && apply(o.material));
  },

  // COLOR PLAN's own selection — paints, never hides
  _csel: null,

  inCSel(x, z) {
    const s = this._csel;
    return !s || (x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1);
  },

  setPaintSel(sel) {
    this._csel = sel;
    this.dropPaint(true); // un-highlight a previous unpainted selection
    if (sel) this.buildPaintSet();
  },

  inSel(x, z) {
    const s = this._sel;
    return !s || (x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1);
  },

  // ── PLAN: occupancy-grid 2D floor plan minimap ──
  renderPlan() {
    const area = this.drawPlan(this.els.planCv);
    if (area == null) return;
    this.els.planArea.textContent = this._sel
      ? "REGION SELECTED \u00b7 CLICK TO CLEAR"
      : `EST AREA ${Math.abs(area).toFixed(1)} M\u00b2`;
  },

  // CUSTOM's dedicated paint minimap (bottom-right, next to the color picker)
  renderCPlan() {
    if (!this.els.cplan || this.els.cplan.hidden) return;
    this.drawPlan(this.els.cplanCv);
  },

  drawPlan(cv) {
    if (!cv) return null;
    const dpr = window.devicePixelRatio || 1;
    const disp = Math.round(cv.clientWidth);
    const bpx = Math.round(disp * dpr);
    if (disp && cv.width !== bpx) {
      cv.width = bpx;
      cv.height = bpx;
    }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // CSS px 좌표계 — 레티나 선명
    const W = disp || cv.width, H = disp || cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "rgba(2, 8, 19, 0.9)";
    ctx.fillRect(0, 0, W, H);
    // fine grid
    ctx.strokeStyle = "rgba(53, 214, 255, 0.08)";
    for (let m = 0; m <= 8; m++) {
      const t = (m / 8) * W;
      ctx.beginPath(); ctx.moveTo(t, 0); ctx.lineTo(t, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, t); ctx.lineTo(W, t); ctx.stroke();
    }
    // occupancy cells (log intensity)
    const cell = W / 160;
    for (let cz = 0; cz < 160; cz++) {
      for (let cx = 0; cx < 160; cx++) {
        const n = this._occ[cz * 160 + cx];
        if (!n) continue;
        const a = Math.min(1, 0.25 + Math.log2(1 + n) / 6);
        ctx.fillStyle = `rgba(53, 214, 255, ${a.toFixed(2)})`;
        ctx.fillRect(cx * cell, cz * cell, Math.max(1, cell), Math.max(1, cell));
      }
    }
    // estimated room outline + area (shoelace: origin + outline fan)
    const ceilY = this.histTop(this._st.histY, -0.5, 3.5, 5) || 2.4;
    const out = this.computeOutline(ceilY);
    const toPx = (x, z) => [((x + 4) / 8) * W, ((z + 4) / 8) * H];
    ctx.strokeStyle = "rgba(61, 255, 168, 0.85)";
    ctx.lineWidth = 1.5;
    let area = 0, prev = null, started = false;
    ctx.beginPath();
    for (let az = 0; az <= 180; az++) {
      const r = out[az];
      if (r == null) { prev = null; continue; }
      const ph = (az * Math.PI) / 180;
      const x = r * Math.cos(ph), z = -r * Math.sin(ph);
      const [px, pz] = toPx(x, z);
      if (!started || prev == null) { ctx.moveTo(px, pz); started = true; }
      else ctx.lineTo(px, pz);
      if (prev) area += (prev.x * z - x * prev.z) / 2; // fan triangles from origin
      prev = { x, z };
    }
    ctx.stroke();
    // scanner marker
    const [ox, oz] = toPx(0, 0);
    ctx.fillStyle = "#35d6ff";
    ctx.beginPath(); ctx.arc(ox, oz, 3, 0, 7); ctx.fill();
    // active region selection (amber) / in-progress drag (dashed white)
    const drawRect = (x0, z0, x1, z1, stroke, dash) => {
      const [ax, az] = toPx(x0, z0);
      const [bx, bz] = toPx(x1, z1);
      ctx.save();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.2;
      if (dash) ctx.setLineDash([4, 3]);
      ctx.strokeRect(Math.min(ax, bx), Math.min(az, bz), Math.abs(bx - ax), Math.abs(bz - az));
      ctx.restore();
    };
    const isColor = cv === this.els.cplanCv;
    if (!isColor && this._sel) {
      drawRect(this._sel.x0, this._sel.z0, this._sel.x1, this._sel.z1, "rgba(255, 200, 87, 0.9)", false);
    }
    if (isColor && this._csel) {
      drawRect(this._csel.x0, this._csel.z0, this._csel.x1, this._csel.z1,
        "rgba(234, 252, 255, 0.9)", false);
    }
    if (this._dragStart && this._dragCur && this._dragCv === cv) {
      drawRect(this._dragStart.x, this._dragStart.z, this._dragCur.x, this._dragCur.z,
        "rgba(234, 252, 255, 0.8)", true);
    }
    return area;
  },

  // ── PLY export: binary little-endian. POINT = colored point cloud,
  // LINE = latest-sweep vertices + edge elements, RETOUCH = wall shell mesh.
  // An active PLAN region selection filters POINT/LINE exports. ──
  plyHeader(nVerts, extra) {
    return "ply\nformat binary_little_endian 1.0\n" +
      `element vertex ${nVerts}\n` +
      "property float x\nproperty float y\nproperty float z\n" +
      "property uchar red\nproperty uchar green\nproperty uchar blue\n" +
      (extra || "") +
      "end_header\n";
  },

  buildPlyBlob(kind) {
    if (!this._ctx) return null;
    const enc = (s) => new TextEncoder().encode(s);

    if (kind === "line") {
      // vertices from the latest-sweep grid, edges between azimuth neighbors
      const verts = [];
      const edges = [];
      const map = new Int32Array(7 * 181).fill(-1);
      const tmpc = new Float32Array(3);
      for (let ch = 0; ch < 7; ch++) {
        for (let az = 0; az <= 180; az++) {
          const gi = ch * 181 + az;
          if (!this._gridOk[gi]) continue;
          const x = this._grid[gi * 3], y = this._grid[gi * 3 + 1], z = this._grid[gi * 3 + 2];
          if (!this.inSel(x, z)) continue;
          this.styleColor(x, y, z, tmpc, 0);
          map[gi] = verts.length;
          verts.push([x, y, z,
            Math.round(tmpc[0] * 255), Math.round(tmpc[1] * 255), Math.round(tmpc[2] * 255)]);
          if (az > 0 && map[gi - 1] >= 0) edges.push([map[gi - 1], map[gi]]);
        }
      }
      if (!verts.length) return null;
      const head = enc(this.plyHeader(verts.length,
        `element edge ${edges.length}\nproperty int vertex1\nproperty int vertex2\n`));
      const body = new ArrayBuffer(verts.length * 15 + edges.length * 8);
      const dv = new DataView(body);
      verts.forEach((v, i) => {
        const o = i * 15;
        dv.setFloat32(o, v[0], true);
        dv.setFloat32(o + 4, v[1], true);
        dv.setFloat32(o + 8, v[2], true);
        dv.setUint8(o + 12, v[3]);
        dv.setUint8(o + 13, v[4]);
        dv.setUint8(o + 14, v[5]);
      });
      const eo = verts.length * 15;
      edges.forEach((e, i) => {
        dv.setInt32(eo + i * 8, e[0], true);
        dv.setInt32(eo + i * 8 + 4, e[1], true);
      });
      return new Blob([head, body], { type: "application/octet-stream" });
    }

    if (kind === "retouch") {
      // estimated room shell as a real triangle mesh
      const ceilY = this.histTop(this._st.histY, -0.5, 3.5, 5) || 2.4;
      const smooth = this.computeOutline(ceilY);
      const verts = [];
      const faces = [];
      let prevBase = -1;
      for (let az = 0; az <= 180; az++) {
        const r = smooth[az];
        if (r == null) { prevBase = -1; continue; }
        const ph = (az * Math.PI) / 180;
        const x = r * Math.cos(ph), z = -r * Math.sin(ph);
        const base = verts.length;
        verts.push([x, 0.02, z], [x, ceilY, z]);
        if (prevBase >= 0) {
          faces.push([prevBase, prevBase + 1, base], [prevBase + 1, base + 1, base]);
        }
        prevBase = base;
      }
      if (!verts.length) return null;
      const head = enc(this.plyHeader(verts.length,
        `element face ${faces.length}\nproperty list uchar int vertex_indices\n`));
      const body = new ArrayBuffer(verts.length * 15 + faces.length * 13);
      const dv = new DataView(body);
      const tmpc = new Float32Array(3);
      verts.forEach((v, i) => {
        const o = i * 15;
        dv.setFloat32(o, v[0], true);
        dv.setFloat32(o + 4, v[1], true);
        dv.setFloat32(o + 8, v[2], true);
        this.styleColor(v[0], v[1], v[2], tmpc, 0);
        dv.setUint8(o + 12, Math.round(tmpc[0] * 255));
        dv.setUint8(o + 13, Math.round(tmpc[1] * 255));
        dv.setUint8(o + 14, Math.round(tmpc[2] * 255));
      });
      const fo = verts.length * 15;
      faces.forEach((f, i) => {
        const o = fo + i * 13;
        dv.setUint8(o, 3);
        dv.setInt32(o + 1, f[0], true);
        dv.setInt32(o + 5, f[1], true);
        dv.setInt32(o + 9, f[2], true);
      });
      return new Blob([head, body], { type: "application/octet-stream" });
    }

    // POINT (default): the accumulated cloud
    const P = this._ctx.positions, C = this._ctx.colors;
    const idx = [];
    for (let i = 0; i < this._count; i++) {
      if (this.inSel(P[i * 3], P[i * 3 + 2])) idx.push(i);
    }
    if (!idx.length) return null;
    const head = enc(this.plyHeader(idx.length));
    const body = new ArrayBuffer(idx.length * 15);
    const dv = new DataView(body);
    idx.forEach((i, k) => {
      const o = k * 15;
      dv.setFloat32(o, P[i * 3], true);
      dv.setFloat32(o + 4, P[i * 3 + 1], true);
      dv.setFloat32(o + 8, P[i * 3 + 2], true);
      dv.setUint8(o + 12, Math.round(C[i * 3] * 255));
      dv.setUint8(o + 13, Math.round(C[i * 3 + 1] * 255));
      dv.setUint8(o + 14, Math.round(C[i * 3 + 2] * 255));
    });
    return new Blob([head, body], { type: "application/octet-stream" });
  },

  async exportPly(toR3d) {
    const kind = this.els.exp.value;
    const blob = this.buildPlyBlob(kind);
    if (!blob) return;
    const name = `arc_${kind}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.ply`;
    if (toR3d) {
      // panel-to-panel handoff: open the scan as a model in RENDER_3D
      const file = new File([blob], name);
      document.querySelector('.nav-item[data-panel="r3d"]').click();
      await OmniOS.modules.r3d.loadFiles([file]);
      return;
    }
    if (OmniNative.available) {
      const b64 = await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result.split(",")[1]);
        fr.readAsDataURL(blob);
      });
      try {
        const r = await OmniNative.request("arc.savePly",
          JSON.stringify({ name, data: b64 }), 120000);
        if (r && r.ok) {
          this.setStatus(`SAVED ${name}`, "ok");
          this.refreshRecents();
        } else {
          this.setStatus("PLY SAVE FAILED", "alert");
        }
      } catch (e) {
        this.setStatus("PLY SAVE FAILED", "alert");
      }
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
      this._sessionSaves.unshift({ name, blob });
      this._sessionSaves = this._sessionSaves.slice(0, 3);
      this.refreshRecents();
    }
  },

  // ── recents: 3 newest files in ARC-SCAN-SAVES, one click to reload ──
  _sessionSaves: [], // browser dev fallback (no filesystem)

  shortSaveName(n) {
    const m = n.match(/^arc_(\w+)_\d{4}-\d{2}-(\d{2})-(\d{2})-(\d{2})-\d{2}\.ply$/);
    return m ? `${m[1].toUpperCase()} ${m[2]}/${m[3]}:${m[4]}` : n.slice(0, 16);
  },

  async refreshRecents() {
    const box = this.els.recent;
    if (!box) return;
    let items = [];
    if (OmniNative.available) {
      try {
        const r = await OmniNative.request("arc.listSaves", null, 10000);
        items = ((r && r.files) || []).slice(0, 3);
      } catch (e) {}
    } else {
      items = this._sessionSaves.slice(0, 3);
    }
    box.textContent = "";
    if (!items.length) {
      const s = document.createElement("span");
      s.className = "arc-recent-empty";
      s.textContent = "\u2014";
      box.appendChild(s);
      return;
    }
    for (const it of items) {
      const b = document.createElement("button");
      b.className = "ig-tab";
      b.textContent = this.shortSaveName(it.name);
      b.title = it.name;
      b.addEventListener("click", () => this.openRecent(it));
      box.appendChild(b);
    }
  },

  async openRecent(it) {
    try {
      let buf;
      if (it.blob) {
        buf = await it.blob.arrayBuffer();
      } else {
        const r = await OmniNative.request("arc.readPly",
          JSON.stringify({ path: it.path }), 30000);
        if (!r || !r.data) throw new Error("read failed");
        const bin = atob(r.data);
        buf = new ArrayBuffer(bin.length);
        const u = new Uint8Array(buf);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      }
      await this.loadPlyCloud(buf, it.name);
    } catch (e) {
      this.setStatus("PLY READ FAILED", "alert");
    }
  },

  // binary little-endian PLY vertices (our own export layout and kin)
  parsePlyVertices(buf) {
    const u8 = new Uint8Array(buf);
    const marker = new TextEncoder().encode("end_header\n");
    let headEnd = -1;
    outer: for (let i = 0; i < Math.min(u8.length, 4096); i++) {
      for (let k = 0; k < marker.length; k++) {
        if (u8[i + k] !== marker[k]) continue outer;
      }
      headEnd = i + marker.length;
      break;
    }
    if (headEnd < 0) return null;
    const head = new TextDecoder().decode(u8.slice(0, headEnd));
    if (!/format binary_little_endian/.test(head)) return null;
    let n = 0;
    let inVertex = false;
    const props = [];
    for (const ln of head.split("\n")) {
      const m = ln.match(/^element (\w+) (\d+)/);
      if (m) {
        inVertex = m[1] === "vertex";
        if (inVertex) n = +m[2];
        continue;
      }
      const p = ln.match(/^property (\w+) (\w+)/);
      if (p && inVertex) props.push({ type: p[1], name: p[2] });
    }
    const size = {
      float: 4, float32: 4, double: 8, float64: 8,
      uchar: 1, uint8: 1, char: 1, int8: 1,
      short: 2, ushort: 2, int16: 2, uint16: 2,
      int: 4, uint: 4, int32: 4, uint32: 4,
    };
    let stride = 0;
    const off = {};
    for (const p of props) {
      off[p.name] = { o: stride, t: p.type };
      stride += size[p.type] || 4;
    }
    if (!("x" in off) || !("y" in off) || !("z" in off) || !stride || !n) return null;
    if (headEnd + n * stride > buf.byteLength) n = Math.floor((buf.byteLength - headEnd) / stride);
    const dv = new DataView(buf, headEnd);
    const rd = (p, base) => (p.t === "double" || p.t === "float64")
      ? dv.getFloat64(base + p.o, true) : dv.getFloat32(base + p.o, true);
    const hasC = off.red && off.green && off.blue && /uchar|uint8/.test(off.red.t);
    const count = Math.min(n, this.MAX_POINTS);
    const P = new Float32Array(count * 3);
    const C = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const b = i * stride;
      P[i * 3] = rd(off.x, b);
      P[i * 3 + 1] = rd(off.y, b);
      P[i * 3 + 2] = rd(off.z, b);
      if (hasC) {
        C[i * 3] = dv.getUint8(b + off.red.o) / 255;
        C[i * 3 + 1] = dv.getUint8(b + off.green.o) / 255;
        C[i * 3 + 2] = dv.getUint8(b + off.blue.o) / 255;
      } else {
        C[i * 3] = 0.21;
        C[i * 3 + 1] = 0.84;
        C[i * 3 + 2] = 1;
      }
    }
    return { P, C, count };
  },

  async loadPlyCloud(buf, name) {
    if (!this._ctx) await this.initViewport();
    const parsed = this.parsePlyVertices(buf);
    if (!parsed || !parsed.count) {
      this.setStatus("PLY PARSE FAILED", "alert");
      return;
    }
    const short = name.replace(/\.ply$/i, "").toUpperCase().slice(0, 22) || "SCAN";
    const ws = this.newWs(short, false);
    ws.positions.set(parsed.P.subarray(0, parsed.count * 3));
    ws.colors.set(parsed.C.subarray(0, parsed.count * 3));
    ws.count = parsed.count;
    ws.writeIdx = parsed.count % this.MAX_POINTS;
    // rebuild stats / occupancy / sweep grid so analytics, PLAN, LINE and
    // RETOUCH all work on the loaded cloud (channel inferred from elevation)
    const S = ws.st;
    for (let i = 0; i < parsed.count; i++) {
      const x = parsed.P[i * 3], y = parsed.P[i * 3 + 1], z = parsed.P[i * 3 + 2];
      const mm = Math.hypot(x, y - this.CH_HEIGHTS[3], z) * 1000;
      S.total++;
      S.n++;
      S.sum += mm;
      S.sumsq += mm * mm;
      S.histD[Math.min(24, Math.floor(mm / 160))]++;
      S.histY[Math.max(0, Math.min(79, Math.floor((y + 0.5) / 4 * 80)))]++;
      S.histX[Math.max(0, Math.min(79, Math.floor((x + 4) / 8 * 80)))]++;
      S.histZ[Math.max(0, Math.min(79, Math.floor((z + 4) / 8 * 80)))]++;
      if (y > 0.15 && y < 2.3) {
        const cx = Math.floor((x + 4) / 8 * 160);
        const cz = Math.floor((z + 4) / 8 * 160);
        if (cx >= 0 && cx < 160 && cz >= 0 && cz < 160) {
          const oi = cz * 160 + cx;
          if (ws.occ[oi] < 65535) ws.occ[oi]++;
        }
      }
      const deg = Math.atan2(-z, x) * 180 / Math.PI;
      if (deg >= -1 && deg <= 181) {
        const az = Math.max(0, Math.min(180, Math.round(deg)));
        for (let ch = 0; ch < 7; ch++) {
          const rch = Math.hypot(x, y - this.CH_HEIGHTS[ch], z);
          if (rch < 0.02) continue;
          const elev = Math.asin(Math.max(-1, Math.min(1, (y - this.CH_HEIGHTS[ch]) / rch)))
            * 180 / Math.PI;
          if (Math.abs(elev - this.TILTS[ch]) < 2) {
            const gi = ch * 181 + az;
            ws.grid[gi * 3] = x;
            ws.grid[gi * 3 + 1] = y;
            ws.grid[gi * 3 + 2] = z;
            ws.gridOk[gi] = 1;
            break;
          }
        }
      }
    }
    this._wss.push(ws);
    this.els.hint.hidden = true; // a loaded scan replaces the offline hint
    this.switchWs(this._wss.length - 1); // aliases now point at the new scan
    // outcome check: if the inferred sweep grid yields no wall outline
    // (RETOUCH ribbon exports, foreign PLYs), synthesize a CH3 outline at
    // mid-wall height + occupancy so LINE/RETOUCH/PLAN stay editable
    const ceilY = this.histTop(this._st.histY, -0.5, 3.5, 5) || 2.4;
    const outline = this.computeOutline(ceilY);
    if (outline.filter((v) => v != null).length < 20) {
      const yMid = Math.max(0.35, (0.3 + ceilY - 0.25) / 2);
      for (let i = 0; i < ws.count; i++) {
        const x = ws.positions[i * 3], z = ws.positions[i * 3 + 2];
        const deg = Math.atan2(-z, x) * 180 / Math.PI;
        if (deg < -1 || deg > 181) continue;
        const az2 = Math.max(0, Math.min(180, Math.round(deg)));
        const gi = 3 * 181 + az2;
        const r = Math.hypot(x, z);
        const prev = ws.gridOk[gi] && ws.grid[gi * 3 + 1] === yMid
          ? Math.hypot(ws.grid[gi * 3], ws.grid[gi * 3 + 2]) : -1;
        if (r > prev) {
          ws.grid[gi * 3] = x;
          ws.grid[gi * 3 + 1] = yMid;
          ws.grid[gi * 3 + 2] = z;
          ws.gridOk[gi] = 1;
        }
        const cx = Math.floor((x + 4) / 8 * 160);
        const cz = Math.floor((z + 4) / 8 * 160);
        if (cx >= 0 && cx < 160 && cz >= 0 && cz < 160) {
          const oi = cz * 160 + cx;
          if (ws.occ[oi] < 65535) ws.occ[oi]++;
        }
      }
      this.renderAnalytics();
      this.applyLayers();
      this.renderCPlan();
    }
    this.setStatus(`LOADED ${name} \u00b7 ${ws.count.toLocaleString()} PTS`, "ok");
  },

  clearCloud() {
    this._count = 0;
    this._writeIdx = 0;
    this._paint = null;
    this._paintLog = [];
    if (this._ctx) this._ctx.geo.setDrawRange(0, 0);
    this.els.stats.textContent = "0 PTS";
    this.resetStats();
    this.applyLayers();
  },

  // ── analytics: keep every sample's statistics even though the point ring
  // buffer eventually overwrites old points ──
  freshStats() {
    return {
      n: 0, total: 0, sum: 0, sumsq: 0, edges: 0,
      histD: new Uint32Array(25),
      histX: new Uint32Array(80),
      histY: new Uint32Array(80),
      histZ: new Uint32Array(80),
    };
  },

  resetStats() {
    this._st = this.freshStats();
    this._grid = new Float32Array(7 * 181 * 3);
    this._gridOk = new Uint8Array(7 * 181);
    this._occ = new Uint16Array(160 * 160); // 8×8 m, 5 cm cells (floor plan)
    this._lastEdge = -1;
  },

  // ── workspaces: the LIVE stream plus any number of loaded PLY scans.
  // The legacy per-scan fields (_count, _grid, _occ, _st, _paintLog, …)
  // become aliases onto the active workspace so every consumer — layers,
  // analytics, painting, exports — is workspace-aware unchanged. ──
  _wss: null,
  _wsActive: 0,
  activeWs() { return this._wss[this._wsActive]; },
  liveWs() { return this._wss[0]; },

  newWs(name, live) {
    return {
      name, live: !!live,
      positions: new Float32Array(this.MAX_POINTS * 3),
      colors: new Float32Array(this.MAX_POINTS * 3),
      count: 0, writeIdx: 0,
      grid: new Float32Array(7 * 181 * 3),
      gridOk: new Uint8Array(7 * 181),
      occ: new Uint16Array(160 * 160),
      st: this.freshStats(),
      paintLog: [],
    };
  },

  initWorkspaces() {
    this._wss = [this.newWs("LIVE", true)];
    this._wsActive = 0;
    const map = { _count: "count", _writeIdx: "writeIdx", _grid: "grid",
      _gridOk: "gridOk", _occ: "occ", _st: "st", _paintLog: "paintLog" };
    for (const [alias, key] of Object.entries(map)) {
      Object.defineProperty(this, alias, {
        get: () => this.activeWs()[key],
        set: (v) => { this.activeWs()[key] = v; },
        configurable: true,
      });
    }
  },

  switchWs(i) {
    if (i === this._wsActive || !this._wss[i]) return;
    this._wsActive = i;
    const ws = this.activeWs();
    const c = this._ctx;
    if (c) {
      c.positions = ws.positions;
      c.colors = ws.colors;
      c.geo.attributes.position.array = ws.positions;
      c.geo.attributes.color.array = ws.colors;
      c.geo.attributes.position.needsUpdate = true;
      c.geo.attributes.color.needsUpdate = true;
      c.geo.setDrawRange(0, ws.count);
    }
    this.setSelection(null);
    this.setPaintSel(null);
    this.els.stats.textContent = `${ws.count.toLocaleString()} PTS`;
    this.renderAnalytics();
    this.els.analytics.hidden = ws.count === 0;
    this.applyLayers();
    this.renderCPlan();
    this.renderTabs();
  },

  closeWs(i) {
    const ws = this._wss[i];
    if (!ws || ws.live) return;
    this._wss.splice(i, 1);
    if (this._wsActive >= i) {
      const target = Math.max(0, this._wsActive - 1);
      if (target === this._wsActive) {
        this._wsActive = -1; // force the refresh even for index 0
      }
      this.switchWs(target);
    } else {
      this.renderTabs();
    }
  },

  renderTabs() {
    const bar = this.els.tabs;
    if (!bar) return;
    bar.hidden = this._wss.length < 2;
    bar.innerHTML = "";
    if (bar.hidden) return;
    this._wss.forEach((ws, i) => {
      const tab = document.createElement("div");
      tab.className = `r3d-tab${i === this._wsActive ? " active" : ""}`;
      const label = document.createElement("span");
      label.className = "r3d-tab-label";
      label.textContent = ws.live ? "◎ LIVE" : ws.name;
      tab.appendChild(label);
      if (!ws.live) {
        const x = document.createElement("span");
        x.className = "r3d-tab-x";
        x.textContent = "✕";
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          this.closeWs(i);
        });
        tab.appendChild(x);
      }
      tab.addEventListener("click", () => this.switchWs(i));
      bar.appendChild(tab);
    });
  },

  // highest bin with a meaningful count — robust "max" that ignores stray noise
  histTop(hist, lo, hi, minCount) {
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i] >= (minCount || 5)) return lo + ((i + 0.5) / hist.length) * (hi - lo);
    }
    return null;
  },

  percentile(hist, q, lo, hi) {
    let total = 0;
    for (const v of hist) total += v;
    if (!total) return null;
    const target = total * q;
    let acc = 0;
    for (let i = 0; i < hist.length; i++) {
      acc += hist[i];
      if (acc >= target) return lo + ((i + 0.5) / hist.length) * (hi - lo);
    }
    return hi;
  },

  renderAnalytics() {
    const S = this._st;
    if (!S.n) return;
    const mean = S.sum / S.n;
    const std = Math.sqrt(Math.max(0, S.sumsq / S.n - mean * mean));
    const med = this.percentile(S.histD, 0.5, 0, 4000);
    this.els.asMean.textContent = `${(mean / 1000).toFixed(2)} M`;
    this.els.asMed.textContent = med ? `${(med / 1000).toFixed(2)} M` : "\u2014";
    this.els.asStd.textContent = `${Math.round(std)} MM`;
    this.els.asValid.textContent = `${Math.round((S.n / S.total) * 100)}%`;
    this.els.asSweeps.textContent = `${Math.max(0, S.edges - 1)}`;
    const w = (this.percentile(S.histX, 0.98, -4, 4) ?? 0) - (this.percentile(S.histX, 0.02, -4, 4) ?? 0);
    const d = (this.percentile(S.histZ, 0.98, -4, 4) ?? 0) - (this.percentile(S.histZ, 0.02, -4, 4) ?? 0);
    const h = this.histTop(S.histY, -0.5, 3.5, 5) ?? 0;
    this.els.asRoom.textContent =
      `EST ROOM ${w.toFixed(1)} \u00d7 ${d.toFixed(1)} \u00d7 ${h.toFixed(1)} M`;

    // distance histogram with mean marker
    const cv = this.els.hist;
    const dpr = window.devicePixelRatio || 1;
    const disp = Math.round(cv.clientWidth);
    const bpx = Math.round(disp * dpr);
    if (disp && cv.width !== bpx) {
      cv.width = bpx;
      cv.height = Math.round(bpx * 62 / 212);
    }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = disp || cv.width, H = Math.round((disp || cv.width) * 62 / 212);
    ctx.clearRect(0, 0, W, H);
    let max = 1;
    for (const v of S.histD) max = Math.max(max, v);
    const bw = W / 25;
    for (let i = 0; i < 25; i++) {
      const bh = (S.histD[i] / max) * (H - 4);
      ctx.fillStyle = "rgba(53, 214, 255, 0.75)";
      ctx.fillRect(i * bw + 1, H - bh, bw - 2, bh);
    }
    const mx = (mean / 4000) * W;
    ctx.strokeStyle = "#ffc857";
    ctx.beginPath();
    ctx.moveTo(mx, 0);
    ctx.lineTo(mx, H);
    ctx.stroke();
  },

  // ── view layers: independently toggleable, any combination ──
  _layers: { point: true, line: false, retouch: false, plan: false },

  toggleLayer(name) {
    this._layers[name] = !this._layers[name];
    this.els.modes.querySelectorAll("button").forEach((b) =>
      b.classList.toggle("active", !!this._layers[b.dataset.mode]));
    this.applyLayers();
  },

  applyLayers() {
    const L = this._layers;
    if (this._ctx) {
      this._ctx.cloud.visible = !!L.point;
      if (L.line) this.buildLines();
      else if (this._lineGroup) this._lineGroup.visible = false;
      if (L.retouch) this.buildRoom();
      else if (this._roomGroup) this._roomGroup.visible = false;
    }
    this.els.plan.hidden = !L.plan;
    if (L.plan) this.renderPlan();
  },

  // LINE: per-channel contour — consecutive azimuth samples of the latest
  // sweep joined into segments (gaps where the sensor had no return)
  buildLines() {
    const c = this._ctx;
    if (!c) return;
    const THREE = this._three.THREE;
    if (!(this._lineGroup instanceof THREE.Group)) {
      this._lineGroup = new THREE.Group();
      this._lineSegs = [];
      for (let ch = 0; ch < 7; ch++) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(181 * 3), 3));
        geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(181 * 3), 3));
        geo.setIndex(new THREE.BufferAttribute(new Uint16Array(180 * 2), 1));
        geo.setDrawRange(0, 0);
        const mat = new THREE.LineBasicMaterial({
          vertexColors: true, transparent: true, opacity: 0.95,
          clippingPlanes: this._clip || null,
        });
        const seg = new THREE.LineSegments(geo, mat);
        seg.frustumCulled = false;
        this._lineGroup.add(seg);
        this._lineSegs.push(seg);
      }
      c.scene.add(this._lineGroup);
    }
    for (let ch = 0; ch < 7; ch++) {
      const seg = this._lineSegs[ch];
      const pos = seg.geometry.attributes.position.array;
      const col = seg.geometry.attributes.color.array;
      const idx = seg.geometry.index.array;
      let ni = 0;
      for (let az = 0; az <= 180; az++) {
        const gi = ch * 181 + az;
        pos[az * 3] = this._grid[gi * 3];
        pos[az * 3 + 1] = this._grid[gi * 3 + 1];
        pos[az * 3 + 2] = this._grid[gi * 3 + 2];
        this.styleColor(pos[az * 3], pos[az * 3 + 1], pos[az * 3 + 2], col, az * 3);
        if (az > 0 && this._gridOk[gi] && this._gridOk[gi - 1]) {
          idx[ni++] = az - 1;
          idx[ni++] = az;
        }
      }
      seg.geometry.attributes.position.needsUpdate = true;
      seg.geometry.attributes.color.needsUpdate = true;
      seg.geometry.index.needsUpdate = true;
      seg.geometry.setDrawRange(0, ni);
    }
    this._lineGroup.visible = !!this._layers.line;
  },

  // per-azimuth median wall radius (wall height band), gaps interpolated,
  // 5-tap median smoothing — shared by RETOUCH shell and the PLAN outline
  computeOutline(ceilY) {
    const raw = new Array(181).fill(null);
    for (let az = 0; az <= 180; az++) {
      const rs = [];
      for (let ch = 0; ch < 7; ch++) {
        const gi = ch * 181 + az;
        if (!this._gridOk[gi]) continue;
        const y = this._grid[gi * 3 + 1];
        if (y < 0.3 || y > ceilY - 0.25) continue; // floor/ceiling hits are not walls
        rs.push(Math.hypot(this._grid[gi * 3], this._grid[gi * 3 + 2]));
      }
      if (rs.length) {
        rs.sort((p, q) => p - q);
        raw[az] = rs[Math.floor(rs.length / 2)];
      }
    }
    const filled = raw.slice();
    let last = -1;
    for (let az = 0; az <= 180; az++) {
      if (filled[az] != null) {
        if (last >= 0 && az - last > 1 && az - last <= 12) {
          for (let k = last + 1; k < az; k++) {
            filled[k] = filled[last] + (filled[az] - filled[last]) * ((k - last) / (az - last));
          }
        }
        last = az;
      }
    }
    return filled.map((v, az) => {
      if (v == null) return null;
      const win = [];
      for (let k = az - 2; k <= az + 2; k++) {
        if (k >= 0 && k <= 180 && filled[k] != null) win.push(filled[k]);
      }
      win.sort((p, q) => p - q);
      return win[Math.floor(win.length / 2)];
    });
  },

  // RETOUCH: extrude the smoothed outline into a translucent room shell
  buildRoom() {
    const c = this._ctx;
    if (!c) return;
    const THREE = this._three.THREE;
    const ceilY = this.histTop(this._st.histY, -0.5, 3.5, 5) || 2.4;
    const smooth = this.computeOutline(ceilY);

    // 3) extrude contiguous runs into a wall ribbon
    if (this._roomGroup) {
      c.scene.remove(this._roomGroup);
      this._roomGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    this._roomGroup = new THREE.Group();
    const verts = [];
    const cols = [];
    const indices = [];
    const topPts = [];
    const botPts = [];
    const tmpc = new Float32Array(3);
    let runStart = null;
    const flushRun = () => { runStart = null; };
    for (let az = 0; az <= 181; az++) {
      const r = az <= 180 ? smooth[az] : null;
      if (r == null) { flushRun(); continue; }
      const ph = (az * Math.PI) / 180;
      const x = r * Math.cos(ph);
      const z = -r * Math.sin(ph);
      const base = verts.length / 3;
      verts.push(x, 0.02, z, x, ceilY, z);
      this.styleColor(x, 0.02, z, tmpc, 0);
      cols.push(tmpc[0], tmpc[1], tmpc[2]);
      this.styleColor(x, ceilY, z, tmpc, 0);
      cols.push(tmpc[0], tmpc[1], tmpc[2]);
      botPts.push(new THREE.Vector3(x, 0.03, z));
      topPts.push(new THREE.Vector3(x, ceilY, z));
      if (runStart != null) {
        indices.push(base - 2, base - 1, base, base - 1, base + 1, base);
      }
      runStart = az;
    }
    if (verts.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      const wall = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.14,
        side: THREE.DoubleSide, depthWrite: false,
        clippingPlanes: this._clip || null,
      }));
      this._roomGroup.add(wall);
      const mkLine = (pts, opacity) => {
        const g = new THREE.BufferGeometry().setFromPoints(pts);
        const lc = new Float32Array(pts.length * 3);
        pts.forEach((p, i) => {
          this.styleColor(p.x, p.y, p.z, tmpc, 0);
          lc.set(tmpc, i * 3);
        });
        g.setAttribute("color", new THREE.BufferAttribute(lc, 3));
        return new THREE.Line(g, new THREE.LineBasicMaterial({
          vertexColors: true, transparent: true, opacity,
          clippingPlanes: this._clip || null,
        }));
      };
      this._roomGroup.add(mkLine(botPts, 0.7));
      this._roomGroup.add(mkLine(topPts, 0.7));
    }
    c.scene.add(this._roomGroup);
    this._roomGroup.visible = !!this._layers.retouch;
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
      monPort: $("ino-mon-port"),
      reset: $("ino-reset"),
      ipChip: $("ino-ip-chip"),
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
    this.els.reset.addEventListener("click", () => this.resetBoard());
    this.els.ipChip.addEventListener("click", () => this.sendIpToArc());
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
      if (e.detail !== "ino") return;
      if (!this._booted) {
        this._booted = true;
        this.bootstrap();
      } else {
        this.refreshPorts(); // pick up boards plugged in since last visit
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
      this.renderPorts(r.ports || []);
    } catch (e) {
      this.log(this.els.out, `port scan failed: ${e.message}`, "err");
    }
  },

  // fills the BOARD select and the serial-monitor bar select, kept in sync.
  // USB serial adapters (usbserial/usbmodem/SLAB/wchusb) sort first — those
  // are actual dev boards; Bluetooth/debug ports are dropped entirely.
  renderPorts(ports) {
    const isUsb = (a) => /usbserial|usbmodem|SLAB|wchusb/i.test(a);
    const usable = ports
      .filter((p) => p.address && !p.address.includes("Bluetooth") &&
        !p.address.includes("debug-console"))
      .sort((a, b) => (isUsb(b.address) ? 1 : 0) - (isUsb(a.address) ? 1 : 0));

    const fill = (sel) => {
      sel.innerHTML = "";
      for (const p of usable) {
        const opt = document.createElement("option");
        opt.value = p.address;
        opt.textContent = p.board
          ? `${p.address.replace("/dev/cu.", "")} \u00b7 ${p.board}`
          : p.address.replace("/dev/cu.", "");
        sel.appendChild(opt);
      }
      if (!usable.length) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "no boards found";
        sel.appendChild(opt);
      }
    };
    fill(this.els.port);
    fill(this.els.monPort);

    const detected = usable.find((p) => p.fqbn);
    if (detected && !this.els.fqbn.value) this.els.fqbn.value = detected.fqbn;

    const prev = localStorage.getItem("ino-port");
    const pick = (prev && usable.some((p) => p.address === prev))
      ? prev
      : (usable.find((p) => isUsb(p.address)) || usable[0] || { address: "" }).address;
    this.setPort(pick);

    this.els.port.onchange = () => this.setPort(this.els.port.value);
    this.els.monPort.onchange = () => this.setPort(this.els.monPort.value);
  },

  setPort(addr) {
    this.els.port.value = addr;
    this.els.monPort.value = addr;
    if (addr) localStorage.setItem("ino-port", addr);
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
      this.clearPartialLine();
      this.els.monToggle.textContent = "CLOSE";
      this.els.monToggle.classList.add("active");
      this.log(this.els.mon, `\u25cf ${port} @ ${baud}`, "okl");
      // pulse reset so boot-time prints (like the ARC-Scan WiFi IP) replay
      setTimeout(() => this.resetBoard(), 200);
    } catch (e) {
      this.log(this.els.mon, `open failed: ${e.message}`, "err");
    }
  },

  async resetBoard() {
    if (!this._monOpen) return;
    try {
      const r = await OmniNative.request("arduino.serialReset");
      if (r.ok) this.log(this.els.mon, "\u21bb reset pulse \u2014 board rebooting\u2026", "sys");
    } catch (e) {}
  },

  sendIpToArc() {
    const ip = this._lastIp;
    if (!ip) return;
    const arc = OmniOS.modules.arc;
    arc.els.ip.value = ip;
    localStorage.setItem("arc-ip", ip);
    document.querySelector('.nav-item[data-panel="arc"]').click();
    if (!arc._enabled) arc.toggle();
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
      this.clearPartialLine(); // the pending fragment just completed
      if (line.length) {
        // surface any IPv4 the sketch prints (ARC-Scan boot log) as a
        // one-click handoff to the ARC-SCAN panel
        const ipm = line.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
        const valid = ipm && ipm[1].split(".").every((o) => +o <= 255) &&
          ipm[1] !== "0.0.0.0" && ipm[1] !== "255.255.255.255";
        if (valid) {
          this._lastIp = ipm[1];
          this.els.ipChip.textContent = `\u2192 ARC-SCAN ${ipm[1]}`;
          this.els.ipChip.hidden = false;
        }
        this.log(this.els.mon, line, valid ? "okl" : "");
        this.plotLine(line);
      }
    }
    if (this._serialBuf.length > 4096) {
      this._serialBuf = this._serialBuf.slice(-2048); // keep the tail, not nothing
    }
    // show newline-less output live (e.g. "WiFi 연결 중...." progress dots) —
    // without this, prints that never end in \n are invisible
    this.renderPartialLine();
  },

  renderPartialLine() {
    const buf = this._serialBuf.replace(/\r/g, "");
    if (!buf.length) {
      this.clearPartialLine();
      return;
    }
    if (!this._partialEl || !this._partialEl.isConnected) {
      this._partialEl = document.createElement("div");
      this._partialEl.className = "partial";
      this.els.mon.appendChild(this._partialEl);
    } else if (this._partialEl !== this.els.mon.lastChild) {
      this.els.mon.appendChild(this._partialEl);
    }
    this._partialEl.textContent = buf;
    this.els.mon.scrollTop = this.els.mon.scrollHeight;
  },

  clearPartialLine() {
    if (this._partialEl) {
      this._partialEl.remove();
      this._partialEl = null;
    }
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
