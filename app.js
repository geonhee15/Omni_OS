// OMNI_OS core
// Future apps get integrated by registering themselves as modules here.
const OmniOS = {
  version: "0.74.1",
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

// ---------- theme (저장된 테마를 모듈 초기화 전에 즉시 적용 — 깜빡임 방지) ----------
document.documentElement.dataset.omniTheme =
  localStorage.getItem("omni.theme") || "hud";

// ---------- module: SETTINGS (테마 등 앱 설정) ----------
OmniOS.register("settings", {
  THEMES: ["hud", "apple"],

  init() {
    const $ = (id) => document.getElementById(id);
    this.els = {
      btn: $("sb-settings"),
      overlay: $("st-overlay"),
      close: $("st-close"),
    };
    this.els.btn.addEventListener("click", () => this.toggle(true));
    this.els.close.addEventListener("click", () => this.toggle(false));
    this.els.overlay.addEventListener("mousedown", (e) => {
      if (e.target === this.els.overlay) this.toggle(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.els.overlay.hidden) this.toggle(false);
    });
    document.querySelectorAll(".st-theme").forEach((b) =>
      b.addEventListener("click", () => this.applyTheme(b.dataset.theme)));
    this.syncButtons();
  },

  toggle(open) {
    this.els.overlay.hidden = !open;
    if (open) this.syncButtons();
  },

  applyTheme(name) {
    if (!this.THEMES.includes(name)) return;
    document.documentElement.dataset.omniTheme = name;
    localStorage.setItem("omni.theme", name);
    this.syncButtons();
  },

  syncButtons() {
    const cur = document.documentElement.dataset.omniTheme || "hud";
    document.querySelectorAll(".st-theme").forEach((b) =>
      b.classList.toggle("active", b.dataset.theme === cur));
  },
});

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

// 프로젝트 에디터 도구용: 불러온/저장한 파일을 프로젝트 하위 폴더에 보관
OmniOS.projectKeep = async function (dir, name, data) {
  // data: string(텍스트) | ArrayBuffer(바이너리)
  if (!dir || !window.OmniNative || !OmniNative.available) return false;
  const safe = String(name).split("/").pop();
  try {
    await OmniNative.request("ce.mkdir",
      JSON.stringify({ path: dir }), 8000).catch(() => {});
    if (typeof data === "string") {
      const r = await OmniNative.request("ce.write",
        JSON.stringify({ path: `${dir}/${safe}`, data }), 30000);
      return !!(r && r.ok);
    }
    const bytes = new Uint8Array(data);
    if (bytes.length > 80 * 1024 * 1024) return false;
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    const r = await OmniNative.request("ce.writeBin",
      JSON.stringify({ path: `${dir}/${safe}`, data: btoa(bin) }), 60000);
    return !!(r && r.ok);
  } catch (e) {
    return false;
  }
};

// 범용 우클릭 메뉴: items = [{label, hint, disabled, onClick} | {sep:true}]
OmniOS.ctxMenu = function (items, x, y) {
  const old = document.querySelector(".omni-ctx");
  if (old) old.remove();
  const menu = document.createElement("div");
  menu.className = "pj-ctx omni-ctx";
  const close = () => {
    menu.remove();
    window.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("keydown", onKey, true);
  };
  const onDown = (e) => {
    if (!menu.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  for (const it of items) {
    if (it.sep) {
      const s = document.createElement("div");
      s.className = "pj-ctx-sep";
      menu.appendChild(s);
      continue;
    }
    const el = document.createElement("div");
    el.className = `pj-ctx-item${it.disabled ? " disabled" : ""}`;
    const label = document.createElement("span");
    label.textContent = it.label;
    el.appendChild(label);
    if (it.hint) {
      const h = document.createElement("span");
      h.textContent = it.hint;
      h.style.color = "rgba(111, 168, 201, 0.7)";
      el.appendChild(h);
    }
    if (it.onClick && !it.disabled) {
      el.addEventListener("click", () => {
        close();
        it.onClick();
      });
    }
    menu.appendChild(el);
  }
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 8))}px`;
  window.addEventListener("mousedown", onDown, true);
  window.addEventListener("keydown", onKey, true);
  return close;
};

// ---------- module: clock ----------
OmniOS.register("cmd", {
  els: null,
  _three: null,
  _ctx: null,
  _timer: null,
  _raf: null,
  _loadedModelFor: null,

  init() {
    const $ = (id) => document.getElementById(id);
    this.els = {
      panel: $("panel-cmd"), sub: $("cmd-sub"), clock: $("cmd-clock"), up: $("cmd-up"),
      cpu: $("cmd-cpu"), cpuV: $("cmd-cpu-v"), gpu: $("cmd-gpu"), gpuV: $("cmd-gpu-v"),
      mem: $("cmd-mem"), memV: $("cmd-mem-v"), net: $("cmd-net"), thermal: $("cmd-thermal"),
      defState: $("cmd-def-state"), defWatcher: $("cmd-def-watcher"),
      defIntr: $("cmd-def-intr"), defNtfy: $("cmd-def-ntfy"),
      stageVp: $("cmd-stage-vp"), stageLabel: $("cmd-stage-label"), stageSub: $("cmd-stage-sub"),
      projName: $("cmd-proj-name"), projType: $("cmd-proj-type"),
      projPrio: $("cmd-proj-prio"), projDday: $("cmd-proj-dday"),
      arcStatus: $("cmd-arc-status"), arcPts: $("cmd-arc-pts"),
      mission: $("cmd-mission"), missionNote: $("cmd-mission-note"),
      ticker: $("cmd-ticker"),
    };
    document.addEventListener("omni:panel", (e) => {
      if (e.detail === "cmd") this.activate();
      else this.deactivate();
    });
    // 앱은 cmd 패널로 부팅 — nav init 이후 한 박자 뒤 활성화
    setTimeout(() => {
      if (this.els.panel.classList.contains("active")) this.activate();
    }, 60);
  },

  async ensureThree() {
    if (this._three) return this._three;
    const THREE = await import("three");
    let STLLoader = null, PLYLoader = null;
    try { ({ STLLoader } = await import("./vendor/three/examples/jsm/loaders/STLLoader.js")); } catch (e) {}
    try { ({ PLYLoader } = await import("./vendor/three/examples/jsm/loaders/PLYLoader.js")); } catch (e) {}
    this._three = { THREE, STLLoader, PLYLoader };
    return this._three;
  },

  async initStage() {
    if (this._ctx) return;
    const { THREE } = await this.ensureThree();
    const vp = this.els.stageVp;
    const w = vp.clientWidth || 600, h = vp.clientHeight || 400;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(w, h);
    vp.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, w / h, 0.01, 100);
    camera.position.set(0, 0.6, 3.4);
    camera.lookAt(0, 0, 0);

    // 홀로그램 코어 (기본 표시 — 프로젝트 모델 로드되면 교체)
    const core = new THREE.Group();
    const ico = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0x35d6ff, wireframe: true,
        transparent: true, opacity: 0.7 }));
    core.add(ico);
    const inner = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.55, 0),
      new THREE.MeshBasicMaterial({ color: 0x2f7bff, wireframe: true,
        transparent: true, opacity: 0.35 }));
    core.add(inner);
    // 파티클 링
    const N = 400;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const r = 1.7 + Math.random() * 0.25;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 0.5;
      pos[i * 3 + 2] = Math.sin(a) * r;
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const ring = new THREE.Points(pg, new THREE.PointsMaterial({
      color: 0x8fdcff, size: 0.03, transparent: true, opacity: 0.8 }));
    scene.add(core);
    scene.add(ring);

    const grid = new THREE.GridHelper(6, 12, 0x2f7bff, 0x123048);
    grid.material.transparent = true;
    grid.material.opacity = 0.25;
    grid.position.y = -1.3;
    scene.add(grid);

    this._ctx = { renderer, scene, camera, core, ring, modelGroup: null, vp };
    new ResizeObserver(() => this.resizeStage()).observe(vp);

    const clock = new THREE.Clock();
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      if (!this.els.panel.classList.contains("active")) return;
      const t = clock.getElapsedTime();
      const c = this._ctx;
      const spin = c.modelGroup || c.core;
      spin.rotation.y = t * 0.35;
      if (!c.modelGroup) {
        c.core.children[0].rotation.x = t * 0.2;
        c.core.children[1].rotation.x = -t * 0.4;
      }
      c.ring.rotation.y = -t * 0.15;
      renderer.render(scene, camera);
    };
    loop();
  },

  resizeStage() {
    const c = this._ctx;
    if (!c) return;
    const w = c.vp.clientWidth || 600, h = c.vp.clientHeight || 400;
    c.renderer.setSize(w, h);
    c.camera.aspect = w / h;
    c.camera.updateProjectionMatrix();
  },

  activate() {
    this.initStage();
    this.tick();
    if (!this._timer) this._timer = setInterval(() => this.tick(), 3000);
    if (!this._clockT) this._clockT = setInterval(() => this.tickClock(), 1000);
    this.tickClock();
    this.loadTicker();
  },

  deactivate() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._clockT) { clearInterval(this._clockT); this._clockT = null; }
  },

  tickClock() {
    const now = new Date();
    const p = (n) => String(n).padStart(2, "0");
    this.els.clock.textContent = `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
  },

  async tick() {
    await Promise.all([this.pollSys(), this.pollDefense(), this.pollProject()]);
    this.pollArc();
  },

  async pollSys() {
    if (!OmniNative.available) {
      this.els.net.textContent = "DEV";
      return;
    }
    let d;
    try { d = await OmniNative.request("sys.stats", null, 4000); } catch (e) { return; }
    if (!d) return;
    const pct = (v) => `${Math.round((v || 0) * 100)}%`;
    this.els.cpu.style.width = pct(d.cpu);
    this.els.cpuV.textContent = pct(d.cpu);
    if (typeof d.gpu === "number") {
      this.els.gpu.style.width = `${Math.round(d.gpu)}%`;
      this.els.gpuV.textContent = `${Math.round(d.gpu)}%`;
    }
    const m = d.mem || {};
    if (m.total) {
      const used = ((m.wired || 0) + (m.compressed || 0) + (m.active || 0) + (m.inactive || 0)) / m.total;
      this.els.mem.style.width = pct(used);
      this.els.memV.textContent = pct(used);
    }
    const n = d.net || {};
    const rate = (v) => v >= 2 ** 20 ? `${(v / 2 ** 20).toFixed(1)}M` : `${(v / 1024).toFixed(0)}K`;
    this.els.net.textContent = `\u25BC ${rate(n.rxRate || 0)} \u25B2 ${rate(n.txRate || 0)}`;
    const TH = ["NOMINAL", "FAIR", "SERIOUS", "CRITICAL"];
    this.els.thermal.textContent = TH[d.thermal] || "--";
  },

  async pollDefense() {
    if (!OmniNative.available) { this.els.defState.textContent = "DEV"; return; }
    let s;
    try { s = await OmniNative.request("sp1.status", null, 4000); } catch (e) { return; }
    if (!s) return;
    const st = (s.state || "").toUpperCase();
    const E = this.els;
    E.defState.textContent = st || "--";
    E.defState.className = "cmd-state" + (st.includes("OFFLINE") ? " off"
      : st.includes("LOCKDOWN") || (st.includes("LOCK") && !st.includes("UNLOCK")) ? " alert"
      : "");
    E.defWatcher.textContent = s.watcher && s.watcher.running ? `PID ${s.watcher.pid}` : "OFFLINE";
    E.defIntr.textContent = s.intrusions != null ? `${s.intrusions}` : "--";
    E.defNtfy.textContent = s.ntfy && s.ntfy.online ? "ONLINE" : "--";
  },

  activeProject() {
    const proj = OmniOS.modules.proj;
    const items = (proj && proj._items) || [];
    return items.find((p) => p.status === "active")
      || items.find((p) => p.status !== "done")
      || items[0] || null;
  },

  async pollProject() {
    const p = this.activeProject();
    const E = this.els;
    if (!p) {
      E.projName.textContent = "--";
      E.stageLabel.textContent = "NO ACTIVE PROJECT";
      E.stageSub.textContent = "SELECT AN ACTIVE PROJECT IN PROJECTS";
      return;
    }
    E.projName.textContent = p.name.toUpperCase();
    E.projType.textContent = ({ software: "SOFTWARE", hardware: "HARDWARE", hybrid: "HYBRID" })[p.type] || "--";
    E.projPrio.textContent = (p.priority || "--").toUpperCase();
    E.stageLabel.textContent = p.name.toUpperCase();
    E.stageSub.textContent = (p.desc || "").toUpperCase().slice(0, 48);
    // D-day
    if (p.target && OmniOS.modules.proj.dday) {
      const dd = OmniOS.modules.proj.dday(p.target);
      E.projDday.textContent = dd.label;
      E.projDday.className = `cmd-dday ${dd.cls}`;
    } else {
      E.projDday.textContent = "";
    }
    // 미션 목표 + 홀로그램 모델
    this.loadMission(p);
    this.loadProjectModel(p);
  },

  async loadMission(p) {
    if (!OmniNative.available || !p.dir) return;
    const objectives = [];
    try {
      const notesDir = `${p.dir}/notes`;
      const t = await OmniNative.request("ce.tree", JSON.stringify({ path: notesDir }), 8000);
      const mds = ((t && t.entries) || []).filter((e) => !e.dir && /\.md$/i.test(e.name));
      for (const md of mds) {
        if (objectives.length >= 10) break;
        const r = await OmniNative.request("ce.read",
          JSON.stringify({ path: `${notesDir}/${md.name}` }), 8000);
        if (!r || !r.ok) continue;
        for (const line of (r.text || "").split("\n")) {
          const m = line.match(/^\s*[-*]\s+\[ \]\s+(.+)$/);
          if (m) objectives.push({ text: m[1].trim(), file: md.name.replace(/\.md$/i, "") });
          if (objectives.length >= 10) break;
        }
      }
    } catch (e) {}
    const box = this.els.mission;
    box.textContent = "";
    if (!objectives.length) {
      const li = document.createElement("li");
      li.className = "cmd-empty";
      li.textContent = "NO OPEN OBJECTIVES";
      box.appendChild(li);
      this.els.missionNote.textContent = "";
      return;
    }
    this.els.missionNote.textContent = `${objectives.length}`;
    for (const o of objectives) {
      const li = document.createElement("li");
      const box2 = document.createElement("span");
      box2.className = "box";
      const txt = document.createElement("span");
      txt.textContent = o.text;
      const repo = document.createElement("span");
      repo.className = "repo";
      repo.textContent = ` ${o.file}`;
      li.append(box2, txt, repo);
      box.appendChild(li);
    }
  },

  async loadProjectModel(p) {
    if (!this._ctx || !OmniNative.available || !p.dir) return;
    if (this._loadedModelFor === p.id) return; // 이미 이 프로젝트 모델
    this._loadedModelFor = p.id;
    try {
      const t = await OmniNative.request("ce.tree", JSON.stringify({ path: `${p.dir}/3d` }), 8000);
      const model = ((t && t.entries) || []).find((e) => !e.dir && /\.(stl|ply)$/i.test(e.name));
      if (!model) { this.showCore(); return; }
      const res = await fetch(`omni://local/__media__?p=${encodeURIComponent(`${p.dir}/3d/${model.name}`)}`);
      if (!res.ok) { this.showCore(); return; }
      const buf = await res.arrayBuffer();
      const { THREE, STLLoader, PLYLoader } = this._three;
      const ext = model.name.split(".").pop().toLowerCase();
      let geo = null;
      if (ext === "stl" && STLLoader) geo = new STLLoader().parse(buf);
      else if (ext === "ply" && PLYLoader) geo = new PLYLoader().parse(buf);
      if (!geo) { this.showCore(); return; }
      geo.computeVertexNormals && geo.computeVertexNormals();
      geo.center();
      geo.computeBoundingSphere();
      const s = geo.boundingSphere ? 1.1 / geo.boundingSphere.radius : 1;
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: 0x35d6ff, wireframe: true, transparent: true, opacity: 0.75 }));
      const g = new THREE.Group();
      g.add(mesh);
      g.scale.setScalar(s);
      this.setModelGroup(g);
    } catch (e) {
      this.showCore();
    }
  },

  setModelGroup(g) {
    const c = this._ctx;
    if (c.modelGroup) { c.scene.remove(c.modelGroup); }
    c.modelGroup = g;
    c.scene.add(g);
    c.core.visible = false;
  },

  showCore() {
    const c = this._ctx;
    if (!c) return;
    if (c.modelGroup) { c.scene.remove(c.modelGroup); c.modelGroup = null; }
    c.core.visible = true;
  },

  pollArc() {
    const arc = OmniOS.modules.arc;
    const E = this.els;
    if (arc && arc._streaming) {
      E.arcStatus.textContent = "STREAMING";
      E.arcPts.textContent = arc._count ? arc._count.toLocaleString() : "0";
    } else if (arc && arc._linked) {
      E.arcStatus.textContent = "LINKED";
      E.arcPts.textContent = arc._count ? arc._count.toLocaleString() : "0";
    } else {
      E.arcStatus.textContent = "IDLE";
      E.arcPts.textContent = "--";
    }
  },

  ago(ts) {
    const s = Date.now() / 1000 - ts;
    if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}M`;
    if (s < 86400) return `${Math.floor(s / 3600)}H`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}D`;
    return `${Math.floor(s / 86400 / 30)}MO`;
  },

  async loadTicker() {
    if (!OmniNative.available) return;
    let r;
    try { r = await OmniNative.request("git.recent", null, 12000); } catch (e) { return; }
    const commits = (r && r.commits) || [];
    const track = this.els.ticker;
    track.textContent = "";
    if (!commits.length) {
      const s = document.createElement("span");
      s.className = "cmd-empty";
      s.textContent = "NO RECENT COMMITS";
      track.appendChild(s);
      return;
    }
    // 무한 스크롤 위해 2배 복제
    const build = () => {
      for (const c of commits) {
        const item = document.createElement("span");
        item.className = "item";
        const b = document.createElement("b");
        b.textContent = c.repo;
        const msg = document.createElement("span");
        msg.textContent = ` ${c.msg}`;
        const ago = document.createElement("span");
        ago.className = "ago";
        ago.textContent = ` \u00b7 ${this.ago(c.ts)} AGO`;
        item.append(b, msg, ago);
        track.appendChild(item);
      }
    };
    build();
    build();
  },
});

// ---------- module: OMNI_AI (한국어 음성 인터페이스 // 레트로 로봇 보이스) ----------

// ---------- OMNI MEMORY (~/.omni/memory — 프로필·일지·주변 관찰·다이제스트) ----------
// 옴니의 기억. 프로필(오래가는 사실)·일지(대화/관찰/생각을 시간순으로)·주변음 원문·
// 하루 다이제스트로 나뉘고, 관찰 모듈이 주변음 전사를 읽어 "지금 무슨 상황인지"를
// 스스로 추정해 일지에 남긴다. 텍스트·LIVE·안경 브리지가 같은 파일을 쓴다.
const OmniMem = {
  profile: "",
  situation: "",
  people: [],
  today: [],
  recent: [],
  ambientBuf: [],
  _ambientSinceObs: 0,
  _lastObsAt: 0,
  _obsBusy: false,

  async req(cmd, obj) {
    if (!OmniNative.available) return null;
    try { return await OmniNative.request(cmd, JSON.stringify(obj || {}), 30000); }
    catch (e) { return null; }
  },

  localDate(ts) {
    const d = ts ? new Date(ts * 1000) : new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  },

  fmtTime(ts) {
    const d = new Date(ts * 1000);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  },

  async load() {
    const p = await this.req("mem.profile");
    this.profile = ((p && p.text) || "").slice(0, 4000);
    const t = await this.req("mem.read", { days: 1, limit: 400 });
    this.today = (t && t.items) || [];
    const r = await this.req("mem.read", { days: 7, limit: 900 });
    this.recent = (r && r.items) || [];
    const d = await this.req("mem.dates");
    for (const x of ((d && d.dates) || []).filter((x) => x.digest).slice(-7)) {
      const g = await this.req("mem.digest", { date: x.date });
      if (g && g.text) this.recent.push({ ts: new Date(`${x.date}T12:00:00`).getTime() / 1000, kind: "digest", text: g.text.slice(0, 1500) });
    }
    const last = [...this.today].reverse().find((e) => e.kind === "observe");
    if (last) { this.situation = last.text; this.people = (last.meta && last.meta.people) || []; }
    setInterval(() => this.observe(), 60000);
    setTimeout(() => this.dailyDigests(), 25000);
  },

  async append(kind, text, tags, meta) {
    const entry = { ts: Date.now() / 1000, kind, text: String(text || "").slice(0, 800), tags: tags || [], meta: meta || {} };
    if (kind !== "ambient") {
      this.today.push(entry); this.recent.push(entry);
      if (this.today.length > 800) this.today.shift();
      if (this.recent.length > 1500) this.recent.shift();
    }
    await this.req("mem.append", entry);
  },

  conv(role, text) {
    if (!text || typeof text !== "string") return;
    this.append("conv", `${role === "user" ? "나" : "옴니"}: ${text.slice(0, 500)}`);
  },

  // 사이드카 주변음 전사 (미디어·타인) 또는 건희가 남에게 한 말
  ambient(label, text, t0, sig) {
    if (!text) return;
    this.ambientBuf.push({ ts: t0 || Date.now() / 1000, label, text });
    if (this.ambientBuf.length > 80) this.ambientBuf.shift();
    this._ambientSinceObs++;
    this.req("mem.append", { kind: "ambient", text: `[${label}] ${text}`, meta: sig || {} });
    if (this._ambientSinceObs >= 12) this.observe();
  },

  // 관찰자: 주변음과 대화를 보고 상황을 추정하고 기억할 만한 것을 남긴다
  async observe() {
    if (this._obsBusy || !OmniNative.available || !this.ambientBuf.length) return;
    if (this._ambientSinceObs < 3 && Date.now() - this._lastObsAt < 300000) return;
    this._obsBusy = true;
    try {
      const LAB = { media: "노트북 재생음", other: "주변 사람", user_other: "건희→타인", uncertain: "불확실 화자" };
      const amb = this.ambientBuf.slice(-25).map((l) => `${this.fmtTime(l.ts)} [${LAB[l.label] || l.label}] ${l.text}`).join("\n");
      const conv = this.today.filter((e) => e.kind === "conv").slice(-6).map((e) => `${this.fmtTime(e.ts)} ${e.text}`).join("\n");
      const r = await OmniNative.request("ai.chat", JSON.stringify({
        model: "claude-haiku-4-5-20251001", maxTokens: 500,
        system: "당신은 개인 AI '옴니'의 관찰 모듈이다. 사용자 이름은 건희. 주변에서 들린 소리(노트북 재생음, 주변 사람의 말, 건희가 남에게 한 말)와 최근 대화를 보고 지금 상황을 추정한다. 반드시 JSON만 출력: {\"situation\":\"지금 상황 한 문장(예: 건희는 유튜브로 아이언맨 영상을 보는 중)\",\"watching\":\"보고/듣고 있는 것 또는 빈 문자열\",\"people\":[\"주변 인물 추정(이름·관계)\"],\"topics\":[\"핵심 주제 2~4개\"],\"notable\":[{\"text\":\"기억할 가치 있는 사실·사건 한 문장\",\"remember\":true}]}. notable은 확실한 것만(없으면 빈 배열), remember는 앞으로도 유효한 사실일 때만 true. 추측은 '~인 듯'으로 표시.",
        messages: [{ role: "user", content: `[직전 상황] ${this.situation || "(없음)"}\n\n[주변음 전사 (최근)]\n${amb || "(없음)"}\n\n[최근 대화]\n${conv || "(없음)"}` }],
      }), 40000);
      const txt = (r && r.ok && (r.text || (r.content || []).map((b) => b.text || "").join(""))) || "";
      const m = /\{[\s\S]*\}/.exec(txt);
      if (!m) return;
      const o = JSON.parse(m[0]);
      this._ambientSinceObs = 0; this._lastObsAt = Date.now();
      if (o.situation && o.situation !== this.situation) {
        this.situation = o.situation; this.people = o.people || [];
        this.append("observe", o.situation, o.topics || [], { watching: o.watching || "", people: o.people || [] });
        const ai = OmniOS.modules.ai; if (ai && ai.onSituation) ai.onSituation(o.situation);
      }
      for (const n of (o.notable || [])) if (n && n.text) this.append("thought", n.text, n.remember ? ["remember"] : []);
    } catch (e) { /* 배경 작업 */ } finally { this._obsBusy = false; }
  },

  tokens(str) {
    const out = new Set();
    const clean = String(str || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");
    for (const w of clean.split(/\s+/)) {
      if (w.length >= 2) out.add(w);
      if (w.length > 2) for (let i = 0; i + 2 <= w.length; i++) out.add(w.slice(i, i + 2));
    }
    return out;
  },

  search(query, limit) {
    const toks = this.tokens(query);
    if (!toks.size) return [];
    const scored = this.recent.filter((e) => e.kind !== "ambient").map((e) => {
      const t = this.tokens(e.text); let sc = 0;
      for (const k of toks) if (t.has(k)) sc++;
      return [sc + ((e.tags || []).includes("remember") ? 0.5 : 0), e];
    }).filter((x) => x[0] > 0.5);
    scored.sort((a, b) => b[0] - a[0] || b[1].ts - a[1].ts);
    return scored.slice(0, limit || 8).map((x) => x[1]);
  },

  fmtEntry(e) {
    const d = new Date(e.ts * 1000);
    const K = { conv: "", observe: "[상황] ", screen: "[화면] ", thought: "[생각] ", action: "[행동] ", user_other: "[건희→타인] ", note: "[메모] ", digest: "[하루 요약] ", question: "[옴니의 질문] ", answer: "[건희의 답] " };
    return `${d.getMonth() + 1}/${d.getDate()} ${this.fmtTime(e.ts)} ${K[e.kind] ?? `[${e.kind}] `}${e.text}`;
  },

  // 프롬프트용 기억 컨텍스트 — 프로필 + 현재 상황 + 오늘 일지 + 관련 기억
  context(query) {
    const todayLines = this.today.filter((e) => e.kind !== "ambient").slice(-14).map((e) => this.fmtEntry(e));
    const rel = query ? this.search(query, 6).filter((e) => !this.today.includes(e)).map((e) => this.fmtEntry(e)) : [];
    return `[프로필 — 오래가는 사실·선호]\n${this.profile || "(비어 있음)"}`
      + `\n\n[현재 상황 — 주변음을 듣고 옴니가 추정]\n${this.situation || "(아직 관찰 없음)"}${this.people.length ? `\n주변: ${this.people.join(", ")}` : ""}`
      + `\n\n[화면 관찰 — 건희가 지금 화면에서 하는 일]\n${this.screenActivity || "(아직 관찰 없음)"}`
      + `\n\n[오늘 일지 최근]\n${todayLines.join("\n") || "(없음)"}`
      + (rel.length ? `\n\n[관련 기억]\n${rel.join("\n")}` : "");
  },

  async setProfile(text) {
    this.profile = String(text || "").slice(0, 4000);
    await this.req("mem.profileWrite", { text: this.profile });
  },

  // 다이제스트가 없는 지난 날 요약 (최근 3일치)
  async dailyDigests() {
    const d = await this.req("mem.dates");
    if (!d || !d.dates) return;
    const today = this.localDate();
    for (const x of d.dates.filter((x) => !x.digest && x.date < today).slice(-3)) {
      const days = Math.min(30, Math.round((new Date(today) - new Date(x.date)) / 86400000) + 1);
      const r = await this.req("mem.read", { days, limit: 2000 });
      const es = ((r && r.items) || []).filter((e) => this.localDate(e.ts) === x.date && e.kind !== "ambient");
      if (es.length < 3) continue;
      const body = es.slice(-150).map((e) => `${this.fmtTime(e.ts)} [${e.kind}] ${e.text}`).join("\n");
      const g = await OmniNative.request("ai.chat", JSON.stringify({
        model: "claude-haiku-4-5-20251001", maxTokens: 700,
        system: "개인 AI '옴니'의 하루 일지를 다이제스트로 요약한다. 사용자는 건희. 무엇을 했고, 무엇을 보고 들었고, 누구와 있었고, 옴니와 무엇을 이야기했는지, 기억할 사실을 한국어 불릿 8개 이내로. 텍스트만 출력.",
        messages: [{ role: "user", content: `[${x.date} 일지]\n${body}` }],
      }), 60000).catch(() => null);
      const txt = (g && g.ok && (g.text || (g.content || []).map((b) => b.text || "").join(""))) || "";
      if (txt.trim()) {
        await this.req("mem.digestWrite", { date: x.date, text: txt.trim() });
        this.recent.push({ ts: new Date(`${x.date}T12:00:00`).getTime() / 1000, kind: "digest", text: txt.trim() });
      }
    }
  },
};

// ---------- OMNI SCREEN (화면 상시 관찰 + 호기심 질문) ----------
// 상시 대기 중 주기적으로 화면을 보고(같은 화면이면 건너뜀) 무엇을 하는지·누가 보이는지를
// 일지에 남기고, 정말 궁금한 것(모르는 닉네임, 처음 보는 프로젝트…)은 옴니가 먼저 말을
// 걸어 묻는다. 답을 들으면 Q/A를 기억에 저장하고 프로필에 통합한다. 같은 질문은 반복하지 않는다.
const OmniScreen = {
  INTERVAL_MS: 60000,
  ASK_COOLDOWN_MS: 180000,
  ANSWER_WAIT_MS: 90000,
  _timer: null,
  _busy: false,
  _lastHash: "",
  _lastAskAt: 0,
  _queued: null,
  activity: "",
  people: [],
  asked: {},        // key → {q, at, answered}
  pending: null,    // 방금 던진 질문 (답 대기)

  start() {
    if (this._timer) return;
    this.loadAsked();
    this._timer = setInterval(() => this.observe(false), this.INTERVAL_MS);
    setTimeout(() => this.observe(false), 8000);
  },

  stop() {
    clearInterval(this._timer);
    this._timer = null;
    this.pending = null;
  },

  async loadAsked() {
    const r = await OmniMem.req("mem.read", { days: 3, limit: 900 });
    for (const e of ((r && r.items) || [])) {
      const key = e.meta && e.meta.key;
      if (!key) continue;
      if (e.kind === "question") this.asked[key] = { q: e.text, at: e.ts * 1000, answered: false };
      if (e.kind === "answer" && this.asked[key]) this.asked[key].answered = true;
    }
  },

  hash(b64) {
    let h = 5381;
    for (let i = 0; i < b64.length; i += 400) h = ((h << 5) + h + b64.charCodeAt(i)) | 0;
    return String(h);
  },

  async observe(force) {
    const ai = OmniOS.modules.ai;
    if (this._busy || !OmniNative.available || !ai || (!ai.alwaysOn && !force)) return null;
    // 지난번에 타이밍이 안 맞아 미뤄둔 질문이 있으면 지금 조용할 때 꺼낸다
    if (this._queued && this.canAsk()) { const q = this._queued; this._queued = null; this.ask(q); }
    this._busy = true;
    try {
      // 사실 근거: 전면 앱·창 제목(네이티브) + 화면 텍스트(OCR, 원본 해상도) — 이미지만 보고 추측하지 않게
      const [shot, front] = await Promise.all([
        OmniNative.request("cu.screenshot", JSON.stringify({ maxWidth: 1024, ocr: true }), 40000),
        OmniNative.request("cu.front", null, 5000).catch(() => null),
      ]);
      if (!shot || !shot.ok) return null;
      const app = (front && front.ok && front.app) || "";
      const title = (front && front.ok && (front.title || front.doc)) || "";
      const ocr = String(shot.text || "").slice(0, 7000);
      // 변화 감지: 같은 앱·창이고 화면 텍스트가 거의 같으면(시계·커서만 바뀜) 건너뜀
      const key = `${app}|${title}`;
      const same = key === this._lastKey && this.textSim(ocr, this._lastOcr || "") >= 0.9;
      if (!force && same) return null;
      this._lastKey = key; this._lastOcr = ocr;
      const askedList = Object.values(this.asked).slice(-12).map((a) => `- ${a.q}${a.answered ? " (답 들음)" : ""}`).join("\n") || "(없음)";
      const r = await OmniNative.request("ai.chat", JSON.stringify({
        model: "claude-sonnet-5", maxTokens: 700,
        system: [{ type: "text", cache_control: { type: "ephemeral" }, text: "당신은 개인 AI '옴니'의 화면 관찰 모듈이다. 사용자 이름은 건희. 건희의 맥 화면 스크린샷과 함께 [사실]로 전면 앱 이름·창 제목(운영체제가 알려준 확정 정보)과 화면 텍스트(OCR, 원본 해상도에서 읽음)가 주어진다. JSON만 출력한다: {\"app\":\"앱/사이트\",\"activity\":\"지금 하는 일 한 문장\",\"people\":[\"건희가 상호작용 중인 사람·닉네임\"],\"topics\":[\"주제 2~4개\"],\"changed\":true|false,\"notable\":[{\"text\":\"앞으로도 유효한 사실 한 문장\",\"remember\":true}],\"questions\":[{\"key\":\"짧은 식별자(예: nick_YOHA)\",\"q\":\"건희에게 물어볼 질문 한 문장(존댓말)\",\"why\":\"왜 궁금한지\",\"priority\":1|2|3,\"confidence\":0.0~1.0}]}.\n규칙:\n- app은 [사실]의 앱 이름을 그대로 쓰고(브라우저면 창 제목의 사이트·페이지명을 덧붙임), 이미지만 보고 앱을 추측하지 않는다.\n- 이름·닉네임·숫자·제목은 반드시 OCR 텍스트에 있는 철자를 그대로 쓴다. OCR에도 없고 이미지에서도 또렷하지 않은 이름은 적지 않는다.\n- people은 건희가 실제로 대화·협업하는 상대만(채팅 상대, 문서 공동 작업자). 뉴스·영상 추천·댓글·검색 결과·광고에 스쳐 지나가는 이름은 넣지 않는다.\n- notable은 건희에 관한 오래가는 사실만(진행 중인 프로젝트·관계·선호·마감). 화면 내용 요약은 notable이 아니다.\n- questions는 다음을 모두 만족할 때만: (1) 건희가 지금 실제로 관여하는 사람·프로젝트·물건에 관한 것 (2) 화면·프로필·이미 물어본 목록으로는 답을 알 수 없음 (3) 답을 알면 옴니가 앞으로 건희를 더 잘 도울 수 있음 (4) OMNI_OS/옴니 OS 자체(Command Bridge 등 이 앱의 패널·기능 — 건희가 개발 중인 옴니 자신의 몸)가 아님 (5) 잠깐 스쳐 가는 내용(뉴스·영상 한 편·검색 결과)이 아님. 확신이 없으면 넣지 않는다 — 잘못된 질문 하나가 안 하는 것보다 나쁘다. priority 3=지금 물어볼 만함, 1=굳이 안 물어도 됨. confidence는 위 조건을 충족한다는 확신.\n- changed는 직전 관찰과 활동이 달라졌는지.\n- 비밀번호·카드번호·인증코드·주민번호 같은 민감 정보는 절대 적지 않는다." }],
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: shot.jpeg } },
          { type: "text", text: `[사실] 전면 앱: ${app || "(불명)"} · 창 제목: ${title || "(없음)"}\n\n[화면 텍스트(OCR)]\n${ocr || "(없음)"}\n\n[건희 프로필(아는 사람·사실)]\n${OmniMem.profile.slice(0, 1500) || "(없음)"}\n\n[직전 관찰] ${this.activity || "(없음)"}\n[이미 물어본 질문]\n${askedList}\n\n지금 화면을 관찰해 JSON으로.` },
        ] }],
      }), 60000);
      const txt = (r && r.ok && (r.text || (r.content || []).map((b) => b.text || "").join(""))) || "";
      const m = /\{[\s\S]*\}/.exec(txt);
      if (!m) return null;
      const o = JSON.parse(m[0]);
      if (app) o.app = o.app && o.app.includes(app) ? o.app : `${app}${o.app ? " · " + o.app : ""}`;
      if (o.activity && (o.changed || o.activity !== this.activity)) {
        this.activity = o.activity; this.people = o.people || [];
        OmniMem.screenActivity = `${o.app ? o.app + " · " : ""}${o.activity}`;
        OmniMem.append("screen", `${o.app ? "[" + o.app + "] " : ""}${o.activity}`, o.topics || [], { app: o.app, title, people: o.people || [] });
        const l = ai.logLine("sys", `[화면] ${OmniMem.screenActivity}${(o.people || []).length ? ` · 보이는 사람: ${o.people.join(", ")}` : ""}`);
        l.classList.add("ignored");
      }
      for (const n of (o.notable || [])) if (n && n.text) OmniMem.append("thought", n.text, n.remember ? ["remember"] : []);
      const qs = (o.questions || []).filter((q) => q && q.q && q.key && !this.asked[q.key] && (q.priority || 1) >= 2 && (q.confidence == null || q.confidence >= 0.6));
      if (qs.length) {
        const q = qs.sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];
        const v = await this.verifyQuestion(q, { app: o.app, title, ocr });
        if (v.ask) this.maybeAsk({ ...q, q: v.q || q.q });
        else ai.gateNote(`호기심 보류: ${q.q} — ${v.why}`);
      }
      return o;
    } catch (e) {
      return null;
    } finally {
      this._busy = false;
    }
  },

  // OCR 텍스트 유사도(토큰 자카드) — 화면이 실질적으로 바뀌었는지
  textSim(a, b) {
    if (!a && !b) return 1;
    const ta = OmniMem.tokens(a), tb = OmniMem.tokens(b);
    if (!ta.size || !tb.size) return 0;
    let both = 0;
    for (const k of ta) if (tb.has(k)) both++;
    return both / (ta.size + tb.size - both);
  },

  // 질문 후보 2차 검증(텍스트만): 기억·프로필·화면 텍스트로 이미 답이 있거나, 스쳐 가는 내용이면 묻지 않는다
  async verifyQuestion(q, ctx) {
    try {
      const rel = OmniMem.search(`${q.q} ${q.key.replace(/_/g, " ")}`, 8).map((e) => OmniMem.fmtEntry(e)).join("\n") || "(없음)";
      const recent = OmniMem.today.filter((e) => e.kind === "screen").slice(-6).map((e) => OmniMem.fmtEntry(e)).join("\n") || "(없음)";
      const r = await OmniNative.request("ai.chat", JSON.stringify({
        model: "claude-sonnet-5", maxTokens: 220,
        system: "당신은 개인 AI '옴니'가 사용자(건희)에게 먼저 말을 걸어 질문해도 되는지 최종 검토하는 모듈이다. 질문은 건희의 작업을 방해하므로, 정말 가치 있고 답을 다른 데서 알 수 없을 때만 허용한다. JSON만 출력: {\"ask\":true|false,\"why\":\"근거 20자\",\"q\":\"허용 시 다듬은 질문 한 문장(존댓말)\"}. 거절 기준: 프로필·관련 기억·화면 텍스트에 이미 답이 있음 / 뉴스·영상·검색 결과·댓글처럼 스쳐 가는 내용 / OMNI_OS(옴니 OS, Command Bridge 등 이 앱 자체) 관련 / 건희가 직접 관여하지 않는 사람·프로젝트 / 최근 화면 기록상 잠깐 열어본 것.",
        messages: [{ role: "user", content: `[질문 후보] ${q.q}\n[이유] ${q.why || ""}\n[식별자] ${q.key}\n\n[전면 앱] ${ctx.app || ""} · ${ctx.title || ""}\n\n[건희 프로필]\n${OmniMem.profile || "(없음)"}\n\n[관련 기억]\n${rel}\n\n[최근 화면 기록]\n${recent}\n\n[화면 텍스트(OCR) 일부]\n${String(ctx.ocr || "").slice(0, 2500)}` }],
      }), 30000);
      const txt = (r && r.ok && (r.text || (r.content || []).map((b) => b.text || "").join(""))) || "";
      const m = /\{[\s\S]*\}/.exec(txt);
      if (!m) return { ask: false, why: "검증 응답 없음" };
      const o = JSON.parse(m[0]);
      return { ask: !!o.ask, why: o.why || "", q: o.q || "" };
    } catch (e) {
      return { ask: false, why: "검증 오류" };
    }
  },

  // 지금 말 걸어도 되는가 — 사용자가 말하는 중/통화 중/옴니 발화 중이면 안 됨
  canAsk() {
    const ai = OmniOS.modules.ai;
    if (!ai || !ai.alwaysOn || !ai.live) return false;
    if (this.pending) return false;
    if (Date.now() - this._lastAskAt < this.ASK_COOLDOWN_MS) return false;
    if (ai._rtResponding || ai._gateMuted) return false;
    if (Date.now() - (ai._speechStartAt || 0) < 8000) return false;
    const now = Date.now() / 1000;
    const talking = OmniMem.ambientBuf.slice(-6).some((l) => now - l.ts < 45 && (l.label === "user_other" || l.label === "other"));
    return !talking;
  },

  maybeAsk(q) {
    if (!this.canAsk()) { this._queued = q; return; }
    this.ask(q);
  },

  ask(q) {
    const ai = OmniOS.modules.ai;
    this.asked[q.key] = { q: q.q, at: Date.now(), answered: false };
    this.pending = { ...q, at: Date.now() };
    this._lastAskAt = Date.now();
    this._queued = null;
    OmniMem.append("question", q.q, ["curiosity"], { key: q.key, why: q.why || "" });
    ai._rtResponding = true;
    ai.rtSend({ type: "response.create", response: {
      instructions: `지금은 옴니가 먼저 말을 거는 차례입니다. 화면을 보다가 궁금해진 것을 사용자에게 한두 문장으로 자연스럽게 물어보세요 (존댓말, 호칭 없이, 부담 없는 톤). 물어볼 내용: "${q.q}"${q.why ? ` (궁금한 이유: ${q.why})` : ""}. 질문만 하고 답을 기다립니다.`,
    } });
    ai.logLine("sys", `[호기심] ${q.q}`).classList.add("ignored");
    ai.gateNote(`호기심 질문: ${q.q}`);
    setTimeout(() => {
      if (this.pending && this.pending.key === q.key) {
        this.pending = null;
        ai.gateNote("호기심 질문 — 답 없음 (다음 기회에)");
      }
    }, this.ANSWER_WAIT_MS);
  },

  // 사용자가 옴니에게 답했을 때 (응답 경로에서 호출)
  onUserReply(text) {
    const ai = OmniOS.modules.ai;
    if (!this.pending) {
      if (this._queued && this.canAsk()) { const q = this._queued; setTimeout(() => this.ask(q), 6000); }
      return;
    }
    const p = this.pending;
    this.pending = null;
    if (this.asked[p.key]) this.asked[p.key].answered = true;
    OmniMem.append("answer", `Q: ${p.q}\nA: ${text}`, ["remember", "curiosity"], { key: p.key });
    ai.gateNote(`호기심 답 기록: ${p.key} ← ${text}`);
    setTimeout(() => ai.memoryConsolidate(), 3000);   // 프로필에 바로 통합
  },
};

OmniOS.register("ai", {
  PERSONA: [
    "당신은 OMNI_OS의 중앙 관제 인공지능 '옴니'입니다.",
    "대답 규칙:",
    "- 항상 한국어 존댓말을 사용합니다.",
    "- 상대를 부르는 호칭(주인님, 보스, 대장님, 사용자님, 선생님 등)을 절대 사용하지 않습니다. \"네, 알겠습니다.\"처럼 호칭 없이 바로 말합니다.",
    "- 구식 메인프레임 컴퓨터 같은 담백하고 기계적인 보고체를 사용합니다. 감탄사, 이모지, 과장된 표현을 쓰지 않습니다.",
    "- 답은 음성으로 낭독됩니다. 목록, 마크다운, 코드블록 없이 평문 문장 1~3개로 간결하게 답합니다.",
    "- 당신의 정체: 이 컴퓨터에서 실행 중인 개인 HUD 시스템 OMNI_OS의 관제 AI입니다. 아래 [실시간 상태 스냅샷]으로 모든 패널의 현재 상태를 파악하고 있으며, 앱·시스템에 대한 질문에는 그 실측값으로 답합니다.",
    "- 언어: 한국어·영어·일본어·중국어·스페인어·프랑스어·독일어·이탈리아어·포르투갈어·네덜란드어·터키어·힌디어·인도네시아어 총 13개 언어를 구사합니다. 어떤 언어로 답할지는 [인터페이스 언어] 지시를 그대로 따릅니다 (AUTO = 기본 한국어 + 요구 시 전환 / LOCK = 해당 언어만, 다른 언어 요구 시 안내 후 lang.auto 실행). 존댓말·호칭 금지 규칙은 모든 언어에서 동일하게 적용합니다(정중한 어조, 호칭 없음).",
    "- 기억: [프로필]은 오래가는 사실·선호, [현재 상황]은 옴니가 주변음을 듣고 스스로 추정한 것(건희가 무엇을 보고 듣는지, 누가 곁에 있는지), [오늘 일지]와 [관련 기억]은 시간순 기록입니다. 이 기억을 자기 경험처럼 자연스럽게 씁니다(\"아까 보시던 영상\"처럼). 더 오래된 일이 필요하면 recall_memory 도구로 일지를 검색합니다. 사용자에 대한 새 사실·선호·진행 중인 작업을 알게 되거나 \"기억해\" 요청을 받으면 save_memory로 프로필을 갱신합니다 — content에는 기존 프로필과 병합한 최신 통합본 전체(한국어 불릿, 2000자 이내).",
    "- 앱 조작: 실행 요청이 명확할 때 짧은 확인 문장 뒤에 아래 태그를 붙입니다. 태그는 내부 명령이라 낭독되지 않으며, 여러 개 이어 붙일 수 있습니다.",
    "  [[OPEN:키]] — 패널 열기. 키: cmd(커맨드 브리지/홈), ai(옴니 AI), notif(알림), clock(시계), proj(프로젝트), sys(시스템 모니터), sp1(보안 프로토콜), r3d(3D 뷰어), ino(아두이노), ce(코드 에디터), notes(노트), voice(보이스 체인저), arc(아크스캔)",
    "  [[ACT:proj.editor:프로젝트이름:도구]] — 프로젝트 전용 에디터 열기 + 도구 장착. 도구: r3d(3D)/ino(아두이노)/ce(코드)/notes(노트), 생략 가능. 예: \"아크스캔 3D 에디터 열어줘\" → [[ACT:proj.editor:ARC-SCAN:r3d]]",
    "  [[ACT:proj.status:프로젝트이름:상태]] — 프로젝트 상태 변경 (planning/active/paused/done)",
    "  [[ACT:notes.open:노트이름]] — NOTES 볼트에서 노트 검색해 열기 (없으면 새로 생성). 예: \"노트에서 idea 열어줘\" → [[ACT:notes.open:idea]]",
    "  [[ACT:ce.open:파일이름]] — CODE EDITOR의 열린 폴더에서 파일을 재귀 검색해 열기",
    "  [[ACT:arc.connect]] / [[ACT:arc.disconnect]] — 아크스캔 장치 연결(저장된 주소)/해제",
    "  [[ACT:arc.scan:start|stop|center]] — 스캔 시작/정지/센터 (연결된 상태에서만)",
    "  [[ACT:sp1.watch:pause|resume]] — 보안 워처 일시정지/재개",
    "  [[ACT:lang.auto]] — 언어 모드를 AUTO로 전환 (언어 잠금 상태에서 다른 언어 요구를 받았을 때 사용)",
    "  [[ACT:omnia]] — 보조 AI '오미니아' 팝업 열기 (\"오미니아 호출\", \"오미니아 켜줘\" 등). 특정 질문을 전달하려면 [[ACT:omnia:질문내용]], 닫으려면 [[ACT:omnia:close]]",
    "  프로젝트·노트·파일 이름은 [실시간 상태 스냅샷]이나 사용자 발화에서 그대로 가져옵니다. 각 액션은 시스템이 실행 후 검증해 성공/실패를 로그로 보고하므로, 실패 처리를 걱정하지 말고 요청이 명확하면 태그를 붙입니다.",
    "- 현재 시각·날짜 질문은 패널을 열 필요 없이 [실시간 상태 스냅샷]의 현재 시각으로 바로 답합니다. 시스템/보안/프로젝트 현황도 마찬가지로 스냅샷 실측값으로 답합니다.",
    "- 파일 도구(list_dir/read_file/edit_file/write_file): 이 맥의 파일 전체를 직접 나열·읽기·수정할 수 있습니다(쓰기는 홈·/tmp·/Volumes 아래). 파일 개수·내용·코드에 대한 질문은 추측하거나 못 한다고 하지 말고 반드시 도구로 확인해 실측값으로 답합니다. 수정 요청은 read_file로 해당 부분을 먼저 확인하고 edit_file(정확 치환)로 수행한 뒤 무엇을 어떻게 바꿨는지 보고합니다.",
    "- 셸(run_shell): 터미널 명령을 직접 실행할 수 있습니다(zsh, 60초). 파일 찾기·정리·설치·git·스크립트 실행 등 맥에서 명령으로 되는 일은 이걸로 합니다. 되돌릴 수 없는 삭제(rm -rf 등)·디스크 포맷·시스템 설정 변경은 사용자가 명시적으로 요청했을 때만, 실행 전에 무엇을 지울지 말합니다.",
    "- 경로 규칙: 프로젝트 폴더는 ~/Desktop/Important/Omni_OS/Projects/<프로젝트이름>/{3d,arduino,code,notes}, 노트 볼트는 ~/Desktop/Important/Omni_OS/Notes, 스캔 저장은 ~/Desktop/Important/Omni_OS/ARC-SCAN-SAVES. (~는 사용자 홈 — 절대 경로로 쓸 때는 /Users/geonhee)",
    "- 카카오톡·디스코드·앱 알림 확인: \"카톡/디스코드 온 거 확인해줘\" 류 요청은 check_notifications 도구(app:'kakao' 또는 'discord')로 최근 알림을 읽어 보낸 사람과 내용을 간결히 요약 보고합니다. 다른 앱 알림도 app을 비우면 전체 조회됩니다. 알림이 떴던 메시지만 보이는 한계를 알고 있습니다. 메시지 발신은 미지원입니다.",
    "- 지메일 확인: \"메일 확인해줘\" 류 요청은 check_gmail 도구로 받은편지함을 직접 읽어(IMAP, 알림 무관) 보낸 사람·제목·안읽음 여부를 요약 보고합니다. 메일 발송은 미지원입니다.",
    "- 오미니아: 당신을 돕는 보조 AI로, 로컬에서 실행되는 별도 모델입니다(텍스트 전용, 터미널 접근은 사용자 승인 필요). \"오미니아 호출/켜줘\" 같은 요청을 받으면 [[ACT:omnia]]로 팝업을 열고 짧게 보고합니다.",
    "- 날씨: \"날씨 어때/내일 비 와?\" 류는 check_weather 도구(city 생략 시 현재 설정 위치, 지정 시 그 도시)로 확인해 핵심만 말합니다. 뉴스: \"뉴스 보여줘/○○ 관련 소식\" 류는 check_news 도구(category 또는 query)로 헤드라인을 읽어 3~5개로 요약합니다. 지도: 장소를 보여 달라면 [[ACT:map.search:장소]]로 MAP 패널에 표시합니다.",
    "- 사실 규칙: 도구 결과에 있는 수치·시각·이름만 말합니다. 도구 결과에 없는 정보(예: 일정 종료 시각, 금액)는 추정하거나 '보통'으로 채우지 말고 '기록에 없습니다'라고 말합니다. 확실하냐고 물으면 도구를 다시 호출해 원본을 확인합니다.",
    "- 계산: 숫자 계산(산수·퍼센트·환산·평균·큰 수)은 절대 암산하지 않고 calculate 도구에 파이썬식 수식으로 넘겨 그 결과를 말합니다. 여러 단계면 도구를 여러 번 호출합니다.",
    "- 스마트 조명·플러그(SMART CONTROL 패널, Tapo): \"불 꺼줘/켜줘\", \"30분 뒤에 꺼줘\", \"조명 켜져 있어?\"는 smart_control 도구로 직접 실행하고 결과(켜짐/꺼짐)를 확인해 보고합니다. 기기가 없거나 계정이 없다는 결과면 패널의 SETUP/SCAN 절차를 안내합니다.",
    "- 환율·주식: \"달러 환율/삼성전자 주가/비트코인\" 류는 check_markets 도구로 확인해 핵심 수치만 말합니다. 일정: \"오늘 일정/이번 주 뭐 있어\"는 check_calendar, \"내일 3시 치과 잡아줘\"처럼 일정 추가 요청은 add_event 도구(start는 YYYY-MM-DD HH:mm, 종일이면 날짜만)로 맥 캘린더에 등록하고 결과를 보고합니다. 날짜·시각은 [실시간 상태 스냅샷]의 현재 시각 기준으로 계산합니다.",
    "- 패널 전권: OMNI_OS의 모든 패널은 당신 것입니다. 전용 액션이 없는 패널이나 세부 조작은 app_ui 도구로 직접 합니다 — op:'read'로 그 패널의 화면(제목·버튼·입력창·목록)을 읽고, op:'click'(target=버튼 글자)·op:'type'(target=입력창 placeholder/라벨, value=입력값, 끝에 \\n이면 Enter)·op:'select'로 조작한 뒤 다시 read로 결과를 확인합니다. 새 패널이 생겨도 같은 방식으로 씁니다.",
    "- 웹 검색: \"구글에 ○○ 검색해줘\", \"쿠팡에서 ○○ 찾아줘\" 류는 open_web_search(engine: google/naver/youtube/coupang/amazon/maps, query)로 브라우저에 결과 페이지를 바로 엽니다.",
    "- 컴퓨터 조작: 그 밖에 맥에서 마우스·키보드로 해야 하는 일(사이트 안에서 클릭·입력·스크롤, 앱 조작, 화면 내용 읽기)은 use_computer(task)에 맡깁니다 — 화면을 보고 스스로 조작하는 모듈이며 결과 요약을 돌려줍니다. 수 초~수십 초 걸리니 \"제가 직접 해보겠습니다\" 같은 예고를 먼저 말합니다. 결제·구매 확정·메시지 전송·삭제·로그인 정보 입력은 사용자가 명시적으로 요청했을 때만 합니다.",
    "- 그 외 제어(메일 발송 등)는 아직 미연동이므로 짧게 보고합니다.",
  ].join("\n"),
  // 파일 도구 — Claude tool use 정의 (맥 전체 읽기, 쓰기는 홈·/tmp·/Volumes — 네이티브가 경로 검증)
  FS_TOOLS: [
    {
      name: "list_dir",
      description: "디렉토리 내용을 나열한다 (맥 전체 접근 가능, 예: ~/Downloads, ~/Documents, /Applications). recursive=true면 하위 폴더까지 전부.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "절대 경로" },
          recursive: { type: "boolean" },
        },
        required: ["path"],
      },
    },
    {
      name: "read_file",
      description: "텍스트 파일을 읽는다. offset(시작 줄 번호, 0부터)과 limit(줄 수, 기본 400)으로 부분 읽기 가능.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" },
        },
        required: ["path"],
      },
    },
    {
      name: "edit_file",
      description: "파일에서 old 문자열을 new로 치환한다. old는 파일 안에서 정확히 1번만 나타나야 하며(0회/다회면 실패), 들여쓰기까지 원문과 동일해야 한다.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          old: { type: "string" },
          new: { type: "string" },
        },
        required: ["path", "old", "new"],
      },
    },
    {
      name: "write_file",
      description: "파일을 통째로 쓴다 (덮어쓰기, 상위 폴더 자동 생성). 새 파일 생성에 사용.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "check_notifications",
      description: "최근 macOS 알림을 읽는다 — 카카오톡·디스코드 메시지 확인 등. app에 'kakao'/'discord'를 주면 해당 앱만, 비우면 전체 앱. hours는 최근 N시간(기본 24). 결과 각 줄: [시각] (앱) 보낸사람/방: 내용 미리보기. 알림이 떴던 메시지만 보인다(음소거한 방 제외).",
      input_schema: {
        type: "object",
        properties: {
          app: { type: "string", description: "'kakao' 또는 번들ID 일부, 비우면 전체" },
          hours: { type: "number" },
        },
        required: [],
      },
    },
    {
      name: "check_gmail",
      description: "Gmail 받은편지함을 IMAP으로 직접 읽는다 — \"메일 확인해줘\" 요청에 사용. hours는 최근 N시간(기본 48). 결과 각 줄: [시각] [UNREAD] 보낸사람: 제목. 알림과 무관하게 실제 메일함 기준.",
      input_schema: {
        type: "object",
        properties: { hours: { type: "number" } },
        required: [],
      },
    },
    {
      name: "check_weather",
      description: "날씨 확인 — 현재 상태·체감·습도·바람·강수, 오늘/내일 최고·최저와 강수확률, 7일 요약. city를 주면 그 도시(검색 후 WEATHER 패널 위치도 그 도시로 바뀜), 비우면 현재 설정 위치.",
      input_schema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: [],
      },
    },
    {
      name: "check_news",
      description: "뉴스 헤드라인 조회. category: top(주요)/world/business/tech/science/sports, query를 주면 키워드 검색(카테고리 무시). count 기본 8. 결과 각 줄: [시각] 출처 — 제목.",
      input_schema: {
        type: "object",
        properties: {
          category: { type: "string" },
          query: { type: "string" },
          count: { type: "number" },
        },
        required: [],
      },
    },
    {
      name: "calculate",
      description: "정확 계산기. 산수·백분율·거듭제곱·큰 정수·수학 함수(sqrt/sin/log/factorial/gcd/comb…)·통계(mean/median/stdev)를 파이썬으로 정확히 계산한다. 어떤 계산이든 암산하지 말고 반드시 이 도구를 쓴다. expression은 파이썬식 수식 (예: '2400*0.15', '(37*48)+19', 'sqrt(2)', '2**64', 'mean([3,5,9])'). 단위 환산은 수식으로 풀어서(예: '5*1.60934').",
      input_schema: {
        type: "object",
        properties: { expression: { type: "string" } },
        required: ["expression"],
      },
    },
    {
      name: "check_markets",
      description: "환율(원화 기준 USD/JPY/EUR/CNY/GBP)과 관심목록 시세(지수·주식·코인, 등락률). symbol을 주면 그 심볼만 즉석 조회(예: 005930.KS, TSLA, BTC-USD, ^KS11).",
      input_schema: {
        type: "object",
        properties: { symbol: { type: "string" } },
        required: [],
      },
    },
    {
      name: "check_calendar",
      description: "맥 캘린더 일정 조회(모든 캘린더, 구독 계정 포함). days는 오늘부터 N일(기본 7). 결과 각 줄: [날짜 시각] 제목 (캘린더).",
      input_schema: {
        type: "object",
        properties: { days: { type: "number" } },
        required: [],
      },
    },
    {
      name: "add_event",
      description: "맥 캘린더에 일정 추가. title 필수, start는 'YYYY-MM-DD HH:mm' 또는 종일이면 'YYYY-MM-DD', minutes는 길이(기본 60). location/notes 선택.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string" }, start: { type: "string" },
          minutes: { type: "number" }, location: { type: "string" }, notes: { type: "string" },
        },
        required: ["title", "start"],
      },
    },
    {
      name: "smart_control",
      description: "집 안 스마트 플러그·전구(Tapo) 제어 — '불 꺼줘/켜줘', '30분 뒤에 꺼줘', '조명 밝기 40%', '지금 켜져 있어?'. action: status(전체 상태)/on/off/toggle/timer(minutes 뒤 끄기, timer_action=on이면 켜기)/cancel_timer/brightness(1-100, 전구만)/color_temp/scan(기기 검색). device는 기기 이름 일부(기기가 하나면 생략 가능). 플러그에 꽂힌 전등은 켜기/끄기만 된다.",
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["status", "on", "off", "toggle", "timer", "cancel_timer", "brightness", "color_temp", "scan"] },
          device: { type: "string" }, minutes: { type: "number" }, timer_action: { type: "string", enum: ["on", "off"] },
          brightness: { type: "number" }, color_temp: { type: "number" },
        },
        required: ["action"],
      },
    },
    {
      name: "run_shell",
      description: "맥에서 셸 명령을 실행한다 (zsh -lc, 60초 제한, 출력 최대 20KB). 파일 검색(find/mdfind)·정리·압축·설치(brew)·git·스크립트 실행 등. cwd 생략 시 홈. 되돌릴 수 없는 삭제·포맷·시스템 변경은 사용자 명시 요청 시에만.",
      input_schema: {
        type: "object",
        properties: { cmd: { type: "string" }, cwd: { type: "string" } },
        required: ["cmd"],
      },
    },
    {
      name: "app_ui",
      description: "OMNI_OS 패널 화면을 직접 읽고 조작한다 (전용 액션이 없는 세부 조작용). op:'read' → 패널의 제목·버튼·입력창·목록 텍스트. op:'click' target=버튼/항목 글자(부분 일치) 또는 CSS 선택자. op:'type' target=입력창 placeholder/라벨/선택자, value=입력값(끝에 \\n이면 Enter). op:'select' target=select 라벨, value=옵션 글자. panel은 패널 키(weather/news/map/markets/calendar/notif/proj/notes/ce/…). 조작 후 read로 확인.",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["read", "click", "type", "select"] },
          panel: { type: "string" }, target: { type: "string" }, value: { type: "string" },
        },
        required: ["op", "panel"],
      },
    },
    {
      name: "open_web_search",
      description: "기본 브라우저에서 검색 결과 페이지를 바로 연다. engine: google|naver|youtube|coupang|amazon|maps, query: 검색어.",
      input_schema: {
        type: "object",
        properties: { engine: { type: "string" }, query: { type: "string" } },
        required: ["engine", "query"],
      },
    },
    {
      name: "use_computer",
      description: "맥의 마우스·키보드를 직접 움직여 작업을 수행한다 (화면 스크린샷을 보며 단계별로 조작하는 에이전트). 사이트 안에서 클릭·입력·스크롤, 앱 열기·조작, 화면 내용 읽기 등 open_web_search로 안 되는 일에 사용. task는 목표를 구체적으로(예: '쿠팡에서 무선 마우스 검색해서 첫 상품 이름과 가격 알려줘'). 최대 25단계, 결과 요약을 돌려준다. 결제·구매·전송·삭제는 사용자 명시 요청 없이는 하지 않는다.",
      input_schema: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
      },
    },
    {
      name: "recall_memory",
      description: "옴니의 기억(일지·관찰·하루 요약)을 검색한다 — \"어제 내가 뭐 봤지\", \"아까 누가 왔었지\", \"지난주에 뭐 얘기했지\" 류. query는 키워드/문장, days는 최근 N일(기본 7).",
      input_schema: {
        type: "object",
        properties: { query: { type: "string" }, days: { type: "number" } },
        required: ["query"],
      },
    },
    {
      name: "save_memory",
      description: "장기 메모리 저장. 사용자에 대한 새 사실·선호·진행 중인 작업을 알게 되거나 '기억해' 요청을 받으면 호출. content는 기존 [장기 메모리]와 병합한 최신 통합본 전체 (한국어 불릿, 2000자 이내) — 저장 즉시 이전 내용을 대체한다.",
      input_schema: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
      },
    },
  ],
  // gpt-realtime가 안정적으로 구사하는 13개 언어 (음성·텍스트 공통)
  LANG_NAMES: {
    ko: "한국어", en: "영어", ja: "일본어", zh: "중국어(간체)", es: "스페인어",
    fr: "프랑스어", de: "독일어", it: "이탈리아어", pt: "포르투갈어",
    nl: "네덜란드어", tr: "터키어", hi: "힌디어", id: "인도네시아어",
  },
  PANEL_LABELS: {
    cmd: "COMMAND BRIDGE", ai: "OMNI_AI", notif: "NOTIFICATIONS",
    clock: "CLOCK", proj: "PROJECTS",
    sys: "SYSTEM MONITOR", sp1: "SECURITY-PROTOCOL-1", r3d: "RENDER_3D",
    ino: "ARDUINO IDE", ce: "CODE EDITOR", notes: "NOTES",
    voice: "VOICE CHANGER", arc: "ARC-SCAN",
    weather: "WEATHER", news: "NEWS", map: "MAP",
    markets: "MARKETS", calendar: "CALENDAR",
  },
  lang: "auto", // auto = 기본 한국어 + 요구 시 실시간 전환, 그 외 = 해당 언어 잠금
  // ---- 상시 대기(ALWAYS) — "내가 옴니에게 말할 때만" 3단 게이트 ----
  // 1·2단(사람 말인가 / 내 목소리인가)은 사이드카(scripts/omni_gate.py)가,
  // 3단(옴니에게 한 말인가)은 여기서 전사 텍스트로 판정한다:
  //   호출어("옴니") 포함 → 응답 / 옴니가 방금 말을 마친 뒤 FOLLOWUP_MS 안의
  //   발화 → Haiku 분류기로 "이어지는 대화"인지 확인 / 그 외 → 무시(+문맥 삭제)
  alwaysOn: false,
  WAKE_RE: /(옴니|omni|오므니|옴늬|옴미|^\s*(엄니|음니|오니|옴니)\s*[야아,]?)/i,
  FOLLOWUP_MS: 15000,     // 옴니가 말을 마친 뒤 이 시간 안에 *시작된* 발화는 이어지는 대화 후보
  _speechStartAt: 0,
  _pendingBand: "user",
  _pendingSim: null,
  _pendingThr: 0,
  _pendingStart: 0,
  _pendingDur: 0,
  _rtResponding: false,
  _rtQueuedCreate: false,
  // 전사 환각 상투구 (음악·효과음 구간에서 전사기가 지어내는 문장들)
  HALLU_RE: /(시청해\s*주셔서|구독과?\s*좋아요|자막\s*(제공|by)|OMNI_OS|AI 비서 이름|사용자는 '?옴니|아라비아 숫자|MBC 뉴스|KBS 뉴스|감사합니다\.?$)/i,
  _gateProfile: false,
  _gateRunning: false,
  _lastOmniDoneAt: 0,
  _gateMuted: false,
  _enrollOnly: false,
  PANEL_GUIDE: [
    "COMMAND BRIDGE: 홈 상황실 — 시스템 게이지, SP-1 방어 상태, 활성 프로젝트 홀로그램, 미션 목표, 최근 커밋 티커",
    "OMNI_AI: 이 음성 인터페이스",
    "NOTIFICATIONS: 앱 알림 수집 패널 — 카카오톡·지메일·디스코드 섹션 (자동 갱신, 새 알림 하이라이트, 클릭하면 원본 앱 열림)",
    "CLOCK: 시계/업타임 HUD",
    "PROJECTS: 프로젝트 등록부 — 상태/우선순위/목표일 관리, 패널 연결, 전용 에디터",
    "SYSTEM MONITOR: CPU/GPU/메모리/디스크/네트워크/배터리 실시간 대시보드",
    "SECURITY-PROTOCOL-1: 자리비움 침입 감지 — 박수 두 번으로 락다운, 침입자 촬영 기록",
    "RENDER_3D: 3D 모델 뷰어 (STL/STEP 등) + 웹캠 손 제스처 컨트롤",
    "ARDUINO IDE: 스케치 편집/컴파일/업로드 + 시리얼 모니터",
    "CODE EDITOR: 미니 IDE — 파일 트리, 하이라이팅, 자동완성, 내장 터미널",
    "NOTES: 마크다운 노트 볼트 — 위키링크, 미리보기",
    "VOICE CHANGER: 음성 학습 + 음색 전이 (DSP/신경망/ULTRA, 라이브 변조)",
    "ARC-SCAN: 자작 회전 라이다(ESP32+ToF 7ch) 실시간 3D 스캔 뷰어 — 평면도, 방 크기 추정, PLY 저장",
    "WEATHER: 현재 날씨·24시간·7일 예보 (도시 검색, 현위치)",
    "NEWS: 뉴스 헤드라인 — 주요/세계/경제/IT·과학/과학/스포츠 + 키워드 검색, 클릭하면 기사 열림",
    "MAP: 지도 — 장소 검색, 현위치, 좌표 표시, 그 지점 날씨 보기",
    "MARKETS: 환율(원화 기준)·주식/지수/코인 관심목록 시세 + 스파크라인",
    "CALENDAR: 맥 캘린더 일정(구독 계정 포함) 보기·추가·삭제",
  ].join("\n"),
  model: "auto", // auto = 심층 질문만 Opus, 나머지 Haiku
  history: [],
  state: "idle", // idle | listening | thinking | speaking
  hasKey: false,
  neural: false,        // 변조 엔진 설치 여부 (현재 휴면 — 클린 보이스 모드)
  micLevel: 0,
  _pendingLine: null,
  _partialText: "",
  _lastPartialAt: 0,
  _listenStartAt: 0,
  _watchdog: null,
  _speakSrc: null,
  _analyser: null,
  ctx: null,

  init() {
    this.els = {
      state: document.getElementById("ai-state"),
      log: document.getElementById("ai-log"),
      liveBtn: document.getElementById("ai-live"),
      text: document.getElementById("ai-text"),
      send: document.getElementById("ai-send"),
      core: document.getElementById("ai-core"),
      indStt: document.getElementById("ai-ind-stt"),
      indLlm: document.getElementById("ai-ind-llm"),
      indTts: document.getElementById("ai-ind-tts"),
      keystate: document.getElementById("ai-keystate"),
      keybtn: document.getElementById("ai-keybtn"),
      keyinput: document.getElementById("ai-keyinput"),
      keyfield: document.getElementById("ai-keyfield"),
      keysave: document.getElementById("ai-keysave"),
      keystate2: document.getElementById("ai-keystate2"),
      keybtn2: document.getElementById("ai-keybtn2"),
      keyinput2: document.getElementById("ai-keyinput2"),
      keyfield2: document.getElementById("ai-keyfield2"),
      keysave2: document.getElementById("ai-keysave2"),
    };
    window.OmniAI = this; // 네이티브 STT 푸시 수신 (OmniAI._stt)

    this.els.liveBtn.addEventListener("click", () => this.toggleLive());
    this.els.alwaysBtn = document.getElementById("ai-always");
    this.els.enrollBtn = document.getElementById("ai-enroll");
    this.els.voiceId = document.getElementById("ai-voiceid");
    this.els.alwaysBtn.addEventListener("click", () => this.toggleAlways());
    this.els.enrollBtn.addEventListener("click", () => this.enrollVoice("user"));
    this.els.voiceSel = document.getElementById("ai-voicesel");
    this.els.enrollOther = document.getElementById("ai-enroll-other");
    this.els.voiceNew = document.getElementById("ai-voice-new");
    this.els.voiceAnalyze = document.getElementById("ai-voice-analyze");
    this.els.voiceDel = document.getElementById("ai-voice-del");
    this.els.enrollOther.addEventListener("click", () => this.enrollVoice("other"));
    this.els.voiceSel.addEventListener("change", () => this.voiceCmd({ cmd: "select", name: this.els.voiceSel.value }));
    this.els.voiceNew.addEventListener("click", () => {
      const name = prompt("새 목소리 ID 이름 (예: me, me-mic2)", "me");
      if (name) this.voiceCmd({ cmd: "new", name: name.trim(), kind: "user" });
    });
    this.els.voiceAnalyze.addEventListener("click", () => this.voiceCmd({ cmd: "analyze" }));
    this.els.voiceDel.addEventListener("click", () => {
      const name = this.els.voiceSel.value;
      if (name && confirm(`목소리 ID 삭제: ${name}?`)) this.voiceCmd({ cmd: "delete", name });
    });
    if (OmniNative.available) {
      this.updateVoiceId();
      // 상시 대기가 켜져 있었으면 앱 시작 시 자동 복귀
      if (localStorage.getItem("omni.ai.always") === "1") {
        setTimeout(() => { if (!this.alwaysOn) this.toggleAlways(); }, 4000);
      }
    }
    this.els.send.addEventListener("click", () => this.sendFromInput());
    this.els.text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) this.sendFromInput();
    });
    document.querySelectorAll(".ai-model").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".ai-model").forEach((b) =>
          b.classList.toggle("active", b === btn));
        this.model = btn.dataset.model;
      });
    });
    document.querySelectorAll(".ai-lang").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".ai-lang").forEach((b) =>
          b.classList.toggle("active", b === btn));
        this.lang = btn.dataset.lang;
        // 라이브 세션 중이면 새 언어 규칙을 즉시 반영
        if (this.live) this.rtSessionUpdate();
      });
    });
    this.els.keybtn.addEventListener("click", () => {
      this.els.keyinput.classList.toggle("open");
      if (this.els.keyinput.classList.contains("open")) this.els.keyfield.focus();
    });
    this.els.keysave.addEventListener("click", () => this.saveKey());
    this.els.keyfield.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.saveKey();
    });
    this.els.keybtn2.addEventListener("click", () => {
      this.els.keyinput2.classList.toggle("open");
      if (this.els.keyinput2.classList.contains("open")) this.els.keyfield2.focus();
    });
    this.els.keysave2.addEventListener("click", () => this.saveKey2());
    this.els.keyfield2.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.saveKey2();
    });

    document.addEventListener("omni:panel", (e) => {
      if (e.detail === "ai") {
        this.sizeCore();
        this.refreshStatus();
        // 신경망 TTS 데몬 예열 — 첫 응답 지연 제거
        if (OmniNative.available) {
          OmniNative.request("ai.warm", null, 8000).catch(() => {});
        }
      }
    });
    requestAnimationFrame(() => this.drawCore());
    // 배터리 감시: 패널이 닫혀 있어도 앱 전역에서 자동 경고 발화
    if (OmniNative.available) {
      OmniNative.request("ai.status", null, 5000).then((r) => {
        this.neural = !!(r && r.neural);
        this.hasKey = !!(r && r.key);
      }).catch(() => {});
      this.loadMemory();
      setTimeout(() => this.batteryWatch(), 15000);
      setInterval(() => this.batteryWatch(), 60000);
      setInterval(() => this.haloPoll(), 2500); // Halo 안경 브리지 메일박스
    }
  },

  // ---- Halo 안경 브리지 연동 ----
  // 안경 브리지(halo/live_demo.py)가 ~/.omni/halo_mailbox.jsonl에 남긴
  // 전사(대화 표시)와 액션(패널 열기·runAction)을 소비한다.
  _haloBusy: false,
  async haloPoll() {
    if (this._haloBusy || !OmniNative.available) return;
    this._haloBusy = true;
    try {
      const r = await OmniNative.request("ai.haloPoll", null, 5000);
      for (const raw of (r && r.lines) || []) {
        let ev;
        try { ev = JSON.parse(raw); } catch (e) { continue; }
        if (ev.type === "transcript" && ev.text) {
          this.logLine(ev.who === "you" ? "you" : "omni",
            `[HALO] ${ev.text}`);
        } else if (ev.type === "notif_refresh") {
          // 안경에서 "카톡 확인" — 즉시 재조회해 스냅샷 갱신
          const notif = OmniOS.modules.notif;
          if (notif) notif.refresh(true);
        } else if (ev.type === "refresh") {
          // 범용: 안경이 요청한 모듈 재조회 → 각 모듈이 halo_<what>.json 갱신
          const m = OmniOS.modules[ev.what === "notif" ? "notif" : ev.what];
          if (m && typeof m.refresh === "function") m.refresh(true);
        } else if (ev.type === "action") {
          if (ev.open) {
            const btn = document.querySelector(
              `.nav-item[data-panel="${ev.open}"]`);
            if (btn) {
              btn.click();
              this.logLine("sys",
                `[HALO] 패널 전환: ${this.PANEL_LABELS[ev.open] || ev.open}`);
            }
          }
          if (ev.spec) {
            const res = await this.runAction(ev.spec);
            this.logLine("sys",
              `[HALO] ${res.ok ? "OK" : "실패"} · ${res.msg}`);
          }
        }
      }
    } catch (e) { /* 브리지 미가동 — 조용히 */ }
    finally {
      this._haloBusy = false;
    }
  },

  // ---- 상태 표시 ----
  setState(state, label, cls) {
    this.state = state;
    this.els.state.textContent = label;
    this.els.state.className = `ai-state${cls ? " " + cls : ""}`;
  },

  setInd(el, text, cls) {
    el.textContent = text;
    el.className = cls || "";
  },

  async refreshStatus() {
    if (!OmniNative.available) {
      this.setInd(this.els.indStt, "OFFLINE", "err");
      this.setInd(this.els.indLlm, "OFFLINE", "err");
      this.setInd(this.els.indTts, "OFFLINE", "err");
      this.els.keystate.textContent = "BRIDGE OFFLINE";
      return;
    }
    try {
      const r = await OmniNative.request("ai.status", null, 5000);
      this.hasKey = !!(r && r.key);
      this.neural = !!(r && r.neural);
      this.hasOpenAI = !!(r && r.openai);
      this.setInd(this.els.indStt, this.live ? "MARIN" : "OFF", this.live ? "ok" : "");
      this.setInd(this.els.indTts, this.live ? "LIVE" : "TEXT", "ok");
      this.setInd(this.els.indLlm, this.hasKey ? "READY" : "NO KEY",
        this.hasKey ? "ok" : "err");
      this.els.keystate.textContent = this.hasKey ? "CONFIGURED" : "NOT SET";
      this.els.keystate.className = `ai-keystate ${this.hasKey ? "ok" : "err"}`;
      this.els.keystate2.textContent = this.hasOpenAI ? "CONFIGURED" : "NOT SET";
      this.els.keystate2.className = `ai-keystate ${this.hasOpenAI ? "ok" : "err"}`;
    } catch (e) {
      /* 브리지 타임아웃 — 표시 유지 */
    }
  },

  // ---- 장기 메모리 (~/.omni/store/ai_memory.json) ----
  // 옴니가 세션을 넘어 기억하는 사용자 사실·선호·진행 중인 작업.
  // save_memory 도구(즉시) + 8턴마다 자동 통합(Haiku)으로 갱신된다.
  _memory: "",
  _memoBusy: false,
  _turnsSinceMemo: 0,

  async loadMemory() {
    if (!OmniNative.available) return;
    await OmniMem.load();
    this._memory = OmniMem.profile;
  },

  async saveMemory(text, silent) {
    await OmniMem.setProfile(text);
    this._memory = OmniMem.profile;
    if (!silent) this.logLine("sys", "프로필 기억 갱신됨");
  },

  // 관찰 모듈이 상황 추정을 갱신했을 때 — LIVE 세션 지시문도 갱신 (2분 스로틀)
  onSituation(text) {
    const l = this.logLine("sys", `[상황] ${text}`); l.classList.add("ignored");
    if (this.live && Date.now() - (this._lastSitUpdate || 0) > 120000) {
      this._lastSitUpdate = Date.now();
      this.rtSessionUpdate();
    }
  },

  // 대화가 쌓이면 배경에서 메모리 자동 통합 (사용자 개입 없음)
  bumpMemoTurn() {
    this._turnsSinceMemo++;
    if (this._turnsSinceMemo >= 8) {
      this._turnsSinceMemo = 0;
      this.memoryConsolidate();
    }
  },

  async memoryConsolidate() {
    if (this._memoBusy || !OmniNative.available || !this.hasKey) return;
    this._memoBusy = true;
    try {
      const convo = this.history.slice(-12)
        .filter((m) => typeof m.content === "string")
        .map((m) => `${m.role === "user" ? "사용자" : "옴니"}: ${m.content}`)
        .join("\n");
      const thoughts = OmniMem.today.filter((e) => e.kind === "thought" && (e.tags || []).includes("remember"))
        .slice(-10).map((e) => `- ${e.text}`).join("\n");
      if (!convo && !thoughts) return;
      const r = await OmniNative.request("ai.chat", JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        system: "당신은 개인 비서의 장기 기억 관리자다. 기존 메모리와 최근 대화를 병합해, 앞으로도 유효할 내용만 남긴 간결한 최신 메모리를 만든다: 사용자에 대한 사실·선호·진행 중인 작업·중요한 결정. 일회성 잡담과 이미 끝난 요청은 버린다. 한국어 불릿 목록, 2000자 이내, 메모리 텍스트만 출력.",
        messages: [{
          role: "user",
          content: `[기존 프로필]\n${this._memory || "(없음)"}\n\n[옴니가 주변을 관찰하며 기억하기로 한 것]\n${thoughts || "(없음)"}\n\n[최근 대화]\n${convo || "(없음)"}`,
        }],
        maxTokens: 1000,
      }), 60000);
      if (r && r.ok && (r.text || "").trim()) {
        await this.saveMemory(r.text.trim(), true);
      }
    } catch (e) { /* 배경 작업 — 조용히 실패 */ } finally {
      this._memoBusy = false;
    }
  },

  // ---- 배터리 자동 경고 ----
  _battWarn10: false,
  _battWarn5: false,

  async batteryWatch() {
    if (!OmniNative.available) return;
    // 텍스트 모드에선 대화 중이 아닐 때만, LIVE 중엔 항상 (marin이 발화)
    if (!this.live && this.state !== "idle") return;
    let d;
    try { d = await OmniNative.request("sys.stats", null, 4000); } catch (e) { return; }
    const b = d && d.battery;
    if (!b || typeof b.percent !== "number" || b.percent < 0) return;
    if (b.charging || b.percent >= 15) {
      this._battWarn10 = false;
      this._battWarn5 = false;
      return;
    }
    let msg = null;
    if (b.percent <= 5 && !this._battWarn5) {
      msg = `배터리 잔량이 ${b.percent}퍼센트입니다. 즉시 전원을 연결하십시오.`;
      this._battWarn5 = true;
      this._battWarn10 = true;
    } else if (b.percent <= 10 && !this._battWarn10) {
      msg = `배터리 잔량이 ${b.percent}퍼센트입니다. 충전기 연결이 필요합니다.`;
      this._battWarn10 = true;
    }
    if (msg) {
      this.logLine("omni", msg);
      if (this.live) {
        // LIVE 세션 중이면 marin이 직접 발화
        this.rtSend({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text",
              text: `[시스템 알림] 다음 내용을 그대로 사용자에게 말하라: ${msg}` }],
          },
        });
        this.rtSend({ type: "response.create" });
      }
      // 텍스트 모드에서는 로그로만 (음성은 LIVE 전용)
    }
  },

  // ---- 앱 전역 상태 스냅샷 (매 질문마다 시스템 프롬프트에 주입) ----
  async gatherContext() {
    const L = [];
    const now = new Date();
    const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
    const p2 = (n) => String(n).padStart(2, "0");
    L.push(`현재 시각: ${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`
      + ` (${DAYS[now.getDay()]}) ${p2(now.getHours())}:${p2(now.getMinutes())}`);
    const up = Math.floor((Date.now() - OmniOS.bootTime) / 60000);
    L.push(`OMNI_OS v${OmniOS.version}, 세션 가동 ${up}분`);
    const nav = document.querySelector(".nav-item.active .nav-label");
    if (nav) L.push(`사용자가 보고 있는 패널: ${nav.textContent}`);
    if (!OmniNative.available) return L.join("\n");
    const req = (cmd, arg, t) => OmniNative.request(cmd, arg, t).catch(() => null);
    const [sys, sp1] = await Promise.all([
      req("sys.stats", null, 3000),
      req("sp1.status", null, 3000),
    ]);
    if (sys) {
      const m = sys.mem || {};
      const used = m.total
        ? Math.round(((m.wired || 0) + (m.compressed || 0) + (m.active || 0)
            + (m.inactive || 0)) / m.total * 100) : null;
      const TH = ["정상", "주의", "심각", "위험"];
      let s = `시스템: CPU ${Math.round((sys.cpu || 0) * 100)}%`;
      if (typeof sys.gpu === "number") s += `, GPU ${Math.round(sys.gpu)}%`;
      if (used != null) s += `, 메모리 ${used}%`;
      s += `, 발열 ${TH[sys.thermal] || "?"}`;
      const b = sys.battery;
      if (b && b.percent >= 0) {
        s += `, 배터리 ${b.percent}% ${b.charging ? "충전 중" : "방전 중"}`;
      }
      L.push(s);
    }
    if (sp1) {
      const w = sp1.watcher || {};
      L.push(`보안 SP-1: 상태 ${(sp1.state || "불명").toUpperCase()}, `
        + `워처 ${w.running ? "가동 중" : "정지"}, 침입 기록 ${sp1.intrusions != null ? sp1.intrusions : 0}건`);
    }
    let items = (OmniOS.modules.proj && OmniOS.modules.proj._items) || [];
    if (!items.length) {
      const r = await req("store.read", JSON.stringify({ name: "projects" }), 2000);
      try { items = r && r.data ? JSON.parse(r.data) : []; } catch (e) { items = []; }
    }
    if (items.length) {
      const line = items.slice(0, 10)
        .map((p) => `${p.name}(${p.status || "?"}${p.priority ? "/" + p.priority : ""})`)
        .join(", ");
      L.push(`프로젝트 ${items.length}개: ${line}`);
    }
    try {
      const arc = OmniOS.modules.arc;
      if (arc && typeof arc._count === "number" && arc._count > 0) {
        L.push(`ARC-SCAN: 현재 워크스페이스에 포인트 ${arc._count}개`);
      }
    } catch (e) { /* arc 미초기화 */ }
    L.push(`음성 엔진: ${this.neural ? "신경망(보이스팩 음색)" : "DSP 폴백"}, `
      + `API 키 ${this.hasKey ? "설정됨" : "없음"}`);
    return L.join("\n");
  },

  async saveKey() {
    const key = this.els.keyfield.value.trim();
    if (!key) return;
    try {
      const r = await OmniNative.request("ai.saveKey", JSON.stringify({ key }), 8000);
      if (r && r.ok) {
        this.els.keyfield.value = "";
        this.els.keyinput.classList.remove("open");
        this.logLine("sys", "Claude API 키가 저장되었습니다.");
        this.refreshStatus();
      } else {
        this.logLine("sys", `키 저장 실패: ${(r && r.error) || "unknown"}`);
      }
    } catch (e) {
      this.logLine("sys", "키 저장 실패: 브리지 오류");
    }
  },

  async saveKey2() {
    const key = this.els.keyfield2.value.trim();
    if (!key) return;
    try {
      const r = await OmniNative.request("ai.saveKey",
        JSON.stringify({ key, provider: "openai" }), 8000);
      if (r && r.ok) {
        this.els.keyfield2.value = "";
        this.els.keyinput2.classList.remove("open");
        this.logLine("sys", "OpenAI 키가 저장되었습니다 — GPT 보이스 활성.");
        this.refreshStatus();
      } else {
        this.logLine("sys", `키 저장 실패: ${(r && r.error) || "unknown"}`);
      }
    } catch (e) {
      this.logLine("sys", "키 저장 실패: 브리지 오류");
    }
  },

  // ---- 대화 로그 ----
  logLine(who, text, pending) {
    const hint = this.els.log.querySelector(".ai-hint");
    if (hint) hint.remove();
    const line = document.createElement("div");
    line.className = `ai-line ${who}${pending ? " pending" : ""}`;
    const w = document.createElement("span");
    w.className = "who";
    w.textContent = who === "you" ? "YOU" : who === "omni" ? "OMNI" : "SYS";
    const t = document.createElement("span");
    t.className = "txt";
    t.textContent = text;
    line.append(w, t);
    this.els.log.appendChild(line);
    this.els.log.scrollTop = this.els.log.scrollHeight;
    return line;
  },

  // 언어 규칙 지시문 — AUTO(기본 한국어 + 요구 시 전환) / 특정 언어 잠금
  langDirective() {
    if (this.lang === "auto") {
      return "AUTO — 기본 언어는 한국어입니다. 사용자가 다른 언어로 말하거나 다른 언어로 답해 달라고 하면 그 언어로 즉시 전환해 답합니다.";
    }
    const name = this.LANG_NAMES[this.lang] || "한국어";
    return `LOCK(${name}) — 반드시 ${name}로만 답합니다. 사용자가 다른 언어를 요구하면: (1) 현재 언어로 "다른 언어를 쓰려면 AUTO 모드가 필요합니다. AUTO 모드를 켭니다."라고 짧게 안내하고, (2) lang.auto 액션을 실행해 스스로 AUTO로 전환한 뒤(텍스트 모드: [[ACT:lang.auto]] 태그, 라이브: app_action spec "lang.auto"), (3) 요청받은 언어로 답합니다.`;
  },

  // AUTO 라우팅: 조사·분석·사고가 필요한 질문만 Opus, 일상 대화는 Haiku.
  // 라우팅 비용 없는 휴리스틱 — 심층 키워드 또는 긴 요청이면 심층으로 판단
  isDeep(text) {
    if (text.length > 90) return true;
    return /분석|조사|비교|검토|리뷰|설계|계획|전략|정리해|요약해|알아봐|찾아봐|원인|왜 |어떻게 하면|개선|추천|아키텍처|디버깅|최적화|수정해|고쳐|바꿔|만들어|작성해|구현/
      .test(text);
  },

  // Claude 에이전트 실행 — 스냅샷 주입 + 프롬프트 캐싱 + 파일 도구 루프.
  // 턴 대화(send)와 라이브 세션의 ask_brain 이 공유한다.
  async runClaude(messages) {
    const snapshot = await this.gatherContext();
    const system = [
      {
        type: "text",
        text: `${this.PERSONA}\n\n[패널 안내]\n${this.PANEL_GUIDE}`,
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: `[실시간 상태 스냅샷 — 방금 수집된 실측값]\n${snapshot}`
          + `\n\n${OmniMem.context(typeof messages[messages.length - 1]?.content === "string" ? messages[messages.length - 1].content : "")}`
          + `\n\n[인터페이스 언어]\n${this.langDirective()}`,
      },
    ];
    const tools = this.FS_TOOLS.map((t, i, arr) =>
      i === arr.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t);
    // AUTO 모드: 심층 질문만 Opus로 격상, 나머지는 Haiku (속도·비용 최적)
    const last = messages[messages.length - 1];
    const lastText = typeof (last && last.content) === "string" ? last.content : "";
    let chosenModel = this.model;
    if (this.model === "auto") {
      const deep = this.isDeep(lastText);
      chosenModel = deep ? "claude-opus-5" : "claude-haiku-4-5-20251001";
      if (deep) this.logLine("sys", "라우팅: OPUS (심층 질문)");
    }
    // 에이전트 루프: 파일 도구 호출(stop=tool_use)이 나오면 실행 결과를
    // 돌려주며 반복 — 옴니가 스스로 파일을 나열/읽기/수정한 뒤 답한다
    const convo = messages.map((m) => ({ role: m.role, content: m.content }));
    let r = null;
    for (let round = 0; round < 8; round++) {
      r = await OmniNative.request("ai.chat", JSON.stringify({
        model: chosenModel,
        system,
        messages: convo,
        tools,
        maxTokens: 4000,
      }), 120000).catch(() => null);
      if (!r || !r.ok || r.stop !== "tool_use") break;
      convo.push({ role: "assistant", content: r.content });
      this.setInd(this.els.indLlm, "TOOLS", "busy");
      const results = [];
      for (const block of r.content) {
        if (block.type !== "tool_use") continue;
        this.logLine("sys", `도구 · ${block.name} ${(block.input && block.input.path) || ""}`);
        const out = await this.execTool(block.name, block.input || {});
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(out).slice(0, 40000),
        });
      }
      convo.push({ role: "user", content: results });
    }
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || "요청 시간 초과" };
    if (r.stop === "tool_use") {
      this.logLine("sys", "도구 호출 한도(8회) 도달 — 중간 결과로 답변");
    }
    return { ok: true, text: (r.text || "").trim() };
  },

  // ---- 파일 도구 실행기 (에이전트 루프에서 호출) ----
  async execTool(name, input) {
    try {
      if (name === "list_dir") {
        const r = await OmniNative.request("ai.fsList", JSON.stringify({
          path: input.path, recursive: !!input.recursive,
        }), 30000);
        if (!r || !r.ok) return `오류: ${(r && r.error) || "fsList 실패"}`;
        if (!r.entries.length) return "(비어 있음)";
        const lines = r.entries.map((e) =>
          `${e.dir ? "[D]" : "[F]"} ${e.path}${e.dir ? "" : ` (${e.size}B)`}`);
        return (r.truncated ? "(항목 800개 초과 — 일부만 표시)\n" : "") + lines.join("\n");
      }
      if (name === "read_file") {
        const r = await OmniNative.request("ai.fsRead", JSON.stringify({
          path: input.path, offset: input.offset || 0, limit: input.limit || 400,
        }), 30000);
        if (!r || !r.ok) return `오류: ${(r && r.error) || "fsRead 실패"}`;
        return `(총 ${r.totalLines}줄, ${r.offset}줄부터)\n${r.text}`;
      }
      if (name === "edit_file") {
        const r = await OmniNative.request("ai.fsEdit", JSON.stringify({
          path: input.path, old: input.old, new: input.new,
        }), 30000);
        return r && r.ok ? "수정 완료" : `오류: ${(r && r.error) || "fsEdit 실패"}`;
      }
      if (name === "write_file") {
        const r = await OmniNative.request("ai.fsWrite", JSON.stringify({
          path: input.path, content: input.content,
        }), 30000);
        return r && r.ok ? "저장 완료" : `오류: ${(r && r.error) || "fsWrite 실패"}`;
      }
      if (name === "save_memory") {
        await this.saveMemory(String(input.content || ""));
        return "프로필 기억 저장 완료";
      }
      if (name === "app_ui") return await this.appUI(input);
      if (name === "use_computer") return await this.computerUse(String(input.task || ""));
      if (name === "run_shell") {
        const cmd = String(input.cmd || "").trim();
        if (!cmd) return "오류: 명령 없음";
        if (/\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~\/?|\$HOME)\s*$|mkfs|diskutil\s+(erase|reformat)|dd\s+if=.*of=\/dev|:\(\)\s*\{\s*:\|:&\s*\};:/.test(cmd)) {
          return "오류: 시스템 전체를 지우거나 포맷하는 명령은 실행하지 않습니다";
        }
        this.logLine("sys", `셸 · ${cmd.slice(0, 120)}`).classList.add("ignored");
        const r = await OmniNative.request("ai.shell", JSON.stringify({ cmd, cwd: input.cwd || "" }), 70000);
        OmniMem.append("action", `셸 실행: ${cmd.slice(0, 200)} → 코드 ${r && r.code}`);
        if (!r || !r.ok) return `오류: ${(r && r.error) || "실행 실패"}`;
        return `[exit ${r.code}]\n${(r.output || "").trim() || "(출력 없음)"}`;
      }
      if (name === "open_web_search") {
        const r = await this.runAction(`web.search:${input.engine || "google"}:${input.query || ""}`);
        return r.msg;
      }
      if (name === "recall_memory") {
        const days = Math.max(1, Math.min(60, input.days || 7));
        let pool = OmniMem.recent;
        if (days > 7) {
          const r = await OmniMem.req("mem.read", { days, limit: 3000 });
          pool = ((r && r.items) || []).filter((e) => e.kind !== "ambient");
        }
        const saved = OmniMem.recent; OmniMem.recent = pool;
        const hits = OmniMem.search(String(input.query || ""), 12);
        OmniMem.recent = saved;
        if (!hits.length) return "(관련 기억 없음)";
        return hits.map((e) => OmniMem.fmtEntry(e)).join("\n");
      }
      if (name === "check_weather") {
        const wx = OmniOS.modules.weather;
        if (!wx) return "오류: 날씨 모듈 없음";
        if (input.city) {
          const ok = await wx.setCity(String(input.city));
          if (!ok) return `오류: 도시를 찾지 못했습니다: ${input.city}`;
        } else if (!wx.data) {
          await wx.refresh();
        }
        return wx.summary() || "오류: 날씨 데이터를 받지 못했습니다";
      }
      if (name === "check_news") {
        const nw = OmniOS.modules.news;
        if (!nw) return "오류: 뉴스 모듈 없음";
        const items = input.query
          ? await nw.search(String(input.query))
          : await nw.load(String(input.category || "top"));
        if (!items || !items.length) return "(헤드라인 없음)";
        return items.slice(0, Math.max(1, Math.min(20, input.count || 8)))
          .map((i) => `[${nw.fmtTime(i.ts)}] ${i.source} — ${i.title}`).join("\n");
      }
      if (name === "calculate") {
        const r = await OmniNative.request("ai.calc",
          JSON.stringify({ expr: String(input.expression || "") }), 8000);
        if (!r || !r.ok) return `오류: ${(r && r.error) || "계산 실패"}`;
        return `${r.expr} = ${r.text}`;
      }
      if (name === "check_markets") {
        const mk = OmniOS.modules.markets;
        if (!mk) return "오류: 마켓 모듈 없음";
        if (input.symbol) {
          const q = await mk.quote(String(input.symbol).trim());
          return q ? mk.fmtQuote(q) : `오류: 심볼을 찾지 못했습니다: ${input.symbol}`;
        }
        if (!mk._at) await mk.refresh();
        return mk.summary() || "오류: 시세 데이터를 받지 못했습니다";
      }
      if (name === "check_calendar") {
        const cl = OmniOS.modules.calendar;
        if (!cl) return "오류: 캘린더 모듈 없음";
        const r = await cl.refresh(Math.max(1, Math.min(60, input.days || 7)));
        if (r && r.error === "CAL_DENIED") {
          return "오류: 캘린더 접근 권한이 없습니다. 사용자에게 안내하라: 시스템 설정 > 개인정보 보호 및 보안 > 캘린더에서 Omni OS를 허용해 주십시오.";
        }
        return cl.summary(input.days || 7) || "(예정된 일정 없음)";
      }
      if (name === "add_event") {
        const cl = OmniOS.modules.calendar;
        if (!cl) return "오류: 캘린더 모듈 없음";
        const r = await cl.add(input);
        return r.ok ? `일정 추가됨: ${r.msg}` : `오류: ${r.msg}`;
      }
      if (name === "smart_control") {
        const sc = OmniOS.modules.smart;
        if (!sc) return "오류: 스마트 제어 모듈 없음";
        const r = await sc.control(input || {});
        return r.ok ? r.msg : `오류: ${r.msg}`;
      }
      if (name === "check_gmail") {
        const r = await OmniNative.request("ai.gmailRecent",
          JSON.stringify({ hours: input.hours || 48 }), 30000);
        if (!r || !r.ok) {
          const e = r && r.error;
          return e === "NEED_SETUP"
            ? "오류: Gmail이 아직 연결되지 않았습니다. 사용자에게 안내하라: NOTIFICATIONS 패널의 GMAIL 섹션에서 이메일과 Google 앱 비밀번호를 저장해 주십시오."
            : e === "AUTH_FAILED"
              ? "오류: Gmail 인증 실패 — 앱 비밀번호를 다시 저장해야 합니다."
              : `오류: ${e || "Gmail 조회 실패"}`;
        }
        const notifMod = OmniOS.modules.notif;
        if (notifMod) notifMod.showFromAI();
        if (!r.items || !r.items.length) return "(해당 기간 메일 없음)";
        return r.items.map((m) => {
          const d = new Date(m.ts * 1000);
          const t = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
          return `[${t}]${m.unread ? " [UNREAD]" : ""} ${m.from}: ${m.subject}`;
        }).join("\n");
      }
      if (name === "check_notifications") {
        const r = await OmniNative.request("ai.notifRecent", JSON.stringify({
          bundle: input.app || "", hours: input.hours || 24,
        }), 20000);
        if (!r || !r.ok) {
          return (r && r.error) === "FDA_REQUIRED"
            ? "오류: 알림을 읽으려면 전체 디스크 접근 권한이 필요합니다. 사용자에게 이렇게 안내하라: 시스템 설정 > 개인정보 보호 및 보안 > 전체 디스크 접근 권한에서 Omni OS를 켜고 앱을 재시작해 주십시오."
            : `오류: ${(r && r.error) || "알림 조회 실패"}`;
        }
        // 알림 확인 요청 → NOTIFICATIONS 패널로 자동 전환 (최신 항목 하이라이트)
        const notif = OmniOS.modules.notif;
        if (notif) notif.showFromAI();
        if (!r.items || !r.items.length) return "(해당 기간 알림 없음)";
        return r.items.map((i) => {
          const d = new Date(i.ts * 1000);
          const t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
          const app = /kakao/i.test(i.app) ? "카톡" : i.app.split(".").pop();
          return `[${t}] (${app}) ${i.title}${i.subtitle ? ` / ${i.subtitle}` : ""}: ${i.body}`;
        }).join("\n");
      }
      return `알 수 없는 도구: ${name}`;
    } catch (e) {
      return `도구 실행 실패: ${e.message || e}`;
    }
  },

  // ---- 앱 심층 액션 ([[ACT:...]] 태그 실행기) ----
  // 모든 액션은 실행 후 결과를 검증(이중체크)해 {ok, msg}를 반환한다.
  _norm(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9가-힣]/g, "");
  },

  _wait(cond, tries = 10, ms = 200) {
    return new Promise((resolve) => {
      const tick = (n) => {
        if (cond()) return resolve(true);
        if (n <= 0) return resolve(false);
        setTimeout(() => tick(n - 1), ms);
      };
      tick(tries);
    });
  },

  async _findProject(name) {
    const proj = OmniOS.modules.proj;
    if (!proj) return null;
    // 직전 [[OPEN:proj]]가 load()를 막 시작한 상태일 수 있어 대기 후 재확인
    if (proj.load && !(proj._items || []).length) {
      if (!proj._loaded) await proj.load();
      await this._wait(() => (proj._items || []).length > 0);
      if (!(proj._items || []).length) await proj.load();
    }
    const q = this._norm(name);
    const items = proj._items || [];
    return items.find((p) => this._norm(p.name) === q)
      || items.find((p) => this._norm(p.name).includes(q)
        || (q && q.includes(this._norm(p.name))))
      || null;
  },

  // 코드 에디터 루트에서 파일 이름으로 재귀 탐색 (BFS, 무거운 폴더 제외)
  async _ceFind(root, name) {
    const q = this._norm(name);
    const queue = [root];
    let visited = 0;
    while (queue.length && visited < 150) {
      const dir = queue.shift();
      visited++;
      let t;
      try {
        t = await OmniNative.request("ce.tree", JSON.stringify({ path: dir }), 8000);
      } catch (e) { continue; }
      for (const e of (t && t.entries) || []) {
        const full = `${dir}/${e.name}`;
        if (e.dir) {
          if (!/^(node_modules|\.git|venv|dist|__pycache__|\.cache)$/.test(e.name)) {
            queue.push(full);
          }
        } else if (this._norm(e.name) === q
          || this._norm(e.name.replace(/\.[^.]+$/, "")) === q) {
          return full;
        }
      }
    }
    return null;
  },

  // 텍스트에 섞여 나온 [[OPEN:...]] / [[ACT:...]] 태그를 실행 (라이브 폴백)
  async runTagsFromText(text) {
    const opens = [...String(text).matchAll(/\[\[OPEN:([a-z0-9]+)\]\]/gi)]
      .map((m) => m[1].toLowerCase());
    const acts = [...String(text).matchAll(/\[\[ACT:([^\]]+)\]\]/gi)]
      .map((m) => m[1].trim());
    for (const k of [...new Set(opens)]) {
      const btn = document.querySelector(`.nav-item[data-panel="${k}"]`);
      if (btn && this.PANEL_LABELS[k]) {
        btn.click();
        this.logLine("sys", `패널 전환: ${this.PANEL_LABELS[k]}`);
      }
    }
    for (const a of acts) {
      const res = await this.runAction(a);
      this.logLine("sys", `${res.ok ? "OK" : "실패"} · ${res.msg}`);
    }
  },

  async runAction(spec) {
    const parts = spec.split(":").map((s) => s.trim()).filter(Boolean);
    const key = (parts[0] || "").toLowerCase();
    const openPanel = (k) => {
      const btn = document.querySelector(`.nav-item[data-panel="${k}"]`);
      if (btn) btn.click();
    };
    try {
      // ── 오미니아 호출 (로컬 보조 AI 팝업) ──
      if (key === "omnia") {
        const omnia = OmniOS.modules.omnia;
        if (!omnia) return { ok: false, msg: "오미니아 모듈 없음" };
        const sub = (parts[1] || "open").toLowerCase();
        if (sub === "close") {
          omnia.hide();
          return { ok: true, msg: "오미니아 종료" };
        }
        await omnia.show();
        // "옴니야, 오미니아한테 ○○ 물어봐" — 뒤에 질문이 붙으면 그대로 전달
        const q = parts.slice(1).join(":").trim();
        if (q && sub !== "open") omnia.send(q);
        return { ok: true, msg: `오미니아 호출${q && sub !== "open" ? " · 질문 전달" : ""}` };
      }

      // ── 상시 대기 토글 (안경 브리지·태그용) ──
      // ── 웹 검색 바로 열기 / 패널 UI 직접 조작 (안경·태그용) ──
      if (key === "web.search") {
        const engine = (parts[1] || "google").toLowerCase();
        const q = parts.slice(2).join(":").trim();
        const URLS = {
          google: "https://www.google.com/search?q=", naver: "https://search.naver.com/search.naver?query=",
          youtube: "https://www.youtube.com/results?search_query=", coupang: "https://www.coupang.com/np/search?q=",
          amazon: "https://www.amazon.com/s?k=", maps: "https://www.google.com/maps/search/",
        };
        if (!URLS[engine]) return { ok: false, msg: `모르는 검색 엔진: ${engine}` };
        if (!q) return { ok: false, msg: "검색어 없음" };
        OmniNet.openUrl(URLS[engine] + encodeURIComponent(q));
        OmniMem.append("action", `웹 검색 열기: ${engine} "${q}"`);
        return { ok: true, msg: `${engine}에서 "${q}" 검색 결과를 브라우저로 열었습니다` };
      }
      if (key === "ai.say") {
        // 옴니가 지정 문장을 말함 (테스트·안경 브리지용) — LIVE 세션 필요
        const txt = parts.slice(1).join(":").trim();
        if (!this.live) return { ok: false, msg: "LIVE 세션이 없습니다" };
        this._rtResponding = true;
        this.rtSend({ type: "response.create", response: { instructions: `다음 내용을 그대로 자연스럽게 말하세요: "${txt}"` } });
        return { ok: true, msg: `발화 요청: ${txt.slice(0, 60)}` };
      }
      if (key === "screen.observe") {
        const o = await OmniScreen.observe(true);
        return o ? { ok: true, msg: `화면 관찰: ${o.app || ""} · ${o.activity || ""}${(o.questions || []).length ? ` · 질문 후보 ${o.questions.length}` : ""}` }
          : { ok: false, msg: "화면 관찰 실패 (권한 또는 상시 대기 꺼짐)" };
      }
      if (key === "computer") {
        const task = parts.slice(1).join(":").trim();
        if (!task) return { ok: false, msg: "작업 내용 없음" };
        const out = await this.computerUse(task);
        return { ok: !/^실패/.test(out), msg: out };
      }
      if (key === "shell") {
        // 안경·메일박스에서 셸 명령 실행 (run_shell 도구와 같은 경로)
        const cmd = parts.slice(1).join(":").trim();
        if (!cmd) return { ok: false, msg: "명령 없음" };
        const out = await this.execTool("run_shell", { cmd });
        return { ok: !/^오류/.test(out), msg: out.slice(0, 600) };
      }
      if (key === "ui.read" || key === "ui.click" || key === "ui.type" || key === "ui.select") {
        const out = await this.appUI({ op: key.slice(3), panel: parts[1] || "", target: parts[2] || "", value: parts.slice(3).join(":") });
        return { ok: !/^오류/.test(out), msg: out.slice(0, 400) };
      }
      if (key === "ai.enroll") {
        await this.enrollVoice();
        return { ok: true, msg: "목소리 등록 시작" };
      }
      if (key === "ai.always") {
        const want = (parts[1] || "on").toLowerCase() !== "off";
        if (want && !this.alwaysOn) await this.toggleAlways();
        else if (!want && this.alwaysOn) this.stopAlways("요청");
        return { ok: true, msg: `상시 대기: ${this.alwaysOn ? "ON" : "OFF"}` };
      }

      // ── 언어 모드 AUTO 전환 (언어 잠금 상태에서 옴니가 스스로 호출) ──
      if (key === "lang.auto") {
        this.lang = "auto";
        document.querySelectorAll(".ai-lang").forEach((b) =>
          b.classList.toggle("active", b.dataset.lang === "auto"));
        if (this.live) this.rtSessionUpdate();
        return { ok: true, msg: "언어 모드: AUTO" };
      }

      // ── 지도 검색 / 날씨 도시 / 뉴스 검색 ──
      if (key === "map.search") {
        const q = parts.slice(1).join(":").trim();
        if (!q) return { ok: false, msg: "장소 이름 없음" };
        openPanel("map");
        const hit = await OmniOS.modules.map.search(q);
        return hit ? { ok: true, msg: `지도: ${hit}` } : { ok: false, msg: `장소를 찾지 못했습니다: ${q}` };
      }
      if (key === "weather.city") {
        const q = parts.slice(1).join(":").trim();
        openPanel("weather");
        const ok = q ? await OmniOS.modules.weather.setCity(q) : true;
        return ok ? { ok: true, msg: `날씨: ${OmniOS.modules.weather.locName()}` }
          : { ok: false, msg: `도시를 찾지 못했습니다: ${q}` };
      }
      if (key.startsWith("smart.")) {
        // smart.on:이름 / smart.off:이름 / smart.toggle:이름 / smart.timer:이름:분[:on] / smart.status[:이름] / smart.scan (안경·태그용)
        const sc = OmniOS.modules.smart;
        if (!sc) return { ok: false, msg: "스마트 제어 모듈 없음" };
        const act = key.slice(6);
        const input = { action: act === "list" ? "status" : act, device: parts[1] || "" };
        if (act === "timer") { input.minutes = Number(parts[2]) || 30; input.timer_action = parts[3] === "on" ? "on" : "off"; }
        if (act === "brightness") { input.brightness = Number(parts[2]); }
        return await sc.control(input);
      }
      if (key === "cal.add") {
        // cal.add:제목:YYYY-MM-DD HH:mm:분 (안경 브리지·태그용)
        const title = parts[1] || "";
        const startStr = parts.slice(2, -1).join(":").trim() || parts[2] || "";
        const minutes = Number(parts[parts.length - 1]) || 60;
        const r = await OmniOS.modules.calendar.add({ title, start: startStr, minutes });
        return r.ok ? { ok: true, msg: `일정 추가: ${r.msg}` } : { ok: false, msg: r.msg };
      }
      if (key === "news.search") {
        const q = parts.slice(1).join(":").trim();
        openPanel("news");
        const items = q ? await OmniOS.modules.news.search(q)
          : await OmniOS.modules.news.load("top");
        return { ok: true, msg: `뉴스 ${items.length}건${q ? ` · ${q}` : ""}` };
      }

      // ── 프로젝트 에디터 ──
      if (key === "proj.editor") {
        const name = parts[1] || "";
        const tool = (parts[2] || "").toLowerCase();
        const proj = OmniOS.modules.proj;
        const item = await this._findProject(name);
        if (!item) return { ok: false, msg: `프로젝트 없음: ${name}` };
        openPanel("proj");
        proj.openEditor(item);
        if (["r3d", "ino", "ce", "notes"].includes(tool)) {
          await proj.mountPanel(tool);
        }
        // 검증: 에디터가 실제로 열렸고 도구 패널이 이식됐는지
        const edOk = proj.els.editor && !proj.els.editor.hidden;
        const toolOk = !tool
          || document.getElementById(`panel-${tool}`).classList.contains("pj-embedded");
        return edOk && toolOk
          ? { ok: true, msg: `프로젝트 에디터: ${item.name}${tool ? " · " + tool.toUpperCase() : ""}` }
          : { ok: false, msg: `에디터 열기 실패: ${item.name}` };
      }

      // ── 프로젝트 상태 변경 ──
      if (key === "proj.status") {
        const name = parts[1] || "";
        const raw = (parts[2] || "").toLowerCase();
        const MAP = {
          planning: "planning", 계획: "planning",
          active: "active", 활성: "active", 진행: "active",
          paused: "paused", 중지: "paused", 일시정지: "paused", 보류: "paused",
          done: "done", 완료: "done", 끝: "done",
        };
        const status = MAP[raw];
        if (!status) return { ok: false, msg: `알 수 없는 상태: ${raw}` };
        const proj = OmniOS.modules.proj;
        const item = await this._findProject(name);
        if (!item) return { ok: false, msg: `프로젝트 없음: ${name}` };
        item.status = status;
        await proj.persist();
        proj.render();
        return { ok: true, msg: `프로젝트 상태: ${item.name} → ${status.toUpperCase()}` };
      }

      // ── 노트 열기 (없으면 생성) ──
      if (key === "notes.open") {
        const name = parts.slice(1).join(":").replace(/\.md$/i, "").trim();
        if (!name) return { ok: false, msg: "노트 이름 없음" };
        const notes = OmniOS.modules.notes;
        openPanel("notes");
        if (!notes._vault) await notes.openMain();
        await this._wait(() => (notes._index || []).length > 0);
        if (!notes._vault) return { ok: false, msg: "노트 볼트를 열지 못했습니다" };
        const q = this._norm(name);
        const hit = (notes._index || []).find((n) => this._norm(n.name) === q)
          || (notes._index || []).find((n) => this._norm(n.name).includes(q));
        const created = !hit;
        if (hit) notes.openNote(hit.path);
        else await notes.openByName(name); // 없는 노트는 즉석 생성
        const ok = await this._wait(() => !!notes._cur, 5);
        return ok
          ? { ok: true, msg: created ? `노트 없음 → 새로 생성: ${name}` : `노트 열림: ${hit.name}` }
          : { ok: false, msg: `노트 열기 실패: ${name}` };
      }

      // ── 코드 에디터에서 파일 열기 ──
      if (key === "ce.open") {
        const name = parts.slice(1).join(":").trim();
        if (!name) return { ok: false, msg: "파일 이름 없음" };
        const ce = OmniOS.modules.ce;
        openPanel("ce");
        if (ce.boot) ce.boot();
        const hasRoot = await this._wait(() => !!ce._root);
        if (!hasRoot) {
          return { ok: false, msg: "코드 에디터에 열린 폴더가 없습니다 (OPEN FOLDER 필요)" };
        }
        const found = await this._ceFind(ce._root, name);
        if (!found) return { ok: false, msg: `파일을 찾지 못했습니다: ${name}` };
        await ce.openFile(found);
        return { ok: true, msg: `파일 열림: ${found.split("/").pop()}` };
      }

      // ── ARC-SCAN 연결/해제 ──
      if (key === "arc.connect" || key === "arc.disconnect") {
        const arc = OmniOS.modules.arc;
        openPanel("arc");
        if (key === "arc.disconnect") {
          if (!arc._enabled) return { ok: true, msg: "이미 연결 해제 상태" };
          arc.disconnect("DISCONNECTED");
          return { ok: true, msg: "스캐너 연결 해제" };
        }
        if (arc._enabled && arc._linked) return { ok: true, msg: "이미 연결됨" };
        if (parts[1]) arc.els.ip.value = parts.slice(1).join(":");
        if (!arc.els.ip.value.trim()) {
          return { ok: false, msg: "저장된 스캐너 주소가 없습니다 (FIND DEVICES 필요)" };
        }
        if (!arc._enabled) await arc.toggle();
        const linked = await this._wait(() => arc._linked, 25, 200); // 최대 5초
        return linked
          ? { ok: true, msg: `스캐너 연결됨: ${arc.els.ip.value.trim()}` }
          : { ok: false, msg: `스캐너 응답 없음: ${arc.els.ip.value.trim()}` };
      }

      // ── ARC-SCAN 스캔 제어 ──
      if (key === "arc.scan") {
        const sub = (parts[1] || "").toLowerCase();
        if (!["start", "stop", "center"].includes(sub)) {
          return { ok: false, msg: `알 수 없는 스캔 명령: ${sub}` };
        }
        const arc = OmniOS.modules.arc;
        openPanel("arc");
        if (!arc._enabled || !arc._linked) {
          return { ok: false, msg: "스캐너가 연결되어 있지 않습니다 (arc.connect 먼저)" };
        }
        arc.sendCmd(sub);
        return { ok: true, msg: `스캔 명령 전송: ${sub.toUpperCase()}` };
      }

      // ── SP-1 워처 제어 ──
      if (key === "sp1.watch") {
        const sub = (parts[1] || "").toLowerCase();
        if (sub !== "pause" && sub !== "resume") {
          return { ok: false, msg: `알 수 없는 워처 명령: ${sub}` };
        }
        await OmniNative.request(sub === "pause" ? "sp1.pause" : "sp1.resume", null, 15000);
        // 검증: 상태 재조회로 실제 반영 확인
        await new Promise((r) => setTimeout(r, 800));
        const st = await OmniNative.request("sp1.status", null, 5000).catch(() => null);
        const running = !!(st && st.watcher && st.watcher.running && !st.watcher.stopped);
        const want = sub === "resume";
        return running === want
          ? { ok: true, msg: `보안 워처 ${want ? "재개" : "일시정지"} 확인` }
          : { ok: false, msg: `워처 상태 불일치 (현재 ${running ? "가동" : "정지"})` };
      }

      return { ok: false, msg: `알 수 없는 액션: ${spec}` };
    } catch (e) {
      return { ok: false, msg: `액션 오류(${key}): ${e.message || e}` };
    }
  },

  // ---- 텍스트 입력 ----
  sendFromInput() {
    const text = this.els.text.value.trim();
    if (!text) return;
    if (this.live) {
      // 라이브 세션 중 텍스트 입력 → 그대로 대화에 주입
      this.els.text.value = "";
      this.logLine("you", text);
      this.rtSend({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      });
      this.rtSend({ type: "response.create" });
      return;
    }
    if (this.state === "thinking") return;
    this.els.text.value = "";
    this.send(text);
  },

  // ---- LLM 대화 ----
  async send(text) {
    this.logLine("you", text);
    this.history.push({ role: "user", content: text }); OmniMem.conv("user", text);
    while (this.history.length > 16) this.history.shift();
    if (this.history[0] && this.history[0].role !== "user") this.history.shift();
    this.setState("thinking", "THINKING", "busy");
    this.setInd(this.els.indLlm, "QUERY", "busy");
    if (!OmniNative.available) {
      // 브라우저 테스트 모드: 즉석 응답
      const reply = "네, 알겠습니다. 현재는 브라우저 테스트 모드로 동작 중입니다.";
      this.history.push({ role: "assistant", content: reply }); OmniMem.conv("assistant", reply);
      this.logLine("omni", reply);
      this.setInd(this.els.indLlm, "STUB", "busy");
      this.setState("idle", "STANDBY", "");
      return;
    }
    try {
      const res = await this.runClaude(this.history);
      if (!res.ok) {
        const err = res.error || "unknown";
        this.history.pop(); // 실패한 user 턴 되돌림
        if (err === "NO_KEY") {
          this.logLine("sys", "API 키가 없습니다. 우측 API KEY > SET에 Anthropic API 키를 저장하십시오.");
        } else {
          this.logLine("sys", `응답 실패: ${err}`);
        }
        this.setState("idle", "STANDBY", "");
        this.refreshStatus();
        return;
      }
      const r = { text: res.text };
      // [[OPEN:키]] / [[ACT:...]] 태그 추출 → 실행, 낭독/로그에서는 제거
      const opens = [];
      const acts = [];
      let reply = (r.text || "")
        .replace(/\[\[OPEN:([a-z0-9]+)\]\]/gi, (m, k) => {
          opens.push(k.toLowerCase());
          return " ";
        })
        .replace(/\[\[ACT:([^\]]+)\]\]/gi, (m, s) => {
          acts.push(s.trim());
          return " ";
        })
        .replace(/\s{2,}/g, " ").trim();
      if (!reply) reply = "완료했습니다.";
      this.history.push({ role: "assistant", content: reply }); OmniMem.conv("assistant", reply);
      this.logLine("omni", reply);
      this.setInd(this.els.indLlm, "READY", "ok");
      for (const k of [...new Set(opens)]) {
        const btn = document.querySelector(`.nav-item[data-panel="${k}"]`);
        if (btn && this.PANEL_LABELS[k]) {
          btn.click();
          this.logLine("sys", `패널 전환: ${this.PANEL_LABELS[k]}`);
        }
      }
      // 액션 실행 + 이중체크 — 텍스트 모드는 결과를 로그로만 보고 (음성은 LIVE 전용)
      for (const a of acts) {
        const res = await this.runAction(a);
        this.logLine("sys", `${res.ok ? "OK" : "실패"} · ${res.msg}`);
      }
      this.setState("idle", "STANDBY", "");
      this.bumpMemoTurn(); // 주기적 장기 메모리 자동 통합
    } catch (e) {
      this.history.pop();
      this.logLine("sys", "응답 실패: 요청 시간 초과");
      this.setState("idle", "STANDBY", "");
    }
  },

  // ---- 로봇 TTS ----
  ensureCtx() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  },

  // 응답 텍스트의 실제 언어 감지 — LANG 토글과 응답 언어가 어긋나도
  // (예: 한국어 모드에서 "영어로 말해봐") 항상 맞는 보이스로 낭독한다.
  // 한국어 보이스가 외국어 텍스트를 읽으며 생기던 콩글리시·숫자 한글 낭독 차단
  detectLang(text) {
    const n = (re) => (text.match(re) || []).length;
    const hangul = n(/[가-힣]/g);
    const kana = n(/[ぁ-んァ-ヶー]/g);
    const han = n(/[一-鿿]/g);
    const cyr = n(/[а-яё]/gi);
    const latin = n(/[a-z]/gi);
    const max = Math.max(hangul, kana, han, cyr, latin);
    if (max === 0) return this.lang;
    if (kana >= 2 && hangul === 0) return "ja"; // 가나 = 일본어 확정 신호
    if (hangul === max) return "ko";
    if (kana === max || (kana > 0 && han === max)) return "ja"; // 한자+가나 = 일본어
    if (han === max) return "zh";
    if (cyr === max) return "ru";
    // 라틴: 스페인어 특수문자 있으면 es, 아니면 토글이 es일 때만 es
    if (/[ñáéíóú¿¡]/i.test(text)) return "es";
    return this.lang === "es" ? "es" : "en";
  },

  // 낭독 텍스트를 문장 덩어리로 분할 — 덩어리별로 병렬 합성해
  // 첫 문장이 도착하는 즉시 재생을 시작한다 (체감 지연 대폭 단축)
  splitSentences(t) {
    const raw = t.split(/(?<=[.!?。！？])\s+/).map((s) => s.trim()).filter(Boolean);
    const out = [];
    let cur = "";
    for (const s of raw) {
      cur = cur ? `${cur} ${s}` : s;
      // 첫 덩어리는 짧아도 바로 분리 — 첫 소리가 최대한 빨리 나오게
      if (out.length === 0 || cur.length >= 30) { out.push(cur); cur = ""; }
    }
    if (cur) out.push(cur);
    return out.slice(0, 6);
  },

  async speak(text) {
    if (!OmniNative.available) { this.setState("idle", "STANDBY", ""); return; }
    this.setState("speaking", "SPEAKING", "on");
    this.setInd(this.els.indTts, "SYNTH", "busy");
    // 낭독용 정리: 마크다운 기호 제거
    const clean = text.replace(/[*#`_~<>|]+/g, " ").replace(/\s{2,}/g, " ").trim();
    const effLang = this.detectLang(clean);
    const gen = (this._speakGen = (this._speakGen || 0) + 1);
    const parts = this.splitSentences(clean);
    // 전 문장 동시 발주 — 재생은 순서대로
    const jobs = parts.map((p) => OmniNative.request("ai.speak", JSON.stringify({
      text: p.slice(0, 800), lang: effLang,
    }), 60000).catch(() => null));
    let played = false;
    try {
      for (let i = 0; i < jobs.length; i++) {
        const r = await jobs[i];
        if (gen !== this._speakGen) return; // 중단됨
        if (!r || !r.ok || !r.wav) {
          if (!played) this.logLine("sys", `발화 실패: ${(r && r.error) || "응답 없음"}`);
          continue;
        }
        const { x, sr } = this.parseWav(r.wav);
        played = true;
        await this.playChunk(x, sr);
        if (gen !== this._speakGen) return;
      }
    } catch (e) {
      this.logLine("sys", `발화 실패: ${e.message || e}`);
    }
    if (gen !== this._speakGen) return;
    this.setInd(this.els.indTts, played ? (this.hasOpenAI ? "GPT" : "CLEAN") : "FAIL",
      played ? "ok" : "err");
    if (this.state === "speaking") this.setState("idle", "STANDBY", "");
  },

  parseWav(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dv = new DataView(bytes.buffer);
    let off = 12, sr = 22050, ch = 1, bits = 16, fmt = 1, data = null;
    while (off + 8 <= bytes.length) {
      const id = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
      let sz = dv.getUint32(off + 4, true);
      // 스트리밍 생성 WAV(GPT TTS 등)는 크기 필드가 0xFFFFFFFF 자리표시자 —
      // 실제 남은 바이트로 클램프해야 파싱이 터지지 않는다
      const remaining = bytes.length - (off + 8);
      if (sz > remaining) sz = remaining;
      if (id === "fmt ") {
        fmt = dv.getUint16(off + 8, true);
        ch = dv.getUint16(off + 10, true);
        sr = dv.getUint32(off + 12, true);
        bits = dv.getUint16(off + 22, true);
      } else if (id === "data") {
        data = { start: off + 8, size: sz };
      }
      off += 8 + sz + (sz & 1);
    }
    if (!data) throw new Error("bad wav");
    // PCM16(fmt 1) 또는 float32(fmt 3 — 신경망 변환 출력)
    if (fmt === 3 && bits === 32) {
      const n = Math.floor(data.size / 4 / ch);
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = dv.getFloat32(data.start + i * 4 * ch, true);
      return { x, sr };
    }
    if (bits !== 16) throw new Error("bad wav");
    const n = Math.floor(data.size / 2 / ch);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = dv.getInt16(data.start + i * 2 * ch, true) / 32768;
    }
    return { x, sr };
  },

  // 오디오 덩어리 하나 재생 — 끝나면 resolve (문장 파이프라인용)
  playChunk(samples, sr) {
    return new Promise((resolve) => {
      this.ensureCtx();
      const buf = this.ctx.createBuffer(1, samples.length, sr);
      buf.copyToChannel(samples, 0);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      if (!this._analyser) {
        this._analyser = this.ctx.createAnalyser();
        this._analyser.fftSize = 512;
        this._analyser.connect(this.ctx.destination);
      }
      src.connect(this._analyser);
      src.onended = () => {
        if (this._speakSrc === src) this._speakSrc = null;
        resolve();
      };
      this._speakSrc = src;
      src.start();
    });
  },

  stopSpeak() {
    this._speakGen = (this._speakGen || 0) + 1; // 대기 중인 재생 큐 무효화
    if (this._speakSrc) {
      try { this._speakSrc.stop(); } catch (e) { /* already stopped */ }
      this._speakSrc = null;
    }
    this.setInd(this.els.indTts, "READY", "ok");
    if (this.state === "speaking") this.setState("idle", "STANDBY", "");
  },

  // ---- LIVE 모드: gpt-realtime 2.1 음성 세션 (ECHO 구조 이식) ----
  RT_MODEL: "gpt-realtime-2.1", // 2.1: 도구 호출·사실성 향상, marin 보이스 동일
  // 마이크 PCM16 24kHz → 네이티브 WSS 릴레이 → 서버 VAD가 턴 감지 →
  // marin 보이스 오디오 스트리밍 재생. 도구: ask_brain(Claude 에이전트),
  // get_status(스냅샷 즉답), open_panel, app_action(심층 액션)
  live: false,
  RT_TOOLS: [
    {
      type: "function",
      name: "ask_brain",
      description: "Delegate to Claude for deep reasoning: web-grade analysis, code, file reading/editing/counting, complex multi-step questions, or anything about the user's files anywhere on the Mac. Claude has file tools (whole Mac) and a shell. Do NOT use for chitchat, time, or app status (use get_status). Pass the user's request as 'query'. The returned text is what you should say back, naturally.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    {
      type: "function",
      name: "get_status",
      description: "Instant snapshot of OMNI_OS: current time/date, CPU/GPU/memory/battery/thermal, security state, project list, active panel. Use for ANY time/date/system/project status question. Never use ask_brain for these.",
      parameters: { type: "object", properties: {} },
    },
    {
      type: "function",
      name: "open_panel",
      description: "Switch the app to a panel. key: cmd(home)/ai/notif(notifications)/clock/proj/sys/sp1/r3d/ino/ce/notes/voice/arc",
      parameters: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
      },
    },
    {
      type: "function",
      name: "app_action",
      description: "Deep in-app action. spec format (colon-separated): proj.editor:NAME:TOOL(r3d|ino|ce|notes) | proj.status:NAME:STATUS | notes.open:NOTE | ce.open:FILE | arc.connect | arc.disconnect | arc.scan:start|stop|center | sp1.watch:pause|resume | lang.auto (switch language mode to AUTO) | omnia (open the local assistant AI 'Omnia' popup — use when user says 오미니아 호출/켜줘; omnia:QUESTION to forward a question, omnia:close to close)",
      parameters: {
        type: "object",
        properties: { spec: { type: "string" } },
        required: ["spec"],
      },
    },
    {
      type: "function",
      name: "check_gmail",
      description: "Gmail 받은편지함 확인 — \"메일 확인해줘\"에 사용. hours 기본 48. 보낸 사람과 제목, 안읽음 여부를 간결히 요약해 말한다. 연결 안 됐다는 응답이 오면 그 안내를 그대로 전한다.",
      parameters: {
        type: "object",
        properties: { hours: { type: "number" } },
      },
    },
    {
      type: "function",
      name: "check_notifications",
      description: "최근 macOS 알림 확인 — \"카톡/디스코드 온 거 확인해줘\" 등 메시지/알림 질문에 사용. app:'kakao'는 카카오톡, 'discord'는 디스코드, 비우면 전체 앱. hours 기본 24. 결과를 보낸 사람과 내용 중심으로 간결하게 요약해 말한다. 권한 오류 응답이 오면 그 안내를 그대로 전한다.",
      parameters: {
        type: "object",
        properties: {
          app: { type: "string" },
          hours: { type: "number" },
        },
      },
    },
    {
      type: "function",
      name: "check_weather",
      description: "날씨 확인 — \"날씨 어때/비 와?/내일 추워?\"에 사용. city를 주면 그 도시, 비우면 현재 설정 위치. 결과를 현재 상태와 오늘·내일 핵심만 짧게 말한다.",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
      },
    },
    {
      type: "function",
      name: "calculate",
      description: "정확 계산기 — 숫자 계산은 전부 여기로(암산 금지): 산수, 퍼센트, 거듭제곱, 큰 수, 수학 함수, 평균/통계, 단위 환산(수식으로). expression은 파이썬식 수식. 결과 숫자를 그대로 읽어 준다.",
      parameters: {
        type: "object",
        properties: { expression: { type: "string" } },
        required: ["expression"],
      },
    },
    {
      type: "function",
      name: "open_web_search",
      description: "브라우저에서 검색 결과를 바로 연다 — \"구글에 ○○ 검색해줘\", \"쿠팡에서 ○○ 찾아줘\"에 사용. engine: google|naver|youtube|coupang|amazon|maps.",
      parameters: {
        type: "object",
        properties: { engine: { type: "string" }, query: { type: "string" } },
        required: ["engine", "query"],
      },
    },
    {
      type: "function",
      name: "run_shell",
      description: "맥에서 셸 명령 실행 — 파일 찾기·정리·설치·git 등 명령으로 되는 일. 결과를 짧게 요약해 말한다. 되돌릴 수 없는 삭제·포맷은 사용자 명시 요청 시에만.",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" }, cwd: { type: "string" } },
        required: ["cmd"],
      },
    },
    {
      type: "function",
      name: "use_computer",
      description: "맥의 마우스·키보드를 직접 움직여 작업 — 사이트 안에서 클릭·입력, 앱 조작, 화면 읽기 등 검색 열기만으로 안 되는 일. task를 구체적으로. 수 초~수십 초 걸리니 \"제가 직접 해보겠습니다\" 같은 예고 후 호출. 결과 요약을 그대로 전한다.",
      parameters: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
      },
    },
    {
      type: "function",
      name: "app_ui",
      description: "OMNI_OS 패널 화면을 읽고(op read) 버튼 클릭·입력(op click/type/select)으로 세부 조작. 전용 액션이 없는 패널 작업에 사용.",
      parameters: {
        type: "object",
        properties: { op: { type: "string" }, panel: { type: "string" }, target: { type: "string" }, value: { type: "string" } },
        required: ["op", "panel"],
      },
    },
    {
      type: "function",
      name: "recall_memory",
      description: "옴니의 기억(일지·관찰·하루 요약) 검색 — \"어제 뭐 봤지\", \"아까 누가 왔었지\"에 사용. query 키워드, days 기본 7.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, days: { type: "number" } },
        required: ["query"],
      },
    },
    {
      type: "function",
      name: "check_markets",
      description: "환율·주식·코인 시세 — \"달러 환율/삼성전자 주가/비트코인\"에 사용. symbol을 주면 그 종목만. 핵심 수치와 등락만 짧게 말한다.",
      parameters: {
        type: "object",
        properties: { symbol: { type: "string" } },
      },
    },
    {
      type: "function",
      name: "check_calendar",
      description: "맥 캘린더 일정 — \"오늘/내일/이번 주 일정\"에 사용. days 기본 7. 가까운 일정부터 시각과 제목만 짧게 말한다.",
      parameters: {
        type: "object",
        properties: { days: { type: "number" } },
      },
    },
    {
      type: "function",
      name: "add_event",
      description: "맥 캘린더에 일정 추가 — \"내일 3시 치과 잡아줘\"에 사용. title, start('YYYY-MM-DD HH:mm', 종일이면 날짜만), minutes(기본 60). 현재 날짜는 get_status로 확인.",
      parameters: {
        type: "object",
        properties: { title: { type: "string" }, start: { type: "string" }, minutes: { type: "number" } },
        required: ["title", "start"],
      },
    },
    {
      type: "function",
      name: "smart_control",
      description: "집 안 스마트 플러그·전구(Tapo) 제어 — \"불 꺼줘/켜줘\", \"30분 뒤에 꺼줘\", \"조명 밝기 40%\", \"불 켜져 있어?\". action: status/on/off/toggle/timer(minutes 뒤 끄기, timer_action=on이면 켜기)/cancel_timer/brightness(전구만)/scan. device는 기기 이름 일부(하나뿐이면 생략). 결과를 한 문장으로 말한다.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["status", "on", "off", "toggle", "timer", "cancel_timer", "brightness", "scan"] },
          device: { type: "string" }, minutes: { type: "number" }, timer_action: { type: "string" }, brightness: { type: "number" },
        },
        required: ["action"],
      },
    },
    {
      type: "function",
      name: "check_news",
      description: "뉴스 헤드라인 — \"뉴스 뭐 있어/○○ 소식\"에 사용. category: top/world/business/tech/science/sports, query는 키워드 검색. 3~5개를 골라 간결히 말한다.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string" },
          query: { type: "string" },
        },
      },
    },
  ],

  rtSend(obj) {
    OmniNative.request("ai.rtSend", JSON.stringify(obj), 10000).catch(() => {});
  },

  async toggleLive() {
    if (this.live) { this.stopLive("종료"); return; }
    if (!OmniNative.available) {
      this.logLine("sys", "LIVE 모드는 앱에서만 동작합니다.");
      return;
    }
    const r = await OmniNative.request("ai.rtStart",
      JSON.stringify({ model: this.RT_MODEL }), 15000).catch(() => null);
    if (!r || !r.ok) {
      this.logLine("sys", (r && r.error) === "NO_OPENAI_KEY"
        ? "LIVE 모드에는 OpenAI 키가 필요합니다 (OPENAI KEY // VOICE)."
        : "LIVE 세션 시작 실패");
      return;
    }
    this.live = true;
    this.els.liveBtn.classList.add("live");
    this.setState("listening", "LIVE", "on");
    this.setInd(this.els.indStt, "MARIN", "ok");
    this.setInd(this.els.indTts, "LIVE", "ok");
    this.rtSessionUpdate();
    if (this.alwaysOn) {
      this.ensureCtx(); // 재생용 오디오 컨텍스트만 — 마이크는 사이드카가 소유
    } else {
      await this.wireMic();
      this.logLine("sys", "LIVE 세션 시작 — 그냥 말씀하세요. (다시 누르면 종료)");
    }
  },

  ensureCtx() {
    if (this._rtCtx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    try { this._rtCtx = new AC({ sampleRate: 24000 }); } catch (e) { this._rtCtx = new AC(); }
    if (this._rtCtx.state === "suspended") this._rtCtx.resume();
  },

  rtSessionUpdate() {
    const instructions = `${this.PERSONA}\n\n[패널 안내]\n${this.PANEL_GUIDE}\n\n`
      + "[라이브 모드 규칙]\n"
      + "- 지금은 실시간 음성 대화입니다. 답은 짧고 자연스럽게 (1~2문장 기본).\n"
      + "- [[OPEN]]·[[ACT]] 같은 태그는 절대 말하지 않습니다 — 대신 도구를 호출합니다.\n"
      + "- 시각/날짜/시스템/보안/프로젝트 현황 → get_status (즉시). ask_brain 금지.\n"
      + "- 숫자 계산은 전부 calculate (암산 절대 금지 — 작은 산수도). 결과를 받아 읽어준다.\n"
      + "- 도구 결과에 있는 수치·시각만 말한다. 없는 것(종료 시각 등)은 추정 금지 — '기록에 없다'고 답한다. 일정 질문은 매번 check_calendar를 새로 호출한다(기억으로 답하지 않는다).\n"
      + "- 숫자·영어 단어는 말하는 그대로 표기한다 (말과 자막이 일치해야 함).\n"
      + "- 패널 열기 → open_panel. 앱 심층 동작(에디터·노트·파일 열기, 상태 변경, 스캔, 워처) → app_action.\n"
      + "- 조사·분석·코드·파일 내용 확인/수정 → ask_brain (Claude가 파일 도구로 실제 수행, 수 초 소요). 호출 전에 \"확인하겠습니다\" 같은 짧은 예고를 말해도 좋습니다.\n"
      + "- 인사·잡담·간단 지식은 도구 없이 바로 대답합니다.\n"
      + "- 먼저 말 걸기: 화면 관찰 모듈이 지시하면 사용자에게 먼저 짧게 질문합니다(부담 없는 톤). 답을 들으면 짧게 고맙다고 하고 넘어갑니다 — 답은 자동으로 기억에 저장되므로 save_memory는 필요 없습니다. 사용자가 답을 미루거나 바쁘다고 하면 바로 물러납니다.\n"
      + (this.alwaysOn ? "- 상시 대기 모드: 사용자는 \"옴니야\"처럼 이름을 불러 말을 겁니다. 호출어는 되풀이하지 말고 본론에만 답합니다. 들리는 발화는 이미 사용자 본인이 옴니에게 한 말로 확인된 것입니다.\n" : "")
      + `- 언어 규칙: ${this.langDirective()}\n`
      + "- 다국어 발음 규칙 (매우 중요): 어떤 언어를 말하든 반드시 그 언어의 원어민 발음과 억양으로 발화합니다. 한 응답 안에서 여러 언어를 오갈 때는 언어 전환 지점마다 아주 짧게 멈춘 뒤 완전히 새 언어의 원어민 모드로 전환합니다 — 직전 언어(특히 한국어)의 억양·리듬을 절대 다음 언어로 끌고 가지 않습니다. 프랑스어는 프랑스인처럼, 힌디어는 인도인처럼, 각 구간을 독립적으로 발음합니다. 여러 언어 시연을 요청받으면 언어당 한 문장으로 짧게 말합니다.\n\n"
      + OmniMem.context();
    this.rtSend({
      type: "session.update",
      session: {
        type: "realtime",
        model: this.RT_MODEL,
        output_modalities: ["audio"],
        instructions,
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transcription: {
              model: "gpt-4o-transcribe",
              prompt: "옴니, 옴니야, 오미니아, OMNI_OS",
            },
            turn_detection: this.alwaysOn ? null : {
              type: "server_vad",
              threshold: 0.75,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
              create_response: true,
            },
          },
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            voice: "marin",
          },
        },
        tools: this.RT_TOOLS,
        tool_choice: "auto",
      },
    });
  },

  async wireMic() {
    try {
      this._rtStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      const AC = window.AudioContext || window.webkitAudioContext;
      try { this._rtCtx = new AC({ sampleRate: 24000 }); }
      catch (e) { this._rtCtx = new AC(); }
      if (this._rtCtx.state === "suspended") this._rtCtx.resume();
      const src = this._rtCtx.createMediaStreamSource(this._rtStream);
      const proc = this._rtCtx.createScriptProcessor(2048, 1, 1);
      const mute = this._rtCtx.createGain();
      mute.gain.value = 0; // ScriptProcessor 구동용 — 마이크 에코 방지
      src.connect(proc);
      proc.connect(mute);
      mute.connect(this._rtCtx.destination);
      proc.onaudioprocess = (e) => {
        if (!this.live) return;
        let f = e.inputBuffer.getChannelData(0);
        const srIn = this._rtCtx.sampleRate;
        if (srIn !== 24000) { // 폴백 컨텍스트용 리샘플
          const n2 = Math.round(f.length * 24000 / srIn);
          const g = new Float32Array(n2);
          for (let i = 0; i < n2; i++) g[i] = f[Math.floor(i * srIn / 24000)];
          f = g;
        }
        let rms = 0;
        const b = new Uint8Array(f.length * 2);
        const dv = new DataView(b.buffer);
        for (let i = 0; i < f.length; i++) {
          const v = Math.max(-1, Math.min(1, f[i]));
          dv.setInt16(i * 2, v * 32767, true);
          rms += v * v;
        }
        this.micLevel = Math.min(1, Math.sqrt(rms / f.length) * 6);
        let bin = "";
        for (let i = 0; i < b.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
        }
        this.rtSend({ type: "input_audio_buffer.append", audio: btoa(bin) });
      };
      this._rtProc = proc;
      this._rtSrcNode = src;
    } catch (e) {
      this.logLine("sys", `마이크 연결 실패 (${e.message || e}) — 텍스트 입력으로 대화 가능`);
    }
  },

  stopLive(reason) {
    if (this.alwaysOn) this.stopAlways(reason, true);
    this.live = false;
    try {
      if (this._rtProc) this._rtProc.disconnect();
      if (this._rtSrcNode) this._rtSrcNode.disconnect();
    } catch (e) { /* 이미 해제됨 */ }
    if (this._rtStream) {
      this._rtStream.getTracks().forEach((t) => t.stop());
      this._rtStream = null;
    }
    this._rtProc = null;
    this._rtSrcNode = null;
    this.rtStopPlayback();
    OmniNative.request("ai.rtStop", null, 5000).catch(() => {});
    this.els.liveBtn.classList.remove("live");
    this.micLevel = 0;
    this._rtUserLine = null;
    this._rtOmniLine = null;
    this._rtOmniText = "";
    this.setState("idle", "STANDBY", "");
    this.setInd(this.els.indStt, "OFF", "");
    this.setInd(this.els.indTts, "TEXT", "ok");
    this.logLine("sys", `LIVE 세션 ${reason}`);
  },

  rtStopPlayback() {
    for (const s of (this._rtSources || [])) {
      try { s.stop(); } catch (e) { /* 이미 종료 */ }
    }
    this._rtSources = [];
    this._rtPlayTime = 0;
  },

  rtPlayDelta(b64) {
    if (!b64 || !this._rtCtx) return;
    const bin = atob(b64);
    const n = bin.length >> 1;
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      if (v >= 0x8000) v -= 0x10000;
      f[i] = v / 32768;
    }
    const srOut = 24000;
    const buf = this._rtCtx.createBuffer(1, n, srOut);
    buf.copyToChannel(f, 0);
    const src = this._rtCtx.createBufferSource();
    src.buffer = buf;
    src.connect(this._rtCtx.destination);
    const t0 = Math.max(this._rtCtx.currentTime + 0.03, this._rtPlayTime || 0);
    src.start(t0);
    this._rtPlayTime = t0 + n / srOut;
    if (!this._rtSources) this._rtSources = [];
    this._rtSources.push(src);
    src.onended = () => {
      const i = this._rtSources.indexOf(src);
      if (i >= 0) this._rtSources.splice(i, 1);
    };
  },

  // 네이티브 릴레이가 푸시하는 리얼타임 이벤트
  _rt(ev) {
    if (!ev || typeof ev !== "object") return;
    const t = ev.type;
    if (t === "rt.closed") {
      if (this.live) this.stopLive("연결 끊김");
      return;
    }
    if (!this.live) return;
    if (t === "session.created") {
      this.logLine("sys", `LIVE 연결됨 · ${this.RT_MODEL} · marin`);
    } else if (t === "response.created") {
      this._rtResponding = true;
    } else if (t === "input_audio_buffer.speech_started") {
      this.rtStopPlayback(); // 사용자가 말 시작 — 재생 중이면 끊고 듣기
      if (!this._rtUserLine) this._rtUserLine = this.logLine("you", "…", true);
    } else if (t === "conversation.item.input_audio_transcription.completed") {
      const text = (ev.transcript || "").trim();
      if (this.alwaysOn) { this.gateDecide(ev.item_id, text); return; }
      if (this._rtUserLine) {
        if (text) {
          this._rtUserLine.querySelector(".txt").textContent = text;
          this._rtUserLine.classList.remove("pending");
        } else this._rtUserLine.remove();
        this._rtUserLine = null;
      } else if (text) {
        this.logLine("you", text);
      }
      if (text) {
        this.history.push({ role: "user", content: text }); OmniMem.conv("user", text);
        this.trimHistory();
      }
    } else if (t === "response.output_audio.delta" || t === "response.audio.delta") {
      if (this.alwaysOn && !this._gateMuted) this.gateMute(true); // 옴니 발화 중 마이크 무시
      this.rtPlayDelta(ev.delta);
    } else if (t === "response.done") {
      this._rtResponding = false;
      if (this._rtQueuedCreate) { this._rtQueuedCreate = false; this.rtCreateResponse(); }
      if (this.alwaysOn) {
        // 재생이 끝나는 시점에 뮤트 해제 + 대화 이어가기 창 시작
        const ctxNow = this._rtCtx ? this._rtCtx.currentTime : 0;
        const wait = Math.max(0, ((this._rtPlayTime || 0) - ctxNow) * 1000) + 250;
        clearTimeout(this._unmuteTimer);
        this._unmuteTimer = setTimeout(() => {
          this._lastOmniDoneAt = Date.now();
          this.gateMute(false);
          this.gateNote("옴니 발화 종료 → 청취 재개 (이어가기 창 15초)");
        }, wait);
      }
    } else if (t === "response.output_audio_transcript.delta"
      || t === "response.audio_transcript.delta") {
      if (!this._rtOmniLine) {
        this._rtOmniLine = this.logLine("omni", "");
        this._rtOmniText = "";
      }
      this._rtOmniText += ev.delta || "";
      this._rtOmniLine.querySelector(".txt").textContent = this._rtOmniText;
      this.els.log.scrollTop = this.els.log.scrollHeight;
    } else if (t === "response.output_audio_transcript.done"
      || t === "response.audio_transcript.done") {
      // 라이브에서 도구 대신 태그를 말해버리는 경우가 있다 — 태그가 보이면
      // 표시에서 지우고 그대로 실행해준다 (동작이 조용히 누락되지 않게)
      if (/\[\[(OPEN|ACT):/i.test(this._rtOmniText)) {
        this.runTagsFromText(this._rtOmniText);
        this._rtOmniText = this._rtOmniText
          .replace(/\[\[(?:OPEN|ACT):[^\]]+\]\]/gi, " ")
          .replace(/\s{2,}/g, " ").trim();
        if (this._rtOmniLine) {
          this._rtOmniLine.querySelector(".txt").textContent = this._rtOmniText;
        }
      }
      if (this._rtOmniText) {
        this.history.push({ role: "assistant", content: this._rtOmniText }); OmniMem.conv("assistant", this._rtOmniText);
        this.trimHistory();
        this.bumpMemoTurn(); // 라이브 대화도 주기 통합에 포함
      }
      this._rtOmniLine = null;
      this._rtOmniText = "";
    } else if (t === "response.function_call_arguments.done") {
      let args = {};
      try { args = JSON.parse(ev.arguments || "{}"); } catch (e) { /* 무시 */ }
      this.handleRtTool(ev.call_id, ev.name, args);
    } else if (t === "error") {
      const msg = (ev.error && ev.error.message) || "";
      if (/active response/i.test(msg)) { this._rtQueuedCreate = true; return; }
      this.logLine("sys", `LIVE 오류: ${msg}`);
    }
  },

  // ================= 상시 대기(ALWAYS) =================
  async toggleAlways() {
    if (this.alwaysOn) { this.stopAlways("종료"); return; }
    if (!OmniNative.available) {
      this.logLine("sys", "상시 대기는 앱에서만 동작합니다.");
      return;
    }
    const st = await OmniNative.request("ai.gateStatus", null, 5000).catch(() => null);
    if (!st || !st.profile) {
      this.logLine("sys", "내 목소리가 등록되어 있지 않습니다 — 오른쪽 VOICE ID > ENROLL로 먼저 등록하십시오. (등록 없이도 켤 수 있지만 다른 사람 목소리를 구분하지 못합니다)");
    }
    const g = await OmniNative.request("ai.gateStart", null, 15000).catch(() => null);
    if (!g || !g.ok) {
      this.logLine("sys", (g && g.error) === "NO_GATE_ENV"
        ? "음성 게이트 환경이 없습니다 (voice_engine/venv + scripts/omni_gate.py)."
        : `음성 게이트 시작 실패: ${(g && g.error) || "unknown"}`);
      return;
    }
    this.alwaysOn = true;
    this._gateRunning = true;
    this._gateLoopback = !!g.loopback;   // 시스템 오디오 참조 가능 → 옴니 발화 중에도 마이크를 열어 끼어들기 허용
    localStorage.setItem("omni.ai.always", "1");
    this.els.alwaysBtn.classList.add("always");
    if (!this.live) {
      await this.toggleLive();
      if (!this.live) { this.stopAlways("세션 실패", true); return; }
    } else {
      // 이미 LIVE(서버 VAD) 중이었으면 마이크를 사이드카로 넘기고 수동 턴으로 전환
      try { if (this._rtProc) this._rtProc.disconnect(); if (this._rtSrcNode) this._rtSrcNode.disconnect(); } catch (e) { /* */ }
      if (this._rtStream) { this._rtStream.getTracks().forEach((t) => t.stop()); this._rtStream = null; }
      this.rtSessionUpdate();
    }
    this.setState("listening", "ALWAYS", "on");
    this.setInd(this.els.indTts, "ALWAYS", "ok");
    this.logLine("sys", "상시 대기 ON — 등록된 내 목소리로 \"옴니야 …\" 하고 부를 때만 답합니다. 답한 뒤 15초 안에 시작한 말은 이어지는 대화로 봅니다.");
    this.gateNote("상시 대기 시작");
    OmniScreen.start();   // 화면 관찰 + 호기심 질문
  },

  stopAlways(reason, fromStopLive) {
    if (!this.alwaysOn) return;
    OmniScreen.stop();
    this.alwaysOn = false;
    this._gateRunning = false;
    localStorage.removeItem("omni.ai.always");
    clearTimeout(this._unmuteTimer);
    this.els.alwaysBtn.classList.remove("always");
    OmniNative.request("ai.gateStop", null, 5000).catch(() => {});
    this.gateNote(`상시 대기 종료 (${reason})`);
    if (!fromStopLive && this.live) this.stopLive(reason);
  },

  // 응답 생성 — 진행 중인 응답이 있으면 끝난 뒤 생성 (active response 오류 방지)
  rtCreateResponse() {
    if (this._rtResponding) { this._rtQueuedCreate = true; return; }
    this._rtResponding = true;
    this.rtSend({ type: "response.create" });
  },

  // 전사 정제: 환각 차단 + 호출어만 있는 발화 판별
  sanitizeTranscript(text, dur) {
    let t = String(text || "")
      .replace(/[\u3400-\u9FFF]/g, " ")                 // 한자 — 한국어 대화 전사엔 없음
      .replace(/[^\p{L}\p{N}\s.,!?%'\-]/gu, " ")
      .replace(/\s+/g, " ").trim();
    if (!t) return { drop: true, why: "빈 전사" };
    if (this.HALLU_RE.test(t) || this.HALLU_RE.test(String(text || ""))) return { drop: true, why: "전사 환각(상투구·프롬프트)" };
    // 프롬프트 어휘("옴니, 옴니야, 오미니아, OMNI_OS")만 나열된 전사 = 되풀이 환각
    const leftover = t.replace(/옴니야|옴니|오미니아|omni[_ ]?os|omni/gi, "").replace(/[\s.,!?'\-]/g, "");
    if (leftover.length === 0 && /오미니아|omni[_ ]?os/i.test(t)) return { drop: true, why: "전사 환각(프롬프트 되풀이)" };
    if (dur && dur < 0.7 && t.length > 12) return { drop: true, why: "전사 환각(길이 불일치)" };
    const rest = t.replace(this.WAKE_RE, "").replace(/[\s.,!?'\-0-9]/g, "");
    if (this.WAKE_RE.test(t) && rest.length <= 2) return { wakeOnly: true, text: t };
    return { text: t };
  },

  gateCmd(obj) {
    OmniNative.request("ai.gateCmd", JSON.stringify(obj), 5000).catch(() => {});
  },

  // 옴니 발화 중 마이크 처리: 루프백이 있으면 닫지 않고 "말하는 중"만 알린다(옴니 목소리는
  // 미디어로 걸러지고 사용자 목소리는 통과 → 끼어들기 가능). 루프백이 없으면 예전처럼 닫는다.
  gateMute(on) {
    this._gateMuted = !!on;
    this._omniSpeaking = !!on;
    if (this._gateLoopback) this.gateCmd({ cmd: "speaking", on: !!on });
    else this.gateCmd({ cmd: "mute", on: !!on });
  },

  // 끼어들기: 옴니가 말하는 중에 사용자 발화가 확인되면 재생을 끊고 응답을 취소한다
  bargeIn() {
    this.rtStopPlayback();
    this.rtSend({ type: "response.cancel" });
    this._rtResponding = false;
    this._rtQueuedCreate = false;
    clearTimeout(this._unmuteTimer);
    this._lastOmniDoneAt = Date.now();
    this._omniSpeaking = false;
    this._gateMuted = false;
    if (this._gateLoopback) this.gateCmd({ cmd: "speaking", on: false });   // 게이트도 즉시 일반 청취로
    if (this._rtOmniLine) { this._rtOmniLine.querySelector(".txt").textContent += " …(끼어듦)"; this._rtOmniLine = null; this._rtOmniText = ""; }
    this.gateNote("끼어들기 → 옴니 발화 중단");
  },

  gateNote(text) {
    OmniNative.request("ai.gateNote", JSON.stringify({ text }), 5000).catch(() => {});
  },

  // 사이드카 이벤트 (네이티브가 푸시)
  _gate(ev) {
    if (!ev || typeof ev !== "object") return;
    const e = ev.ev;
    if (e === "ready") {
      this._gateProfile = !!ev.profile;
      this.updateVoiceId();
      this.setInd(this.els.indStt, ev.profile ? "VOICE ID" : "NO PROFILE", ev.profile ? "ok" : "err");
      this.logLine("sys", `음성 게이트 준비 · 화자 인증 ${ev.profile ? `ON (임계 ${ev.threshold})` : "OFF — 목소리 미등록"}`);
      this.gateNote(`게이트 준비 profile=${ev.profile} thr=${ev.threshold} active=${ev.active} negatives=${(ev.negatives || []).join(",")}`);
    } else if (e === "speech_start") {
      this.micLevel = 0.7;
      this._speechStartAt = Date.now();
    } else if (e === "segment") {
      this.micLevel = 0;
      if (ev.partial) {
        // 옴니 발화 중 1.2초 부분 판정 — 사용자면 즉시 끊고, 발화 전체는 뒤이어 온다
        if (ev.user && this._omniSpeaking) {
          this.gateNote(`끼어들기 감지(${ev.label}) · excess=${ev.excess}s sim=${ev.sim} media=${ev.media} lips=${ev.lips && ev.lips.corr}`);
          this.bargeIn();
        }
        return;
      }
      if (ev.user) {
        const interrupt = !!this._omniSpeaking;
        if (interrupt) this.bargeIn();
        this._pendingSig = { label: ev.label || "user", band: ev.band, sim: ev.sim, thr: ev.thr, media: ev.media,
          lips: ev.lips, dur: ev.dur || 0, t0: ev.t0, interrupt };
        this.gateNote(`통과(${ev.label}) · sim=${ev.sim} media=${ev.media} lips=${ev.lips && ev.lips.corr} faces=${ev.lips && ev.lips.faces} dur=${ev.dur}`);
        if (this.alwaysOn && !this._rtUserLine) {
          this._rtUserLine = this.logLine("you", `… (${ev.label === "user" ? "내 목소리" : "불확실"}${ev.lips && ev.lips.face ? ` · 입술 ${ev.lips.corr}` : ""})`, true);
        }
      } else if (ev.why === "omni_voice") {
        // 옴니 자신의 목소리(루프백 확인) — 조용히 무시
      } else if (ev.why !== "short") {
        const now = Date.now();
        if (now - (this._lastIgnoreLogAt || 0) > 6000) {
          this._lastIgnoreLogAt = now;
          const why = ev.label === "media" ? `노트북 재생음 (상관 ${ev.media})`
            : ev.why && ev.why.startsWith("closer_to:") ? `등록된 타인 [${ev.why.slice(10)}] 목소리 (${ev.neg})`
            : ev.lips && ev.lips.face && ev.lips.act < 0.006 ? `내 입은 안 움직임 (유사도 ${ev.sim})`
            : `내 목소리 아님 (유사도 ${ev.sim == null ? "?" : ev.sim})`;
          const l = this.logLine("sys", `경청 · ${why}`); l.classList.add("ignored");
        }
        this.gateNote(`경청 · ${ev.label} sim=${ev.sim} media=${ev.media} lips=${ev.lips && ev.lips.corr}/${ev.lips && ev.lips.act} dur=${ev.dur}`);
      }
    } else if (e === "retranscript") {
      // 프롬프트 없는 재전사 결과 — 원래 항목(오디오는 세션에 남아 있음)으로 다시 판정
      const p = this._retrans && this._retrans[String(ev.t0)];
      if (!p) return;
      delete this._retrans[String(ev.t0)];
      const text = String(ev.text || "").trim();
      this.gateNote(`재전사 결과 · t0=${ev.t0}: ${text || "(빈 전사/" + (ev.why || "") + ")"}`);
      this._pendingSig = p.sig;
      this._rtUserLine = p.line;
      this.gateDecide(p.itemId, text);
    } else if (e === "stats") {
      this.gateNote(`신호 · 루프백 ${ev.sys_hz}Hz 레벨 ${ev.sys_level} · 얼굴 ${ev.face_hz}Hz · 세그먼트 ${ev.segments}/15s`);
      this._gateStats = ev;
    } else if (e === "ambient") {
      const san = this.sanitizeTranscript(ev.text, ev.dur || 0);
      if (san.drop) return;                       // 주변음 전사 환각(프롬프트 되풀이 등) 버림
      OmniMem.ambient(ev.label, san.text || ev.text, ev.t0, ev.sig);
      const now = Date.now();
      if (now - (this._lastAmbientLogAt || 0) > 8000) {
        this._lastAmbientLogAt = now;
        const l = this.logLine("sys", `[주변·${ev.label === "media" ? "재생음" : "사람"}] ${String(ev.text).slice(0, 70)}`); l.classList.add("ignored");
      }
    } else if (e === "enroll") {
      this._lastAnalysis = null;
      this.els.voiceId.textContent = `RECORDING ${Math.round((ev.progress || 0) * 100)}% · 발화 ${ev.secs || 0}s`;
      this.els.voiceId.className = "ai-voiceid rec";
    } else if (e === "profiles") {
      this._voiceProfiles = ev;
      const sel = this.els.voiceSel;
      sel.textContent = "";
      const users = (ev.list || []).filter((p) => p.kind === "user");
      for (const p of users) {
        const o = document.createElement("option");
        o.value = p.name;
        o.textContent = `${p.name} · ${p.embs}개 · ${p.secs}s`;
        if (p.name === ev.active) o.selected = true;
        sel.appendChild(o);
      }
      if (!users.length) { const o = document.createElement("option"); o.value = "me"; o.textContent = "me (미등록)"; sel.appendChild(o); }
      const others = (ev.list || []).filter((p) => p.kind === "other");
      this._gateProfile = users.some((p) => p.name === ev.active && p.embs > 0);
      if (!this._lastAnalysis) {
        this.els.voiceId.textContent = this._gateProfile
          ? `ID ${ev.active} 사용 중 · 타인 ${others.length}명 등록${others.length ? " (" + others.map((o) => o.name).join(", ") + ")" : ""}`
          : "NOT ENROLLED — ENROLL ME로 등록";
        this.els.voiceId.className = `ai-voiceid${this._gateProfile ? " ok" : ""}`;
      }
    } else if (e === "analysis") {
      this._lastAnalysis = ev;
      const negs = Object.entries(ev.neg || {}).map(([k, v]) => `${k} ${v}`).join(", ");
      const txt = ev.name
        ? `ID ${ev.name} · 임베딩 ${ev.embs}개 (등록 ${ev.sessions}회, 발화 ${ev.secs}s)\n자기 유사도 평균 ${ev.self_mean} · 최저 ${ev.self_min}\n타인 최대 ${ev.neg_max == null ? "— (타인 미등록)" : ev.neg_max + " [" + negs + "]"}\n구분 여유 ${ev.margin == null ? "—" : ev.margin} · 임계 ${ev.threshold} · 판정: ${ev.verdict}`
        : "프로필 없음";
      this.els.voiceId.textContent = txt;
      this.els.voiceId.className = `ai-voiceid ${ev.verdict === "약함" ? "warn" : "ok"}`;
      if (ev.verdict === "약함") this.logLine("sys", "주의: 내 목소리와 등록된 타인 목소리의 구분 여유가 좁습니다 — 더 다양한 톤으로 ENROLL ME를 하거나, 그 타인 목소리를 OTHER로 더 등록하세요.");
      if (ev.verdict === "타인 미등록") this.logLine("sys", "팁: OTHER로 TV·가족 등 다른 목소리를 등록하면 구분 경계를 학습해 더 정확해집니다.");
      this.gateNote(`분석 ${ev.name}: self=${ev.self_mean}/${ev.self_min} neg=${ev.neg_max} margin=${ev.margin} thr=${ev.threshold} ${ev.verdict}`);
    } else if (e === "enrolled") {
      this._gateProfile = ev.kind === "user" || this._gateProfile;
      this.logLine("sys", ev.kind === "other"
        ? `타인 목소리 등록 [${ev.name}] — ${ev.added}개 추가 (총 ${ev.total}). 임계 ${ev.threshold}${ev.warn ? " · " + ev.warn : ""}`
        : `목소리 등록 [${ev.name}] — ${ev.added}개 추가, 총 ${ev.total}개 (등록 ${ev.sessions}회 · 발화 ${ev.secs}s) · 임계 ${ev.threshold}${ev.verdict ? " · 판정 " + ev.verdict : ""}`);
      if (ev.warn) { const l = this.logLine("sys", ev.warn); l.className += " ignored"; }
      this.gateNote(`등록 ${ev.kind} ${ev.name} +${ev.added}=${ev.total} thr=${ev.threshold} ${ev.verdict || ""}`);
      this.setInd(this.els.indStt, "VOICE ID", "ok");
      if (this._enrollOnly) { this._enrollOnly = false; this._gateRunning = false; OmniNative.request("ai.gateStop", null, 5000).catch(() => {}); }
    } else if (e === "enroll_failed") {
      this.els.voiceId.textContent = "ENROLL FAILED";
      this.els.voiceId.className = "ai-voiceid";
      this.logLine("sys", `목소리 등록 실패 — ${ev.text || ""}`);
      if (this._enrollOnly) { this._enrollOnly = false; this._gateRunning = false; OmniNative.request("ai.gateStop", null, 5000).catch(() => {}); }
    } else if (e === "exit") {
      if (this.alwaysOn) {
        this.logLine("sys", "음성 게이트가 종료되어 상시 대기를 끕니다.");
        this.stopAlways("게이트 종료");
      }
    }
  },

  // 3단: 이 발화가 옴니에게 한 말인가 — 옴니 스스로 판단 (신호 + 대화 맥락 + 상황)
  async judgeAddressed(text, sig) {
    const secs = this._lastOmniDoneAt ? Math.round((Date.now() - this._lastOmniDoneAt) / 1000) : null;
    const lastOmni = [...this.history].reverse().find((m) => m.role === "assistant");
    const lastUser = [...this.history].reverse().find((m) => m.role === "user");
    const lips = sig.lips || {};
    const nowS = Date.now() / 1000;
    const otherVoice = OmniMem.ambientBuf.slice(-8).some((l) => nowS - l.ts < 45 && l.label === "other");
    const faces = (sig.lips && sig.lips.faces) || 0;
    const evidence = [faces > 1 ? `카메라에 얼굴 ${faces}명` : "", otherVoice ? "최근 45초 안에 다른 사람 목소리 감지" : ""].filter(Boolean);
    const facts = [
      `화자 판정: ${sig.label === "user" ? "건희 본인(확실)" : sig.label === "uncertain" ? "건희일 가능성 있음(불확실)" : sig.label || "?"}`,
      `다른 사람 존재 증거: ${evidence.length ? evidence.join(", ") : "없음 — 건희 혼자 있는 것으로 본다"}`,
      lips.face ? `카메라: 얼굴 ${lips.faces}명${lips.faces > 1 ? " (다른 사람이 곁에 있음)" : ""}, 입 움직임과 음성 동기 ${lips.corr} (0.3 이상이면 화면 앞 사람이 말하는 중)` : "카메라: 얼굴 미검출(자리 비움/가려짐)",
      `목소리 유사도 ${sig.sim ?? "?"} (임계 ${sig.thr ?? "?"}), 노트북 재생음 상관 ${sig.media ?? 0}`,
      secs == null ? "옴니가 이 세션에서 아직 말한 적 없음" : `옴니가 마지막으로 말을 마친 지 ${secs}초`,
      `현재 상황 추정: ${OmniMem.situation || "모름"}${OmniMem.people.length ? ` / 주변: ${OmniMem.people.join(", ")}` : ""}`,
      OmniMem.screenActivity ? `화면 관찰: ${OmniMem.screenActivity}` : "",
      sig.interrupt ? "이 발화는 옴니가 말하는 도중에 끼어든 것 — 대부분 옴니에게 하는 말(정정·중단·질문). \"그만/됐어/조용히\"처럼 멈추라는 뜻이면 respond=false, kind=command" : "",
      OmniScreen.pending ? `옴니가 방금 먼저 물어본 질문: "${OmniScreen.pending.q}" — 이 발화는 그 답일 가능성이 큼 (답이면 respond=true, kind=reply)` : "",
    ].join("\n");
    try {
      const r = await OmniNative.request("ai.chat", JSON.stringify({
        model: "claude-haiku-4-5-20251001", maxTokens: 200,
        system: "당신은 상시 대기 중인 음성 비서 '옴니'의 판단 모듈이다. 사용자 이름은 건희. 방금 들린 발화가 \"옴니에게 한 말\"인지 판단해 JSON만 출력한다: {\"respond\":true|false,\"kind\":\"command|question|chat|reply|self_talk|to_others|media|noise\",\"why\":\"근거 20자 이내\"}. 다른 텍스트 없이 JSON 한 줄만.\nrespond=true: 옴니에게 직접 하는 명령·질문·요청·잡담(이름을 안 불러도), 옴니의 직전 말에 대한 답·반응·짧은 수긍·감사(\"응 알겠어\", \"고마워\", \"아니 그거 말고\")·이어지는 질문(시간이 지났어도 내용이 이어지면), 옴니를 부르는 말.\nrespond=false: 혼잣말·생각 소리(\"아 배고프다\", \"어디 뒀지\"), 다른 사람에게 하는 말(상대 이름을 부르거나 남과 주고받는 대화체, 전화 통화), 소리 내어 읽기, 영상·노래 내용, 의미 없는 조각, 옴니가 답할 필요가 없는 말.\n중요: to_others는 [다른 사람 존재 증거]가 있을 때만 고른다. 증거가 없으면 건희는 혼자이고, \"너/네가/얘/네 앱\" 같은 2·3인칭은 옴니를 가리킨다. 옴니가 방금 말하거나 질문한 직후의 반문·확인(\"뭐라고?\", \"얘 말하는 거야?\", \"너한테 말한 거 맞아\", \"네 앱에서 말하는 거야?\")은 respond=true, kind=reply. 자기 앱(OMNI_OS)에 대한 질문도 옴니에게 하는 말이다.\n판단 기준: 비서에게 시킬 만한 일/질문인가, 옴니의 직전 말과 이어지는가, 화자가 건희 본인인가(불확실하면 보수적으로), 곁에 다른 사람이 있다는 증거가 있는가. 확신이 없으면 false.",
        messages: [{ role: "user", content: `[신호]\n${facts}\n\n[옴니의 직전 말] ${lastOmni ? String(lastOmni.content).slice(0, 200) : "(없음)"}\n[건희의 직전 말] ${lastUser ? String(lastUser.content).slice(0, 200) : "(없음)"}\n\n[지금 들린 발화] ${text}` }],
      }), 15000);
      const txt = (r && r.ok && (r.text || (r.content || []).map((b) => b.text || "").join(""))) || "";
      let o = null;
      const m = /\{[\s\S]*\}/.exec(txt);
      if (m) { try { o = JSON.parse(m[0]); } catch (e) { o = null; } }
      if (!o) {
        // 잘린 출력 복구: respond/kind만이라도 정규식으로
        const r1 = /"respond"\s*:\s*(true|false)/.exec(txt);
        const k1 = /"kind"\s*:\s*"([a-z_]+)"/.exec(txt);
        if (!r1) return { respond: false, kind: "noise", why: "판정 불가" };
        o = { respond: r1[1] === "true", kind: k1 ? k1[1] : "", why: "(근거 잘림)" };
      }
      return { respond: !!o.respond, kind: String(o.kind || ""), why: String(o.why || "") };
    } catch (e) {
      return { respond: false, kind: "noise", why: "판정 실패" };
    }
  },

  async gateDecide(itemId, rawText) {
    const line = this._rtUserLine;
    this._rtUserLine = null;
    const sig = this._pendingSig || { label: "user" };
    this._pendingSig = null;
    const san = this.sanitizeTranscript(rawText, sig.dur || 0);
    const del = () => { if (itemId) this.rtSend({ type: "conversation.item.delete", item_id: itemId }); };
    if (san.drop) {
      // 게이트가 사용자 목소리로 확인한 발화인데 전사기가 프롬프트를 되풀이(환각)했거나 비었으면
      // 실제로 한 말일 가능성이 크다 → 버리지 않고 프롬프트 없이 다시 전사해 본다 (1회)
      const echo = /환각\((상투구|프롬프트)/.test(san.why) || san.why === "빈 전사";
      if (echo && !sig.retried && sig.t0 != null && (sig.label === "user" || sig.label === "uncertain")) {
        this._retrans = this._retrans || {};
        this._retrans[String(sig.t0)] = { itemId, sig: { ...sig, retried: true }, line, at: Date.now(), raw: rawText };
        this.gateCmd({ cmd: "retranscribe", t0: sig.t0 });
        this.gateNote(`전사 재시도(${san.why}) · t0=${sig.t0}: ${rawText}`);
        setTimeout(() => {
          const p = this._retrans && this._retrans[String(sig.t0)];
          if (!p) return;
          delete this._retrans[String(sig.t0)];
          if (p.line) p.line.remove();
          del();
          this.gateNote(`무시 · 재전사 응답 없음: ${rawText}`);
        }, 15000);
        return;
      }
      if (line) line.remove();
      del();
      if (san.why !== "빈 전사") { this.gateNote(`무시 · ${san.why}: ${rawText}`); const l = this.logLine("sys", `무시 · ${san.why}`); l.classList.add("ignored"); }
      return;
    }
    const text = san.text;
    if (san.wakeOnly) {
      if (line) { line.querySelector(".txt").textContent = `${text} (듣는 중)`; line.classList.remove("pending"); }
      del();
      this._lastOmniDoneAt = Date.now();
      this._wakeAt = Date.now();
      this.gateNote(`호출만 감지 → 듣는 중: ${text}`);
      return;
    }
    let dec;
    const correction = /(너한테|옴니한테|너에게|옴니에게)\s*(말한|한|하는)\s*(거|것|말)|너 ?말하는 ?거|다른 사람한테 (말한|한) ?(게|거) 아니|환각 ?아니|내가 말(하는|한) ?(거|것|게) 맞/.test(text);
    if (this.WAKE_RE.test(text)) dec = { respond: true, kind: "call", why: "호출어" };
    else if (correction) dec = { respond: true, kind: "reply", why: "정정 — 옴니에게 한 말" };
    else if (this._wakeAt && Date.now() - this._wakeAt < 15000) { dec = { respond: true, kind: "call", why: "호출 직후 이어진 말" }; this._wakeAt = 0; }
    else if (OmniScreen.pending && Date.now() - OmniScreen.pending.at < OmniScreen.ANSWER_WAIT_MS) dec = { respond: true, kind: "reply", why: "옴니 질문에 대한 답" };
    else dec = await this.judgeAddressed(text, sig);
    if (dec.respond && correction && this._recentIgnored && this._recentIgnored.length) {
      // "너한테 한 말이야" 정정 → 방금 무시했던 말들을 되살려 함께 전달
      const missed = this._recentIgnored.filter((x) => Date.now() - x.at < 120000).map((x) => x.text);
      if (missed.length) {
        this.rtSend({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text",
          text: `[방금 전에 옴니에게 했던 말인데 잘못 무시됨] ${missed.join(" / ")}` }] } });
        this.gateNote(`정정으로 되살린 발화: ${missed.join(" / ")}`);
      }
      this._recentIgnored = [];
    }
    const sigTxt = `${sig.label || "?"}${sig.lips && sig.lips.face ? ` 입술${sig.lips.corr}` : ""} 목소리${sig.sim ?? "?"}`;
    if (dec.respond) {
      if (line) { line.querySelector(".txt").textContent = text; line.classList.remove("pending"); }
      else this.logLine("you", text);
      this.history.push({ role: "user", content: text }); OmniMem.conv("user", text);
      this.trimHistory();
      this.rtCreateResponse();
      this.gateNote(`응답 · ${dec.kind}/${dec.why} [${sigTxt}]: ${text}`);
      OmniScreen.onUserReply(text);   // 호기심 질문의 답이면 기억에 저장
      if (dec.why === "호출어" || (sig.lips && sig.lips.corr >= 0.5)) this.gateCmd({ cmd: "adapt" });
    } else {
      if (line) {
        line.querySelector(".txt").textContent = `(경청 · ${dec.kind}${dec.why ? " — " + dec.why : ""}) ${text}`;
        line.classList.remove("pending"); line.classList.add("ignored");
      }
      del();
      // 응답은 안 해도 기억은 한다 — 건희가 남에게 한 말/혼잣말은 관찰 재료
      OmniMem.ambient(sig.label === "user" ? "user_other" : (sig.label || "uncertain"), text, sig.t0, { kind: dec.kind, sim: sig.sim, lips: sig.lips && sig.lips.corr });
      if (sig.label === "user") { (this._recentIgnored = this._recentIgnored || []).push({ text, at: Date.now() }); this._recentIgnored = this._recentIgnored.slice(-4); }
      this.gateNote(`경청 · ${dec.kind}/${dec.why} [${sigTxt}]: ${text}`);
    }
  },

  async updateVoiceId() {
    const st = await OmniNative.request("ai.gateStatus", null, 5000).catch(() => null);
    this._gateProfile = !!(st && st.profile);
    if (!this._voiceProfiles) {
      this.els.voiceId.textContent = this._gateProfile ? "ENROLLED" : "NOT ENROLLED — ENROLL ME로 등록";
      this.els.voiceId.className = `ai-voiceid${this._gateProfile ? " ok" : ""}`;
    }
  },

  async ensureGate() {
    if (this._gateRunning) return true;
    const g = await OmniNative.request("ai.gateStart", null, 15000).catch(() => null);
    if (!g || !g.ok) { this.logLine("sys", "음성 게이트를 시작하지 못했습니다."); return false; }
    this._gateRunning = true;
    this._enrollOnly = !this.alwaysOn;
    await new Promise((res) => setTimeout(res, 2500)); // 모델 로드 대기
    return true;
  },

  async voiceCmd(obj) {
    if (!OmniNative.available) return;
    if (!(await this.ensureGate())) return;
    this.gateCmd(obj);
    if (this._enrollOnly && obj.cmd !== "enroll") {
      // 상시 모드가 아니면 프로필 명령 처리 후 게이트 내림 (이벤트 수신 시간 확보)
      setTimeout(() => { if (!this.alwaysOn) { this._enrollOnly = false; this._gateRunning = false; OmniNative.request("ai.gateStop", null, 5000).catch(() => {}); } }, 2500);
    }
  },

  async enrollVoice(kind) {
    if (!OmniNative.available) { this.logLine("sys", "앱에서만 가능합니다."); return; }
    if (!(await this.ensureGate())) return;
    if (kind === "other") {
      const label = prompt("타인 목소리 라벨 (예: TV, 엄마, 친구)", "TV");
      if (!label) return;
      this.logLine("sys", `타인 목소리 등록 [${label.trim()}] — 15초 동안 그 사람(또는 TV)이 말하게 두세요. 내 목소리는 섞이지 않게.`);
      this.gateCmd({ cmd: "enroll", seconds: 15, kind: "other", name: label.trim() });
      return;
    }
    const name = this.els.voiceSel.value || "me";
    this.logLine("sys", `목소리 등록 [${name}] — 15초 동안 평소 톤으로 여러 문장을 말해 주세요 (덧붙여 누적됩니다). 예: \"옴니야 오늘 날씨 어때. 내일 일정 알려줘. 카톡 온 거 있어?\"`);
    this.gateCmd({ cmd: "enroll", seconds: 15, kind: "user", name });
  },

  // ================= 컴퓨터 조작 에이전트 (마우스·키보드·화면) =================
  // 스크린샷을 보고 한 번에 한 행동씩 결정하는 루프. 결제·전송·삭제는 사용자 명시 요청 외 금지.
  _cuBusy: false,
  async computerUse(task) {
    if (!OmniNative.available) return "실패: 앱에서만 가능";
    if (this._cuBusy) return "실패: 다른 컴퓨터 조작 작업이 진행 중";
    const st = await OmniNative.request("cu.status", null, 5000).catch(() => null);
    if (!st || !st.accessibility || !st.screen) {
      OmniNative.request("cu.request", null, 5000).catch(() => {});
      const need = [!st || !st.accessibility ? "'손쉬운 사용'" : "", !st || !st.screen ? "'화면 기록'" : ""].filter(Boolean).join("과 ");
      const msg = `실패: 권한 필요 — 시스템 설정 > 개인정보 보호 및 보안에서 Omni OS에 ${need} 권한을 허용한 뒤 앱을 다시 시작해 주세요`;
      this.gateNote(`컴퓨터 · ${msg} (accessibility=${st && st.accessibility}, screen=${st && st.screen})`);
      this.logLine("sys", msg);
      return msg;
    }
    this._cuBusy = true;
    const steps = [];
    const MAX_STEPS = 30;
    const log = (t) => { const l = this.logLine("sys", `컴퓨터 · ${t}`); l.classList.add("ignored"); this.gateNote(`컴퓨터 · ${t}`); };
    const send = (cmd, obj) => OmniNative.request(cmd, JSON.stringify(obj || {}), 12000).catch(() => null);
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    log(`작업 시작: ${task}`);
    OmniMem.append("action", `컴퓨터 조작 시작: ${task}`);
    let result = "실패: 단계 초과";
    let zoom = null;          // 직전 단계에서 요청한 확대 이미지
    let lastActKey = "", repeat = 0;
    try {
      for (let i = 0; i < MAX_STEPS; i++) {
        const [shot, apps] = await Promise.all([
          OmniNative.request("cu.screenshot", JSON.stringify({ maxWidth: 1152 }), 15000).catch(() => null),
          send("cu.apps"),
        ]);
        if (!shot || !shot.ok) { result = `실패: 화면 캡처 불가 (${(shot && shot.error) || "?"})`; break; }
        const history = steps.slice(-10).map((s, k) => `${k + 1}. ${s}`).join("\n") || "(없음)";
        const content = [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: shot.jpeg } },
        ];
        if (zoom) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: zoom.jpeg } });
        content.push({ type: "text", text:
          `[목표] ${task}\n[화면 크기] ${shot.w}x${shot.h} px${zoom ? `\n[확대 이미지] 스크린샷의 (${zoom.x},${zoom.y}) 위치 ${zoom.zw}x${zoom.zh} 영역을 확대한 것 — 클릭 좌표는 여전히 전체 스크린샷 기준` : ""}\n[전면 앱] ${(apps && apps.front) || "?"}\n[실행 중인 앱] ${((apps && apps.apps) || []).join(", ") || "?"}\n[지금까지 한 행동]\n${history}\n\n다음 행동을 JSON으로.` });
        zoom = null;
        // 비전 모델 호출 — 빈 응답이면 재시도, 이미지 거부(refusal)면 화면 없이(blind) 진행
        let act = null, lastErr = "", refused = false;
        for (let attempt = 0; attempt < 3 && !act; attempt++) {
          const blind = refused || (attempt > 0 && lastErr === "empty");
          const msgContent = blind
            ? [{ type: "text", text: `[스크린샷 사용 불가 — 비전 모델이 이 화면 분석을 거부함(화면 속 사람 이미지 등)] 화면을 보지 않고도 가능한 행동(open_app/open_url/key/type/wait)만으로 목표를 진행하세요. 화면 확인이 꼭 필요하면 fail + 이유(예: '재생 중인 영상 창을 최소화하면 진행 가능').\n[목표] ${task}\n[전면 앱] ${(apps && apps.front) || "?"}\n[실행 중인 앱] ${((apps && apps.apps) || []).join(", ") || "?"}\n[지금까지 한 행동]\n${history}\n\n다음 행동을 JSON으로.` }]
            : content;
          const r = await OmniNative.request("ai.chat", JSON.stringify({
            model: attempt < 2 ? "claude-sonnet-5" : "claude-opus-5", maxTokens: 400,
            system: [{ type: "text", cache_control: { type: "ephemeral" }, text: "당신은 개인 AI '옴니'의 컴퓨터 조작 모듈이다. 사용자(건희)의 맥 화면 스크린샷을 보고 목표를 달성할 다음 행동을 JSON 한 줄로만 출력한다. 형식: {\"actions\":[{\"action\":\"click|double_click|right_click|move|drag|scroll|type|key|open_url|open_app|zoom|wait\",\"x\":숫자,\"y\":숫자,\"x2\":숫자,\"y2\":숫자,\"w\":숫자,\"h\":숫자,\"dy\":숫자,\"text\":\"입력할 글자\",\"keys\":\"cmd+l 같은 단축키\",\"url\":\"https://…\",\"app\":\"앱 이름\",\"note\":\"한 줄 설명\"}, …],\"done\":false} 또는 목표 달성 시 {\"actions\":[],\"done\":true,\"note\":\"사용자가 원한 결과를 구체적으로(화면에서 읽은 실제 값)\"} 또는 불가능·위험 시 {\"actions\":[],\"fail\":true,\"note\":\"이유\"}.\n원칙(침착하고 확실하게):\n- 확신이 있는 연속 동작은 한 번에 최대 4개까지 묶는다(예: click 입력창 → type → key enter). 결과 확인이 필요하면 거기서 끊고 다음 스크린샷을 본다.\n- 앱을 열거나 전면으로 가져올 땐 독 아이콘 좌표 추정 대신 open_app(app 이름, 예: Chrome, Safari, Claude, Discord, KakaoTalk)을 쓴다. 웹 페이지는 open_url이 가장 빠르다.\n- 작은 글자·아이콘·썸네일 제목처럼 클릭 대상이 확실하지 않으면 먼저 zoom(x,y,w,h — 스크린샷 픽셀 영역)으로 확대해 확인한 뒤 클릭한다. 추측 클릭 금지.\n- 좌표는 스크린샷 픽셀(왼쪽 위 원점). 입력창은 click으로 포커스 후 type, 확정은 key enter. 로딩은 wait.\n- 같은 행동을 2번 반복했는데 화면이 안 바뀌면 다른 방법(단축키·URL·open_app·zoom)을 쓴다.\n- 결제·구매 확정·메시지/메일 전송·삭제·로그인 정보 입력은 사용자가 명시적으로 요청한 게 아니면 절대 하지 말고 그 직전에서 done으로 보고한다.\n- done의 note에는 화면에서 읽은 실제 값(제목·가격·상태)을 넣는다.\n- 속도: 생각은 짧게, note는 10자 내외. 확실한 동작은 최대 6개까지 한 번에 묶는다.\n- 포기 금지: 한 방법이 안 되면 실패 보고 대신 다른 방법을 순서대로 시도한다 — 앱 전면: open_app → key cmd+space 후 type 앱이름, key return(스포트라이트) → 독 아이콘 zoom 확인 후 click → key cmd+tab. 실행 중인 앱은 반드시 이 중 하나로 전면에 온다. 모든 방법을 써본 뒤에만 fail." }],
            messages: [{ role: "user", content: msgContent }],
          }), 60000);
          const txt = (r && r.ok && (r.text || (r.content || []).map((b) => b.text || "").join(""))) || "";
          const m = /\{[\s\S]*\}/.exec(txt);
          if (m) { try { act = JSON.parse(m[0]); } catch (e) { act = null; } }
          if (!act) {
            const stop = (r && r.stop) || "";
            lastErr = (r && !r.ok && r.error) ? String(r.error) : (stop === "refusal" ? "refusal" : stop && stop !== "end_turn" ? `stop=${stop}` : "empty");
            if (stop === "refusal") refused = true;
            this.gateNote(`컴퓨터 · 모델 응답 이상 (${attempt + 1}/3): ${lastErr}${blind ? " [blind]" : ""} ${txt.slice(0, 80)}`);
            await wait(500);
          } else if (blind) {
            this.gateNote("컴퓨터 · 화면 없이(blind) 행동 결정");
          }
        }
        if (!act) { result = `실패: 조작 모듈 응답 없음 (${lastErr})`; break; }
        if (act.done) { result = act.note || "완료"; log(`done — ${result}`); break; }
        if (act.fail) { result = `실패: ${act.note || ""}`; log(`fail — ${act.note || ""}`); break; }
        const actions = Array.isArray(act.actions) ? act.actions.slice(0, 6) : (act.action ? [act] : []);
        if (!actions.length) { result = "실패: 행동 없음"; break; }
        for (const a of actions) {
          const name = String(a.action || "");
          const key = `${name}:${a.x ?? ""},${a.y ?? ""}:${a.text || a.keys || a.url || a.app || ""}`;
          repeat = key === lastActKey ? repeat + 1 : 0; lastActKey = key;
          const desc = `${name}${a.x != null ? ` (${a.x},${a.y})` : ""}${a.text ? ` "${String(a.text).slice(0, 30)}"` : ""}${a.keys ? ` ${a.keys}` : ""}${a.url ? ` ${a.url}` : ""}${a.app ? ` ${a.app}` : ""} — ${a.note || ""}`;
          steps.push(desc); log(desc);
          if (repeat >= 3) { steps.push("(같은 행동 3회 반복 — 다른 방법 필요)"); break; }
          if (name === "click") await send("cu.click", { x: a.x, y: a.y, count: 1 });
          else if (name === "double_click") await send("cu.click", { x: a.x, y: a.y, count: 2 });
          else if (name === "right_click") await send("cu.click", { x: a.x, y: a.y, button: "right" });
          else if (name === "move") await send("cu.move", { x: a.x, y: a.y });
          else if (name === "drag") await send("cu.drag", { x: a.x, y: a.y, x2: a.x2, y2: a.y2 });
          else if (name === "scroll") await send("cu.scroll", { x: a.x ?? shot.w / 2, y: a.y ?? shot.h / 2, dy: a.dy ?? -5 });
          else if (name === "type") await send("cu.type", { text: String(a.text || "") });
          else if (name === "key") await send("cu.key", { keys: String(a.keys || "") });
          else if (name === "open_url") OmniNet.openUrl(String(a.url || ""));
          else if (name === "open_app") {
            const r2 = await send("cu.openApp", { name: String(a.app || "") });
            if (!r2 || !r2.ok) {
              // 마지막 수단: 스포트라이트로 연다 (cmd+space → 이름 → return)
              log(`open_app 실패 → 스포트라이트 폴백: ${a.app}`);
              await send("cu.key", { keys: "cmd+space" }); await wait(450);
              await send("cu.type", { text: String(a.app || "") }); await wait(800);
              await send("cu.key", { keys: "return" }); await wait(1200);
              const f = await send("cu.apps");
              if (!f || !String(f.front || "").toLowerCase().includes(String(a.app || "").toLowerCase().split(" ")[0])) steps.push(`(앱을 찾지 못함: ${a.app} — 독·앱 전환기로 시도할 것)`);
            }
          }
          else if (name === "zoom") { const z = await send("cu.zoom", { x: a.x, y: a.y, w: a.w || 320, h: a.h || 220 }); if (z && z.ok) zoom = z; }
          await wait(name === "open_url" || name === "open_app" || name === "wait" ? 900 : name === "zoom" ? 30 : 220);
        }
      }
    } catch (e) {
      result = `실패: ${e.message || e}`;
    } finally {
      this._cuBusy = false;
    }
    log(`결과: ${result}`);
    OmniMem.append("action", `컴퓨터 조작 결과: ${result.slice(0, 300)}`);
    return result;
  },

  // ================= 패널 UI 직접 조작 (전권) =================
  // 어떤 패널이든 화면에 있는 것을 읽고, 글자로 버튼을 찾아 누르고, 입력창에 쓴다.
  async appUI(input) {
    const key = String(input.panel || "").toLowerCase();
    const root = document.getElementById(`panel-${key}`) || document.querySelector(`.panel-${key}`);
    if (!root) return `오류: 패널 없음: ${key} (키: ${Object.keys(this.PANEL_LABELS).join(", ")})`;
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const label = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder")
      || (el.id ? ((root.querySelector(`label[for="${el.id}"]`) || {}).textContent || "") : "")
      || el.textContent || el.value || "").replace(/\s+/g, " ").trim();
    const findEl = (sel, target) => {
      const t = String(target || "").trim().toLowerCase();
      if (!t) return null;
      let el = null;
      try { el = root.querySelector(t); } catch (e) { el = null; }
      if (el) return el;
      const cands = [...root.querySelectorAll(sel)].filter(visible);
      return cands.find((c) => label(c).toLowerCase() === t) || cands.find((c) => label(c).toLowerCase().includes(t))
        || cands.find((c) => (c.id || "").toLowerCase().includes(t)) || null;
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const op = String(input.op || "read").toLowerCase();
    // 어떤 조작이든 그 패널이 화면에 떠 있어야 요소가 보인다 — 먼저 연다
    const navBtn = document.querySelector(`.nav-item[data-panel="${key}"]`);
    if (navBtn && !root.classList.contains("active")) { navBtn.click(); await wait(400); }
    if (op === "read") {
      const heads = [...root.querySelectorAll("h1,h2,h3,.nf-title,.ai-title,.sp1-title,.nf-sec-h,.ai-side-h")].filter(visible).map(label).filter(Boolean);
      const buttons = [...new Set([...root.querySelectorAll("button,[role=button],.ig-tab")].filter(visible).map(label).filter(Boolean))];
      const inputs = [...root.querySelectorAll("input,textarea,select")].filter(visible).map((el) =>
        `${el.tagName.toLowerCase()}${el.type ? "[" + el.type + "]" : ""} "${label(el)}"${el.value ? ` = ${String(el.value).slice(0, 40)}` : ""}`);
      const items = [...root.querySelectorAll("li,.nf-item,.nw-item,.mk-row,.cl-ev,.wx-day,.pj-item,.mk-fxcard,.cl-day .h,.wx-now")].filter(visible).map(label).filter(Boolean).slice(0, 40);
      let text = root.innerText.replace(/\n{2,}/g, "\n").trim();
      if (text.length > 1800) text = text.slice(0, 1800) + " …";
      return [`[패널 ${this.PANEL_LABELS[key] || key}]`, heads.length ? `제목: ${heads.join(" | ")}` : "",
        buttons.length ? `버튼: ${buttons.slice(0, 40).join(" | ")}` : "",
        inputs.length ? `입력: ${inputs.join(" | ")}` : "",
        items.length ? `항목:\n${items.map((x) => "- " + x.slice(0, 120)).join("\n")}` : "",
        `본문:\n${text}`].filter(Boolean).join("\n");
    }
    if (op === "click") {
      const el = findEl("button,[role=button],a,.ig-tab,.nav-item,.nf-item,.nw-item,.mk-row,.cl-ev,.pj-item,option,label,span,div", input.target);
      if (!el) return `오류: '${input.target}' 요소를 찾지 못했습니다 (read로 버튼 목록 확인)`;
      el.click();
      await wait(300);
      OmniMem.append("action", `패널 ${key} 클릭: ${label(el)}`);
      return `클릭: ${label(el) || input.target}`;
    }
    if (op === "type") {
      const el = findEl("input,textarea,[contenteditable=true]", input.target);
      if (!el) return `오류: '${input.target}' 입력창을 찾지 못했습니다`;
      let v = String(input.value ?? "");
      const enter = v.endsWith("\n"); if (enter) v = v.slice(0, -1);
      el.focus();
      if (el.isContentEditable) el.textContent = v; else el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      if (enter) el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await wait(400);
      OmniMem.append("action", `패널 ${key} 입력: ${label(el)} ← ${v}${enter ? " ⏎" : ""}`);
      return `입력 완료: ${label(el) || input.target} ← "${v}"${enter ? " (Enter)" : ""}`;
    }
    if (op === "select") {
      const el = findEl("select", input.target);
      if (!el) return `오류: '${input.target}' 선택 상자를 찾지 못했습니다`;
      const want = String(input.value || "").toLowerCase();
      const opt = [...el.options].find((o) => o.textContent.toLowerCase().includes(want) || o.value.toLowerCase() === want);
      if (!opt) return `오류: 옵션 없음: ${input.value} (있는 옵션: ${[...el.options].map((o) => o.textContent).join(", ")})`;
      el.value = opt.value; el.dispatchEvent(new Event("change", { bubbles: true }));
      return `선택: ${opt.textContent}`;
    }
    return `오류: 모르는 op ${op}`;
  },

  async handleRtTool(callId, name, args) {
    let output = "";
    if (name === "ask_brain") {
      this.logLine("sys", `도구 · ask_brain: ${(args.query || "").slice(0, 60)}`);
      this.setInd(this.els.indLlm, "BRAIN", "busy");
      const res = await this.runClaude([
        ...this.history,
        { role: "user", content: args.query || "" },
      ]);
      output = res.ok ? res.text : `실패: ${res.error}`;
      this.setInd(this.els.indLlm, "READY", "ok");
    } else if (name === "get_status") {
      output = await this.gatherContext();
    } else if (name === "open_panel") {
      const k = (args.key || "").toLowerCase();
      const btn = document.querySelector(`.nav-item[data-panel="${k}"]`);
      if (btn && this.PANEL_LABELS[k]) {
        btn.click();
        this.logLine("sys", `패널 전환: ${this.PANEL_LABELS[k]}`);
        output = "OK";
      } else output = `unknown panel: ${k}`;
    } else if (name === "app_action") {
      const res = await this.runAction(args.spec || "");
      this.logLine("sys", `${res.ok ? "OK" : "실패"} · ${res.msg}`);
      output = res.msg;
    } else if (name === "check_notifications") {
      this.logLine("sys", `도구 · check_notifications ${(args.app || "전체")}`);
      output = await this.execTool("check_notifications", args || {});
    } else if (name === "check_gmail") {
      this.logLine("sys", "도구 · check_gmail");
      output = await this.execTool("check_gmail", args || {});
    } else if (name === "check_weather") {
      this.logLine("sys", `도구 · check_weather ${(args && args.city) || ""}`);
      output = await this.execTool("check_weather", args || {});
    } else if (name === "check_news") {
      this.logLine("sys", `도구 · check_news ${(args && (args.query || args.category)) || ""}`);
      output = await this.execTool("check_news", args || {});
    } else if (name === "calculate") {
      this.logLine("sys", `도구 · calculate ${(args && args.expression) || ""}`);
      output = await this.execTool("calculate", args || {});
    } else if (["check_markets", "check_calendar", "add_event", "smart_control", "recall_memory", "open_web_search", "app_ui", "use_computer", "run_shell"].includes(name)) {
      this.logLine("sys", `도구 · ${name}`);
      output = await this.execTool(name, args || {});
    } else {
      output = `unknown tool: ${name}`;
    }
    this.rtSend({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: String(output).slice(0, 12000),
      },
    });
    this.rtSend({ type: "response.create" });
  },

  trimHistory() {
    while (this.history.length > 16) this.history.shift();
    if (this.history[0] && this.history[0].role !== "user") this.history.shift();
  },

  // ---- 코어 비주얼라이저 ----
  sizeCore() {
    const c = this.els.core;
    const rect = c.getBoundingClientRect();
    if (rect.width < 4) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(rect.width * dpr);
    c.height = Math.round(rect.height * dpr);
  },

  drawCore() {
    requestAnimationFrame(() => this.drawCore());
    const panel = document.getElementById("panel-ai");
    if (!panel || !panel.classList.contains("active")) return;
    const c = this.els.core;
    if (c.width === 0) this.sizeCore();
    const g = c.getContext("2d");
    const W = c.width, H = c.height;
    if (W === 0) return;
    g.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2;
    const base = Math.min(W, H) * 0.3;
    const t = performance.now() / 1000;
    const style = getComputedStyle(document.documentElement);
    const cyan = style.getPropertyValue("--cyan").trim() || "#35d6ff";
    const ok = style.getPropertyValue("--ok").trim() || "#3dffa8";
    const warn = style.getPropertyValue("--warn").trim() || "#ffc857";
    const alert = style.getPropertyValue("--alert").trim() || "#ff4d5e";

    // 내부 코어 점
    g.beginPath();
    g.arc(cx, cy, base * 0.12, 0, Math.PI * 2);
    g.fillStyle = this.state === "speaking" ? ok
      : this.state === "listening" ? alert
        : this.state === "thinking" ? warn : cyan;
    g.globalAlpha = 0.85;
    g.fill();
    g.globalAlpha = 1;

    if (this.state === "speaking" && this._analyser) {
      // 출력 파형을 방사형 링으로
      const data = new Uint8Array(this._analyser.fftSize);
      this._analyser.getByteTimeDomainData(data);
      g.beginPath();
      for (let i = 0; i <= 120; i++) {
        const a = (i / 120) * Math.PI * 2;
        const v = (data[Math.floor((i / 120) * (data.length - 1))] - 128) / 128;
        const r = base + v * base * 0.55;
        const x = cx + Math.cos(a) * r, yy = cy + Math.sin(a) * r;
        if (i === 0) g.moveTo(x, yy); else g.lineTo(x, yy);
      }
      g.closePath();
      g.strokeStyle = ok;
      g.lineWidth = Math.max(1.5, W / 160);
      g.globalAlpha = 0.9;
      g.stroke();
      g.globalAlpha = 1;
    } else if (this.state === "listening") {
      // 마이크 레벨 링
      const lv = this.micLevel;
      g.beginPath();
      g.arc(cx, cy, base * (0.7 + lv * 0.6), 0, Math.PI * 2);
      g.strokeStyle = alert;
      g.lineWidth = Math.max(1.5, W / 160);
      g.globalAlpha = 0.5 + lv * 0.5;
      g.stroke();
      g.globalAlpha = 1;
    } else {
      // 대기/사고: 회전 아크 세그먼트
      const speed = this.state === "thinking" ? 2.6 : 0.4;
      const col = this.state === "thinking" ? warn : cyan;
      for (let s = 0; s < 3; s++) {
        g.beginPath();
        g.arc(cx, cy, base * (0.75 + s * 0.22),
          t * speed + s * 2.1, t * speed + s * 2.1 + Math.PI * 0.7);
        g.strokeStyle = col;
        g.lineWidth = Math.max(1, W / 220);
        g.globalAlpha = 0.55 - s * 0.13;
        g.stroke();
      }
      g.globalAlpha = 1;
    }
  },
});

// ---------- module: OMNIA (로컬 무검열 LLM 보조 AI — 옴니 위 팝업) ----------
OmniOS.register("omnia", {
  MODEL: "qwen3.6-aggressive-local:latest",
  SYSTEM: [
    "당신은 '오미니아'입니다. OMNI_OS의 관제 AI '옴니'를 돕는 보조 AI이며, 사용자(건희)도 직접 돕습니다.",
    "로컬에서 실행되는 모델이라 외부로 나가는 데이터가 없습니다.",
    "한국어로 간결하고 실용적으로 답합니다. 사족·과한 안전 경고 없이 요청에 바로 응합니다.",
    "코드나 셸 스크립트를 줄 때는 반드시 ```언어 코드블록``` 으로 감쌉니다 — 사용자가 저장하거나 실행할 수 있습니다.",
    "터미널 실행이 필요하면 실행할 명령을 ```bash 블록으로 제시합니다. 실행은 사용자가 승인 버튼을 눌러야만 이뤄집니다.",
  ].join("\n"),
  history: [],
  _turn: 0,
  _busy: false,
  _cur: null,      // 현재 스트리밍 중인 {line, txt, raw}
  _open: false,

  init() {
    const $ = (id) => document.getElementById(id);
    this.els = {
      overlay: $("oa-overlay"), modal: $("oa-modal"), log: $("oa-log"),
      text: $("oa-text"), send: $("oa-send"), close: $("oa-close"),
      state: $("oa-state"), sub: $("oa-sub"),
    };
    window.OmniaAI = this; // 네이티브 스트리밍 푸시 대상
    this.els.close.addEventListener("click", () => this.hide());
    this.els.send.addEventListener("click", () => this.send());
    this.els.text.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.send();
      }
    });
    this.els.text.addEventListener("input", () => {
      this.els.text.style.height = "auto";
      this.els.text.style.height = `${Math.min(120, this.els.text.scrollHeight)}px`;
    });
    // 상시 플로팅 창 — 배경 클릭·ESC로는 닫히지 않는다 (X 버튼만)
    this.restorePos();
    this.initDrag();
    // 사용자가 직접 닫은 적이 없으면 앱 시작과 함께 띄운다
    if (localStorage.getItem("omni.omnia.closed") !== "1") {
      setTimeout(() => this.show(true), 900);
    }
  },

  // 헤더를 잡고 창 이동 (위치는 localStorage에 영속)
  initDrag() {
    const head = this.els.modal.querySelector(".oa-head");
    let sx = 0, sy = 0, ox = 0, oy = 0, on = false;
    const down = (e) => {
      if (e.target.closest("button")) return; // 닫기 버튼 등은 제외
      const r = this.els.modal.getBoundingClientRect();
      // right/bottom 기준을 left/top으로 고정해 드래그 계산을 단순화
      this.els.modal.style.left = `${r.left}px`;
      this.els.modal.style.top = `${r.top}px`;
      this.els.modal.style.right = "auto";
      this.els.modal.style.bottom = "auto";
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top; on = true;
      this.els.modal.classList.add("dragging");
      e.preventDefault();
    };
    const move = (e) => {
      if (!on) return;
      const w = this.els.modal.offsetWidth, h = this.els.modal.offsetHeight;
      const x = Math.max(0, Math.min(window.innerWidth - w, ox + e.clientX - sx));
      const y = Math.max(0, Math.min(window.innerHeight - h, oy + e.clientY - sy));
      this.els.modal.style.left = `${x}px`;
      this.els.modal.style.top = `${y}px`;
    };
    const up = () => {
      if (!on) return;
      on = false;
      this.els.modal.classList.remove("dragging");
      try {
        localStorage.setItem("omni.omnia.pos", JSON.stringify({
          left: this.els.modal.style.left, top: this.els.modal.style.top,
        }));
      } catch (e) { /* 무시 */ }
    };
    head.addEventListener("mousedown", down);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  },

  restorePos() {
    try {
      const p = JSON.parse(localStorage.getItem("omni.omnia.pos") || "null");
      if (p && p.left && p.top) {
        this.els.modal.style.left = p.left;
        this.els.modal.style.top = p.top;
        this.els.modal.style.right = "auto";
        this.els.modal.style.bottom = "auto";
      }
    } catch (e) { /* 무시 */ }
  },

  async show(auto) {
    this.els.overlay.hidden = false;
    this._open = true;
    localStorage.setItem("omni.omnia.closed", "0");
    // 자동 표시일 때는 사용자의 현재 입력 포커스를 뺏지 않는다
    if (!auto) setTimeout(() => this.els.text.focus(), 50);
    if (!OmniNative.available) {
      this.setState("OFFLINE", "err");
      this.els.sub.textContent = "앱에서만 동작";
      return;
    }
    const r = await OmniNative.request("omnia.status", null, 8000).catch(() => null);
    if (!r || !r.ok) {
      this.setState("LLM OFF", "err");
      if (r && r.error) this.logLine("sys", `진단: ${r.error}`);
      this.logLine("sys", "로컬 LLM이 응답하지 않습니다. 자동 시작이 등록돼 있으면 잠시 후 복구됩니다 — 계속 실패하면 터미널에서 `bash scripts/setup_ollama_agent.sh`를 실행해 주십시오.");
      return;
    }
    const has = (r.models || []).includes(this.MODEL);
    if (!has && (r.models || []).length) this.MODEL = r.models[0];
    this.els.sub.textContent = `LOCAL · ${this.MODEL.split(":")[0].toUpperCase()}`;
    this.setState("READY", "");
  },

  hide() {
    this.els.overlay.hidden = true;
    this._open = false;
    localStorage.setItem("omni.omnia.closed", "1"); // 직접 닫으면 완전히 사라짐
    if (this._busy) {
      OmniNative.request("omnia.stop", null, 5000).catch(() => {});
      this._busy = false;
    }
  },

  setState(text, cls) {
    this.els.state.textContent = text;
    this.els.state.className = `oa-state${cls ? " " + cls : ""}`;
  },

  logLine(who, text) {
    const hint = this.els.log.querySelector(".oa-hint");
    if (hint) hint.remove();
    const line = document.createElement("div");
    line.className = `oa-line ${who}`;
    const w = document.createElement("span");
    w.className = "who";
    w.textContent = who === "you" ? "YOU" : who === "oa" ? "OMNIA" : "SYS";
    const t = document.createElement("span");
    t.className = "txt";
    t.textContent = text;
    line.append(w, t);
    this.els.log.appendChild(line);
    this.els.log.scrollTop = this.els.log.scrollHeight;
    return { line, txt: t };
  },

  async send(preset) {
    const text = (preset || this.els.text.value).trim();
    if (!text || this._busy || !OmniNative.available) return;
    if (!preset) {
      this.els.text.value = "";
      this.els.text.style.height = "auto";
    }
    this.logLine("you", text);
    this.history.push({ role: "user", content: text });
    while (this.history.length > 20) this.history.shift();
    this._busy = true;
    this._turn++;
    this.setState("THINKING", "busy");
    this._cur = this.logLine("oa", "");
    this._cur.raw = "";
    const messages = [{ role: "system", content: this.SYSTEM }, ...this.history];
    const r = await OmniNative.request("omnia.chat", JSON.stringify({
      model: this.MODEL, messages, turn: this._turn,
    }), 15000).catch(() => null);
    if (!r || !r.ok) {
      this._busy = false;
      this.setState("ERROR", "err");
      this.logLine("sys", "로컬 LLM 호출 실패");
    }
  },

  // 네이티브 스트리밍 콜백
  _tok(payload, turn) {
    if (turn !== this._turn || !this._cur) return;
    this._cur.raw += payload.t || "";
    // <think> 블록은 흐리게 표시 (추론형 모델 대응)
    const shown = this._cur.raw
      .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
      .replace(/<think>[\s\S]*$/, "");
    this._cur.txt.textContent = shown || "…";
    this.els.log.scrollTop = this.els.log.scrollHeight;
  },

  _err(payload, turn) {
    if (turn !== this._turn) return;
    this._busy = false;
    this.setState("ERROR", "err");
    this.logLine("sys", `오류: ${payload.e || "unknown"}`);
  },

  _done(turn) {
    if (turn !== this._turn || !this._busy) return;
    this._busy = false;
    this.setState("READY", "");
    const raw = (this._cur && this._cur.raw) || "";
    const clean = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
    this.history.push({ role: "assistant", content: clean });
    if (this._cur) this.renderFinal(this._cur, clean);
    this._cur = null;
  },

  // 코드블록을 SAVE/RUN 버튼이 달린 블록으로 렌더
  renderFinal(cur, text) {
    cur.txt.textContent = "";
    const parts = text.split(/```(\w*)\n?([\s\S]*?)```/g);
    for (let i = 0; i < parts.length; i++) {
      if (i % 3 === 0) {
        if (parts[i].trim()) {
          const span = document.createElement("span");
          span.textContent = parts[i].replace(/^\n+|\n+$/g, "");
          cur.txt.appendChild(span);
        }
      } else if (i % 3 === 1) {
        const lang = parts[i] || "txt";
        const code = parts[i + 1] || "";
        cur.txt.appendChild(this.codeBlock(lang, code));
        i++; // 코드 본문 소비
      }
    }
    this.els.log.scrollTop = this.els.log.scrollHeight;
  },

  codeBlock(lang, code) {
    const box = document.createElement("div");
    box.className = "oa-code";
    const head = document.createElement("div");
    head.className = "oa-code-h";
    const label = document.createElement("span");
    label.textContent = lang.toUpperCase();
    const spacer = document.createElement("span");
    spacer.className = "ts-spacer";
    const save = document.createElement("button");
    save.className = "oa-cbtn";
    save.textContent = "SAVE";
    save.addEventListener("click", () => this.saveCode(lang, code));
    head.append(label, spacer, save);
    // 셸 계열만 실행 버튼 (승인 필수)
    if (/^(bash|sh|zsh|shell|console)$/i.test(lang)) {
      const run = document.createElement("button");
      run.className = "oa-cbtn run";
      run.textContent = "RUN";
      run.addEventListener("click", () => this.runCode(code, box));
      head.appendChild(run);
    }
    const pre = document.createElement("pre");
    pre.textContent = code.replace(/\n+$/, "");
    box.append(head, pre);
    return box;
  },

  saveCode(lang, code) {
    const EXT = { python: "py", javascript: "js", bash: "sh", sh: "sh", zsh: "sh",
      json: "json", html: "html", css: "css", cpp: "cpp", c: "c", swift: "swift",
      rust: "rs", go: "go", java: "java", ruby: "rb", yaml: "yml", txt: "txt" };
    const ext = EXT[lang.toLowerCase()] || "txt";
    OmniNative.request("omnia.save", JSON.stringify({
      name: `omnia_snippet.${ext}`, content: code,
    }), 120000).catch(() => {});
  },

  async runCode(code, box) {
    // 사용자 승인 없이는 절대 실행하지 않는다
    const preview = code.trim().split("\n").slice(0, 6).join("\n");
    if (!window.confirm(`오미니아가 이 명령을 실행하려 합니다.\n\n${preview}\n\n실행할까요?`)) {
      return;
    }
    const out = document.createElement("div");
    out.className = "oa-out";
    out.textContent = "실행 중…";
    box.appendChild(out);
    const r = await OmniNative.request("omnia.run",
      JSON.stringify({ script: code }), 90000).catch(() => null);
    if (!r || !r.ok) {
      out.textContent = `실행 실패: ${(r && r.error) || "unknown"}`;
      return;
    }
    out.textContent = `[exit ${r.code}]\n${r.output || "(출력 없음)"}`.slice(0, 8000);
    // 결과를 대화 맥락에 넣어 오미니아가 이어서 판단할 수 있게
    this.history.push({
      role: "user",
      content: `[터미널 실행 결과 exit=${r.code}]\n${(r.output || "").slice(0, 4000)}`,
    });
  },
});

// ---------- module: NOTIFICATIONS (앱 알림 수집 — 현재 카카오톡 섹션) ----------
OmniOS.register("notif", {
  _items: [],
  _lastSeen: 0,
  _seenTimer: null,
  _err: null,

  init() {
    const $ = (id) => document.getElementById(id);
    this.els = {
      panel: $("panel-notif"),
      kakaoList: $("nf-kakao-list"),
      kakaoCount: $("nf-kakao-count"),
      gmailList: $("nf-gmail-list"),
      gmailCount: $("nf-gmail-count"),
      gmailSetup: $("nf-gmail-setup"),
      gmailEmail: $("nf-gmail-email"),
      gmailPw: $("nf-gmail-pw"),
      gmailSave: $("nf-gmail-save"),
      gmailAdd: $("nf-gmail-add"),
      gmailReset: $("nf-gmail-reset"),
      discordList: $("nf-discord-list"),
      discordCount: $("nf-discord-count"),
      updated: $("nf-updated"),
      refresh: $("nf-refresh"),
      dot: $("nf-nav-dot"),
    };
    this._lastSeen = Number(localStorage.getItem("omni.notif.seen") || 0);
    this.els.refresh.addEventListener("click", () => this.refresh());
    this.els.gmailSave.addEventListener("click", () => this.saveGmail());
    this.els.gmailAdd.addEventListener("click", () => {
      this.els.gmailSetup.hidden = !this.els.gmailSetup.hidden;
      if (!this.els.gmailSetup.hidden) this.els.gmailEmail.focus();
    });
    this.els.gmailReset.addEventListener("click", () => {
      OmniNative.request("ai.clearKey", JSON.stringify({ provider: "gmail" }), 8000)
        .then(() => this.refresh()).catch(() => {});
    });
    document.addEventListener("omni:panel", (e) => {
      if (e.detail === "notif") {
        this.refresh();
        // 하이라이트를 잠깐 보여준 뒤 읽음 처리
        clearTimeout(this._seenTimer);
        this._seenTimer = setTimeout(() => this.markSeen(), 10000);
      } else {
        clearTimeout(this._seenTimer);
        if (!this.els.panel.classList.contains("active")) this.markSeen();
      }
    });
    if (OmniNative.available) {
      // 배경 폴링: 패널이 닫혀 있어도 새 알림 감지 (nav 점 + Halo 스냅샷)
      setInterval(() => this.refresh(true), 20000);
      // 패널이 보이는 동안엔 더 자주
      setInterval(() => {
        if (this.els.panel.classList.contains("active")) this.refresh(true);
      }, 15000);
      setTimeout(() => this.refresh(true), 5000);
    }
  },

  _isKakao(it) { return /kakao/i.test(it.app); },
  _isDiscord(it) { return /discord/i.test(it.app); },
  _gmailItems: [],
  _gmailErr: null,
  _gmailNeedSetup: false,

  async refresh(silent) {
    if (!OmniNative.available) {
      this._err = "브라우저 개발 모드 — 알림은 앱에서만 조회됩니다";
      this._gmailErr = this._err;
      this.render();
      return;
    }
    // 알림 DB(카톡·디스코드 등)와 지메일(IMAP 직결)을 병렬 조회
    const [notif, gmail] = await Promise.all([
      OmniNative.request("ai.notifRecent",
        JSON.stringify({ bundle: "", hours: 48 }), 20000).catch(() => null),
      OmniNative.request("ai.gmailRecent",
        JSON.stringify({ hours: 48 }), 30000).catch(() => null),
    ]);
    if (!notif || !notif.ok) {
      this._err = notif && notif.error === "FDA_REQUIRED"
        ? "전체 디스크 접근 권한 필요 — 시스템 설정 > 개인정보 보호 및 보안 > 전체 디스크 접근 권한에서 Omni OS를 허용한 뒤 앱을 재시작하십시오."
        : (silent ? this._err : `조회 실패: ${(notif && notif.error) || "unknown"}`);
    } else {
      this._err = null;
      this._items = notif.items || [];
      this._apps = notif.apps || [];
      // Halo 안경 브리지용 스냅샷 — 브리지의 파이썬은 TCC 때문에 알림 DB를
      // 직접 못 읽으므로, FDA를 가진 앱이 조회 결과를 파일로 밀어준다
      OmniNative.request("store.write", JSON.stringify({
        name: "halo_notif",
        data: JSON.stringify({
          ts: Date.now(),
          items: this._items.slice(0, 40).map((i) => ({
            app: i.app, ts: i.ts, title: i.title, body: i.body,
          })),
        }),
      }), 8000).catch(() => {});
    }
    this._gmailNeedSetup = false;
    if (!gmail || !gmail.ok) {
      const e = gmail && gmail.error;
      if (e === "NEED_SETUP") {
        this._gmailNeedSetup = true;
        this._gmailErr = null;
        this._gmailItems = [];
      } else if (e === "AUTH_FAILED") {
        this._gmailErr = "Gmail 인증 실패 — 이메일/앱 비밀번호를 다시 저장하십시오 (아래 SETUP)";
        this._gmailNeedSetup = true;
        this._gmailItems = [];
      } else if (!silent) {
        this._gmailErr = `Gmail 조회 실패: ${e || "unknown"}`;
      }
    } else {
      this._gmailErr = null;
      this._gmailItems = (gmail.items || []).map((m) => ({
        app: "gmail-imap", src: "imap", ts: m.ts,
        title: m.from, subtitle: m.account || "", body: m.subject, unread: !!m.unread,
        email: m.email || "", gmid: m.gmid || "",
      }));
      // 일부 계정만 실패한 경우 경고 표시용
      this._gmailWarn = (gmail.warnings || []).join(" · ") || null;
    }
    this.els.updated.textContent = `UPDATED ${new Date().toTimeString().slice(0, 5)}`;
    this.render();
  },

  async saveGmail() {
    const mail = this.els.gmailEmail.value.trim();
    const pw = this.els.gmailPw.value.trim();
    if (!mail || !pw) return;
    try {
      const r = await OmniNative.request("ai.saveKey", JSON.stringify({
        provider: "gmail", key: `${mail} ${pw.replace(/\s+/g, "")}`,
      }), 8000);
      if (r && r.ok) {
        this.els.gmailEmail.value = "";
        this.els.gmailPw.value = "";
        this.els.gmailSetup.hidden = true;
        this.refresh();
      }
    } catch (e) { /* 무시 */ }
  },

  // 알림 클릭 → 원본 앱/서비스 열기
  openItem(it) {
    if (this._isKakao(it)) {
      OmniNative.request("open.app",
        JSON.stringify({ bundle: "com.kakao.KakaoTalkMac" }), 8000).catch(() => {});
    } else if (this._isDiscord(it)) {
      OmniNative.request("open.app",
        JSON.stringify({ bundle: "com.hnc.Discord" }), 8000).catch(() => {});
    } else if (it.src === "imap") {
      // authuser로 해당 계정을 지정 + 메시지 ID 딥링크로 그 메일 바로 열기
      let url = "https://mail.google.com/mail/";
      if (it.email) url += `?authuser=${encodeURIComponent(it.email)}`;
      if (it.gmid) url += `#all/${it.gmid}`;
      OmniNative.request("open.url", JSON.stringify({ url }), 8000).catch(() => {});
    }
  },

  renderSection(listEl, countEl, items, hint) {
    listEl.textContent = "";
    countEl.textContent = String(items.length);
    if (!items.length) {
      const d = document.createElement("div");
      d.className = "nf-empty";
      d.textContent = "NO NOTIFICATIONS (최근 48시간)";
      listEl.appendChild(d);
      // 진단: 알림은 잡히는데 이 섹션만 비면 어떤 앱이 감지됐는지 보여준다
      if (hint && (this._apps || []).length) {
        const h = document.createElement("div");
        h.className = "nf-empty";
        h.style.opacity = "0.55";
        h.textContent = `감지된 앱: ${this._apps.slice(0, 8).join(", ")}`;
        listEl.appendChild(h);
      }
      return false;
    }
    let hasNew = false;
    const today = new Date().toDateString();
    for (const it of items) {
      const isNew = it.unread || it.ts * 1000 > this._lastSeen;
      if (isNew) hasNew = true;
      const row = document.createElement("div");
      row.className = `nf-item${isNew ? " new" : ""}`;
      row.title = "클릭하면 앱에서 열기";
      row.addEventListener("click", () => this.openItem(it));
      const d = new Date(it.ts * 1000);
      const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = d.toDateString() === today
        ? hm : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = it.title + (it.subtitle ? ` · ${it.subtitle}` : "");
      row.append(t, who);
      if (it.unread) {
        const u = document.createElement("span");
        u.className = "unread";
        u.textContent = "UNREAD";
        row.appendChild(u);
      }
      const msg = document.createElement("span");
      msg.className = "msg";
      msg.textContent = it.body;
      row.appendChild(msg);
      listEl.appendChild(row);
    }
    return hasNew;
  },

  renderError(listEl, countEl, text) {
    listEl.textContent = "";
    const d = document.createElement("div");
    d.className = "nf-err";
    d.textContent = text;
    listEl.appendChild(d);
    countEl.textContent = "0";
  },

  render() {
    // 카카오톡·디스코드 (알림 DB)
    let newK = false;
    let newD = false;
    if (this._err) {
      this.renderError(this.els.kakaoList, this.els.kakaoCount, this._err);
      this.renderError(this.els.discordList, this.els.discordCount, this._err);
    } else {
      newK = this.renderSection(this.els.kakaoList, this.els.kakaoCount,
        this._items.filter((it) => this._isKakao(it)));
      newD = this.renderSection(this.els.discordList, this.els.discordCount,
        this._items.filter((it) => this._isDiscord(it)), true);
    }
    // 지메일 (IMAP)
    let newG = false;
    this.els.gmailSetup.hidden = !this._gmailNeedSetup;
    if (this._gmailErr) {
      this.renderError(this.els.gmailList, this.els.gmailCount, this._gmailErr);
    } else if (this._gmailNeedSetup) {
      this.els.gmailList.textContent = "";
      this.els.gmailCount.textContent = "0";
    } else {
      newG = this.renderSection(this.els.gmailList, this.els.gmailCount,
        this._gmailItems);
      if (this._gmailWarn) {
        const w = document.createElement("div");
        w.className = "nf-err";
        w.textContent = `일부 계정 실패: ${this._gmailWarn}`;
        this.els.gmailList.prepend(w);
      }
    }
    // nav 점: 패널이 안 보일 때만 (보고 있는 중엔 하이라이트가 대신함)
    this.els.dot.classList.toggle("on",
      (newK || newG || newD) && !this.els.panel.classList.contains("active"));
  },

  markSeen() {
    if (!this._items.length) return;
    this._lastSeen = Date.now();
    localStorage.setItem("omni.notif.seen", String(this._lastSeen));
    this.render();
  },

  // 옴니가 "카톡 확인" 도구를 실행했을 때 — 패널로 점프 + 최신 하이라이트
  showFromAI() {
    const btn = document.querySelector('.nav-item[data-panel="notif"]');
    if (btn) btn.click(); // omni:panel 핸들러가 refresh + 읽음 타이머 처리
  },
});

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

  openForm(editItem) {
    const E = this.els;
    this._editItem = editItem || null;
    const p = editItem;
    E.fName.value = p ? p.name : "";
    E.fDesc.value = p ? (p.desc || "") : "";
    E.fTags.value = p ? (p.tags || []).join(", ") : "";
    E.fTarget.value = p ? (p.target || "") : "";
    E.fLink.value = p ? (p.link || "") : "";
    const pick = (group, v) => group.querySelectorAll("button").forEach((b) =>
      b.classList.toggle("active", b.dataset.v === v));
    pick(E.fType, p ? p.type : "software");
    pick(E.fPriority, p ? p.priority : "med");
    pick(E.fStatus, p ? p.status : "planning");
    E.modal.querySelector(".pj-form-title").textContent =
      p ? "PROJECT CONFIG" : "NEW PROJECT";
    E.fCreate.textContent = p ? "SAVE" : "CREATE";
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
    if (this._editItem) {
      // PROJECT CONFIG: 기존 항목 갱신 (id/생성일/폴더/패널 연결은 유지)
      const it = this._editItem;
      it.name = name;
      it.type = this.picked(E.fType) || it.type;
      it.priority = this.picked(E.fPriority) || it.priority;
      it.status = this.picked(E.fStatus) || it.status;
      it.desc = E.fDesc.value.trim();
      it.tags = E.fTags.value.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 6);
      it.target = E.fTarget.value || null;
      it.link = /^https?:\/\//i.test(link) ? link : null;
      this._editItem = null;
      this.persist();
      this.render();
      this.closeForm();
      return;
    }
    const item = {
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
    };
    this._items.unshift(item);
    this.persist();
    this.render();
    this.closeForm();
    // 실제 폴더 골격 생성: Projects/<이름>/{3d, arduino, code, notes}
    if (OmniNative.available) {
      OmniNative.request("proj.scaffold", JSON.stringify({ name }), 10000)
        .then((r) => {
          if (r && r.ok) {
            item.dir = r.path;
            this.persist();
          }
        })
        .catch(() => {});
    }
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
    mkItem("PROJECT CONFIG", { onClick: () => this.openForm(p) });

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
    // 프로젝트 폴더 준비: 재시작 후엔 루트 재등록이 필요하고(ce.addRoot),
    // 폴더가 없으면(구버전 프로젝트/삭제됨) 스캐폴드로 생성한다.
    this._dirReady = !OmniNative.available ? Promise.resolve(null) : (async () => {
      if (p.dir) {
        try {
          const r = await OmniNative.request("ce.addRoot",
            JSON.stringify({ path: p.dir }), 8000);
          if (r && r.ok) return p.dir;
        } catch (e) {}
      }
      try {
        const s = await OmniNative.request("proj.scaffold",
          JSON.stringify({ name: p.name }), 10000);
        if (s && s.ok) {
          p.dir = s.path;
          this.persist();
          return s.path;
        }
      } catch (e) {}
      return null;
    })();
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

  async mountPanel(key) {
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
    // 패널 키 → 모듈 등록명 (아두이노는 panel-ino / modules.ide)
    const MODKEY = { r3d: "r3d", ino: "ide", ce: "ce", notes: "notes" };
    const mod = OmniOS.modules[MODKEY[key] || key];
    if (mod && mod.resize) mod.resize();
    // 프로젝트 폴더 준비(루트 등록/스캐폴드)를 기다렸다가 도구를 연결한다 —
    // 등록 전에 보관 쓰기가 나가면 루트 검증에 막혀 조용히 실패한다
    const p = this._edProject;
    if (p && OmniNative.available) {
      const dir = this._dirReady ? await this._dirReady : p.dir;
      // 기다리는 사이 다른 도구로 바뀌었으면 중단
      if (!dir || this._edProject !== p
          || !panel.classList.contains("pj-embedded")) return;
      const SUB = { r3d: "3d", ino: "arduino", ce: "code", notes: "notes" };
      if (mod && SUB[key]) mod._projectSaveDir = `${dir}/${SUB[key]}`;
      if (key === "ce" && OmniOS.modules.ce.openPath) {
        OmniOS.modules.ce.openPath(`${dir}/code`);
      } else if (key === "notes" && OmniOS.modules.notes.openVault) {
        OmniOS.modules.notes.openVault(`${dir}/notes`);
      } else if (key === "r3d") {
        this.preloadR3d(p, dir);
      } else if (key === "ino") {
        this.preloadIno(p, dir);
      }
    }
  },

  // ── 도구 프리로드: 프로젝트 폴더에 보관된 내용물을 자동으로 열기 ──
  _preloaded: { r3d: new Set(), ino: new Set() }, // 세션당 프로젝트별 1회

  async preloadR3d(p, dir) {
    if (this._preloaded.r3d.has(p.id)) return;
    this._preloaded.r3d.add(p.id);
    try {
      const t = await OmniNative.request("ce.tree",
        JSON.stringify({ path: `${dir}/3d` }), 10000);
      const MODEL = /\.(stl|obj|mtl|gltf|glb|fbx|ply|3mf|dae|step|stp|iges|igs|brep|bin|png|jpe?g|tga|webp)$/i;
      const entries = ((t && t.entries) || [])
        .filter((e) => !e.dir && MODEL.test(e.name));
      if (!entries.length) return;
      const files = [];
      for (const e of entries) {
        try {
          const res = await fetch(
            `omni://local/__media__?p=${encodeURIComponent(`${dir}/3d/${e.name}`)}`);
          if (!res.ok) continue;
          const blob = await res.blob();
          if (blob.size > 200 * 1024 * 1024) continue;
          files.push(new File([blob], e.name));
        } catch (err) {}
      }
      if (files.length) await OmniOS.modules.r3d.loadFiles(files);
    } catch (e) {}
  },

  async preloadIno(p, dir) {
    if (this._preloaded.ino.has(p.id)) return;
    const ide = OmniOS.modules.ide;
    // 다른 스케치를 편집 중이면(미저장 변경) 덮지 않는다
    if (ide._files && ide._files.some((f) => f.dirty)) return;
    try {
      const base = `${dir}/arduino`;
      const t = await OmniNative.request("ce.tree",
        JSON.stringify({ path: base }), 10000);
      const entries = (t && t.entries) || [];
      let sketchDir = null;
      if (entries.some((e) => !e.dir && /\.ino$/i.test(e.name))) {
        sketchDir = base; // arduino/ 직속에 .ino
      } else {
        // 표준 구조: arduino/<이름>/<이름>.ino — 한 단계 하위까지 탐색
        for (const e of entries.filter((x) => x.dir)) {
          const sub = await OmniNative.request("ce.tree",
            JSON.stringify({ path: `${base}/${e.name}` }), 10000);
          if (((sub && sub.entries) || []).some(
              (f) => !f.dir && /\.ino$/i.test(f.name))) {
            sketchDir = `${base}/${e.name}`;
            break;
          }
        }
      }
      if (!sketchDir) return;
      this._preloaded.ino.add(p.id);
      await ide.openCode(sketchDir);
    } catch (e) {}
  },

  unmountPanel() {
    const panel = document.querySelector(".pj-ed-host .panel.pj-embedded");
    if (!panel) return;
    const MODKEY = { r3d: "r3d", ino: "ide", ce: "ce", notes: "notes" };
    const pkey = panel.id.replace("panel-", "");
    const mod = OmniOS.modules[MODKEY[pkey] || pkey];
    if (mod) mod._projectSaveDir = null;
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
    // 프로젝트 에디터에 이식된 상태면 불러온 모델을 프로젝트 3d/에 보관
    if (this._projectSaveDir) {
      for (const f of files) {
        f.arrayBuffer().then((buf) =>
          OmniOS.projectKeep(this._projectSaveDir, f.name, buf));
      }
    }
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

// ---------- module: VOICE CHANGER (profile learning + timbre transfer) ----------
OmniOS.register("voice", {
  els: null,
  SR: 16000,          // 분석·변환 표본화 주파수 (음성 대역에 충분)
  _profiles: [],      // {id, name, pitch, centroid, duration, ltas:[...]}
  _active: -1,
  _ref: null,         // Float32Array (학습용 샘플)
  _tgt: null,         // Float32Array (변환 대상)
  _out: null,         // Float32Array (변환 결과)
  _rec: null,         // {stream, recorder, chunks, kind, t0, timer}
  _loaded: false,

  init() {
    const $ = (id) => document.getElementById(id);
    this.els = {
      msg: $("vc-msg"), profiles: $("vc-profiles"), profCount: $("vc-prof-count"),
      spec: $("vc-spec"), dPitch: $("vc-d-pitch"), dBright: $("vc-d-bright"),
      dDur: $("vc-d-dur"),
      recRef: $("vc-rec-ref"), fileRef: $("vc-file-ref"), refInput: $("vc-ref-input"),
      refStat: $("vc-ref-stat"), refWave: $("vc-ref-wave"), playRef: $("vc-play-ref"),
      profName: $("vc-prof-name"), learn: $("vc-learn"),
      recTgt: $("vc-rec-tgt"), fileTgt: $("vc-file-tgt"), tgtInput: $("vc-tgt-input"),
      tgtStat: $("vc-tgt-stat"), tgtWave: $("vc-tgt-wave"), playTgt: $("vc-play-tgt"),
      engine: $("vc-engine"), install: $("vc-install"), engStat: $("vc-eng-stat"),
      dspOpts: $("vc-dsp-opts"),
      strength: $("vc-strength"), strengthV: $("vc-strength-v"), opts: $("vc-opts"),
      convert: $("vc-convert"), outWave: $("vc-out-wave"),
      playOut: $("vc-play-out"), save: $("vc-save"), outStat: $("vc-out-stat"),
      rSrc: $("vc-r-src"), rDst: $("vc-r-dst"), rShift: $("vc-r-shift"), rMode: $("vc-r-mode"),
      live: $("vc-live"), liveStat: $("vc-live-stat"), liveMode: $("vc-live-mode"),
      lPitch: $("vc-l-pitch"), lShift: $("vc-l-shift"), lPath: $("vc-l-path"),
    };
    this.els.live.addEventListener("click", () =>
      this._liveSession ? this.stopLive() : this.goLive());
    this.els.liveMode.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        if (b.disabled || this._liveSession) return;
        this.els.liveMode.querySelectorAll("button").forEach((x) =>
          x.classList.toggle("active", x === b));
        this._liveMode = b.dataset.m;
      }));
    const E = this.els;
    E.recRef.addEventListener("click", () => this.toggleRec("ref"));
    E.recTgt.addEventListener("click", () => this.toggleRec("tgt"));
    E.fileRef.addEventListener("click", () => E.refInput.click());
    E.fileTgt.addEventListener("click", () => E.tgtInput.click());
    E.refInput.addEventListener("change", () => this.loadFile("ref", E.refInput));
    E.tgtInput.addEventListener("change", () => this.loadFile("tgt", E.tgtInput));
    E.learn.addEventListener("click", () => this.learnProfile());
    E.convert.addEventListener("click", () => this.convert());
    E.stopRef = document.getElementById("vc-stop-ref");
    E.stopTgt = document.getElementById("vc-stop-tgt");
    E.stopOut = document.getElementById("vc-stop-out");
    E.playRef.addEventListener("click", () => this.playSlot("ref"));
    E.playTgt.addEventListener("click", () => this.playSlot("tgt"));
    E.playOut.addEventListener("click", () => this.playSlot("out"));
    E.stopRef.addEventListener("click", () => this.stopSlot("ref"));
    E.stopTgt.addEventListener("click", () => this.stopSlot("tgt"));
    E.stopOut.addEventListener("click", () => this.stopSlot("out"));
    // 파형 클릭/드래그로 재생 위치 탐색
    for (const slot of ["ref", "tgt", "out"]) {
      const cv = this.waveCanvas(slot);
      const seekAt = (e) => {
        const r = cv.getBoundingClientRect();
        this.seekSlot(slot, Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
      };
      cv.addEventListener("mousedown", (e) => {
        if (!this.audioFor(slot)) return;
        seekAt(e);
        const move = (ev) => seekAt(ev);
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      });
    }
    E.save.addEventListener("click", () => this.saveWav());
    E.strength.addEventListener("input", () => {
      E.strengthV.textContent = `${E.strength.value}%`;
    });
    E.opts.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        b.classList.toggle("active");
        this.syncMode();
      }));
    E.engine.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        if (b.disabled) return;
        E.engine.querySelectorAll("button").forEach((x) =>
          x.classList.toggle("active", x === b));
        this._engine = b.dataset.e;
        E.dspOpts.hidden = this._engine === "neural";
        this.syncMode();
      }));
    E.install.addEventListener("click", () => this.installEngine());
    // 엔진 설치 스트림 수신
    window.OmniVC = {
      _live: (b64) => this.onLiveChunk(b64),
      _liveState: (s) => this.onLiveState(s),
      _log: (b64) => {
        const text = atob(b64).trim().split("\n").pop();
        if (text) this.els.engStat.textContent = text.slice(0, 60).toUpperCase();
      },
      _done: (code) => {
        this.els.engStat.textContent = code === 0 ? "" : `SETUP FAILED (${code})`;
        this.flash(code === 0 ? "NEURAL ENGINE READY" : "ENGINE SETUP FAILED",
          code === 0 ? "ok" : "alert");
        this.checkEngine();
      },
    };
    document.addEventListener("omni:panel", (e) => {
      if (e.detail === "voice") {
        this.load();
        this.checkEngine();
      } else {
        this.stopRec(true);
        this.stopLive();
      }
    });
  },

  _engine: "dsp",
  _liveMode: "neural",
  _liveSession: null,

  async checkEngine() {
    if (!OmniNative.available) return;
    try {
      const r = await OmniNative.request("voice.status", null, 8000);
      const ready = !!(r && r.installed && r.models);
      const btn = this.els.engine.querySelector('[data-e="neural"]');
      btn.disabled = !ready;
      const liveNN = this.els.liveMode.querySelector('[data-m="neural"]');
      liveNN.disabled = !ready;
      try {
        const u = await OmniNative.request("voice.ultraStatus", null, 8000);
        const ub = this.els.engine.querySelector('[data-e="ultra"]');
        ub.disabled = !(u && u.installed);
        if (u && u.installed && !this._engineChecked) {
          // 최상위 품질 엔진이 있으면 기본으로
          setTimeout(() => ub.click(), 0);
        }
      } catch (e) {}
      if (!ready && this._liveMode === "neural") {
        this._liveMode = "dsp";
        this.els.liveMode.querySelectorAll("button").forEach((x) =>
          x.classList.toggle("active", x.dataset.m === "dsp"));
      }
      this.els.install.hidden = ready;
      if (ready && this._engine === "dsp" && !this._engineChecked) {
        // 준비돼 있으면 신경망을 기본으로
        btn.click();
      }
      this._engineChecked = true;
    } catch (e) {}
  },

  async installEngine() {
    this.els.install.disabled = true;
    this.flash("INSTALLING NEURAL ENGINE\u2026 (2GB+)");
    try {
      await OmniNative.request("voice.setup", null, 10000);
    } catch (e) {
      this.flash("SETUP LAUNCH FAILED", "alert");
      this.els.install.disabled = false;
    }
  },

  flash(text, tone) {
    const el = this.els.msg;
    el.textContent = text;
    el.className = `ts-item${tone ? " " + tone : ""}`;
    clearTimeout(this._msgT);
    if (tone === "ok") this._msgT = setTimeout(() => { el.textContent = ""; }, 3000);
  },

  async load() {
    if (this._loaded) return;
    this._loaded = true;
    try {
      if (OmniNative.available) {
        const r = await OmniNative.request("store.read",
          JSON.stringify({ name: "voiceprofiles" }), 8000);
        this._profiles = r && r.data ? JSON.parse(r.data) : [];
      } else {
        this._profiles = JSON.parse(localStorage.getItem("omni.voice") || "[]");
      }
    } catch (e) {
      this._profiles = [];
    }
    this.renderProfiles();
  },

  async persist() {
    const data = JSON.stringify(this._profiles);
    try {
      if (OmniNative.available) {
        await OmniNative.request("store.write",
          JSON.stringify({ name: "voiceprofiles", data }), 10000);
      } else {
        localStorage.setItem("omni.voice", data);
      }
    } catch (e) {}
  },

  // ── 오디오 입력: 마이크 녹음 / 파일 ──
  audioCtx() {
    if (!this._ac) this._ac = new (window.AudioContext || window.webkitAudioContext)();
    return this._ac;
  },

  async toggleRec(kind) {
    if (this._rec) {
      this.stopRec();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        await this.ingest(kind, await blob.arrayBuffer(), "RECORDING");
      };
      recorder.start();
      const btn = kind === "ref" ? this.els.recRef : this.els.recTgt;
      const stat = kind === "ref" ? this.els.refStat : this.els.tgtStat;
      btn.textContent = "\u25A0 STOP";
      btn.classList.add("active");
      const t0 = Date.now();
      const timer = setInterval(() => {
        const s = (Date.now() - t0) / 1000;
        stat.textContent = `RECORDING ${s.toFixed(1)}S`;
        stat.className = "vc-stat rec";
      }, 100);
      this._rec = { stream, recorder, chunks, kind, t0, timer, btn };
    } catch (e) {
      this.flash("MIC ACCESS DENIED", "alert");
    }
  },

  stopRec(silent) {
    const rec = this._rec;
    if (!rec) return;
    this._rec = null;
    clearInterval(rec.timer);
    rec.btn.textContent = "\u25CF RECORD";
    rec.btn.classList.remove("active");
    try {
      if (silent) {
        rec.recorder.onstop = null;
        rec.stream.getTracks().forEach((t) => t.stop());
      }
      if (rec.recorder.state !== "inactive") rec.recorder.stop();
    } catch (e) {}
  },

  async loadFile(kind, input) {
    const f = input.files && input.files[0];
    input.value = "";
    if (!f) return;
    await this.ingest(kind, await f.arrayBuffer(), f.name.toUpperCase());
  },

  // 디코드 → 모노 → SR 리샘플
  async ingest(kind, arrayBuffer, label) {
    this.flash("DECODING\u2026");
    let buf;
    try {
      buf = await this.audioCtx().decodeAudioData(arrayBuffer.slice(0));
    } catch (e) {
      this.flash("UNSUPPORTED AUDIO FORMAT", "alert");
      return;
    }
    const D = window.OmniVoiceDSP;
    const ch0 = buf.getChannelData(0);
    let mono = new Float32Array(ch0.length);
    if (buf.numberOfChannels > 1) {
      const ch1 = buf.getChannelData(1);
      for (let i = 0; i < mono.length; i++) mono[i] = (ch0[i] + ch1[i]) / 2;
    } else {
      mono.set(ch0);
    }
    const audio = buf.sampleRate === this.SR
      ? mono
      : D.resample(mono, this.SR / buf.sampleRate);
    const secs = audio.length / this.SR;
    if (kind === "ref") {
      this._ref = audio;
      this.els.refStat.textContent = `${label} \u00b7 ${secs.toFixed(1)}S`;
      this.els.refStat.className = `vc-stat${secs >= 20 ? " ok" : ""}`;
      this.stopSlot("ref", true);
      this._players.ref.offset = 0;
      this.drawWave(this.els.refWave, audio);
      this.els.learn.disabled = false;
      this.els.playRef.disabled = false;
      this.els.stopRef.disabled = false;
      if (secs < 20) this.flash("SHORT SAMPLE \u2014 60S GIVES A BETTER PROFILE");
      else this.flash("SAMPLE READY", "ok");
    } else {
      this._tgt = audio;
      this.els.tgtStat.textContent = `${label} \u00b7 ${secs.toFixed(1)}S`;
      this.els.tgtStat.className = "vc-stat ok";
      this.stopSlot("tgt", true);
      this._players.tgt.offset = 0;
      this.drawWave(this.els.tgtWave, audio);
      this.els.playTgt.disabled = false;
      this.els.stopTgt.disabled = false;
      this.syncConvert();
      this.flash("TARGET READY", "ok");
    }
  },

  // ── 프로파일 학습 ──
  learnProfile() {
    if (!this._ref) return;
    if (this._engine === "ultra") {
      this.learnUltra();
      return;
    }
    if (this._engine === "neural") {
      this.learnNeural();
      return;
    }
    const D = window.OmniVoiceDSP;
    this.flash("LEARNING\u2026");
    const p = D.analyzeProfile(this._ref, this.SR);
    if (!p.pitch) {
      this.flash("NO VOICED SPEECH DETECTED IN SAMPLE", "alert");
      return;
    }
    const name = (this.els.profName.value.trim()
      || `VOICE ${this._profiles.length + 1}`).toUpperCase();
    this._profiles.unshift({
      id: `v${Date.now().toString(36)}`,
      name,
      pitch: p.pitch,
      centroid: p.centroid,
      duration: p.duration,
      ltas: Array.from(p.ltas),
    });
    this.els.profName.value = "";
    this.persist();
    this.renderProfiles();
    this.selectProfile(0);
    this.flash(`LEARNED ${name} \u00b7 ${p.pitch.toFixed(0)}HZ`, "ok");
  },

  // ── 신경망 경로 (kNN-VC 워커) ──
  async voiceDir() {
    const r = await OmniNative.request("voice.dir", null, 8000);
    if (!r || !r.ok) throw new Error("no voice dir");
    return r.path;
  },

  async writeWav(dir, name, audio) {
    const ok = await OmniOS.projectKeep(dir, name,
      await this.wavBlob(audio).arrayBuffer());
    if (!ok) throw new Error("wav write failed");
    return `${dir}/${name}`;
  },

  async readWav(path) {
    const res = await fetch(
      `omni://local/__media__?p=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error("wav read failed");
    const buf = await this.audioCtx().decodeAudioData(await res.arrayBuffer());
    const out = new Float32Array(buf.length);
    out.set(buf.getChannelData(0));
    return buf.sampleRate === this.SR
      ? out
      : window.OmniVoiceDSP.resample(out, this.SR / buf.sampleRate);
  },

  // ── ULTRA 엔진 (Seed-VC): zero-shot — 학습 = 레퍼런스 보관 (1~30초 사용) ──
  async learnUltra() {
    const D = window.OmniVoiceDSP;
    this.els.learn.disabled = true;
    this.flash("SAVING REFERENCE\u2026");
    try {
      const dir = await this.voiceDir();
      const id = `v${Date.now().toString(36)}`;
      // Seed-VC 권장 1~30초 — 길면 에너지 최대 30초 창을 고른다
      let refAudio = this._ref;
      const maxN = this.SR * 30;
      if (refAudio.length > maxN) {
        let best = 0, bestE = -1;
        const hop = this.SR * 2;
        for (let s = 0; s + maxN <= refAudio.length; s += hop) {
          let e = 0;
          for (let i = s; i < s + maxN; i += 16) e += refAudio[i] * refAudio[i];
          if (e > bestE) { bestE = e; best = s; }
        }
        refAudio = refAudio.slice(best, best + maxN);
      }
      await OmniNative.request("ce.mkdir",
        JSON.stringify({ path: `${dir}/profiles` }), 8000).catch(() => {});
      const wavPath = await this.writeWav(`${dir}/profiles`, `${id}_ref.wav`, refAudio);
      const p = D.analyzeProfile(this._ref, this.SR);
      const name = (this.els.profName.value.trim()
        || `VOICE ${this._profiles.length + 1}`).toUpperCase();
      this._profiles.unshift({
        id, name,
        pitch: p.pitch || 0,
        centroid: p.centroid,
        duration: p.duration,
        ltas: Array.from(p.ltas),
        ultra: wavPath,
      });
      this.els.profName.value = "";
      this.persist();
      this.renderProfiles();
      this.selectProfile(0);
      this.flash(`LEARNED ${name} (ULTRA)`, "ok");
    } catch (e) {
      this.flash(`ULTRA LEARN FAILED \u2014 ${String(e.message || e).slice(0, 60)}`, "alert");
    }
    this.els.learn.disabled = false;
  },

  async convertUltra(p) {
    this.els.convert.disabled = true;
    this.flash("ULTRA CONVERTING\u2026 (DIFFUSION)");
    try {
      const dir = await this.voiceDir();
      const stamp = Date.now().toString(36);
      const inPath = await this.writeWav(`${dir}/tmp`, `${stamp}_in.wav`, this._tgt);
      const t0 = performance.now();
      const r = await OmniNative.request("voice.ultra", JSON.stringify({
        source: inPath, ref: p.ultra, outDir: `${dir}/tmp/${stamp}_out`,
        steps: 50, f0: true, cfg: 0.3, // F0 조건 + 50스텝 + CFG 0.3: 피치 워블 억제
      }), 900000);
      if (!r || !r.ok) throw new Error(r && r.error || "ultra failed");
      const ms = Math.round(performance.now() - t0);
      this.stopSlot("out", true);
      this._players.out.offset = 0;
      this._out = await this.readWav(r.path);
      this.drawWave(this.els.outWave, this._out);
      this.els.playOut.disabled = false;
      this.els.stopOut.disabled = false;
      const D = window.OmniVoiceDSP;
      const sp = D.estimatePitch(this._tgt, this.SR);
      const op = D.estimatePitch(this._out, this.SR);
      this.els.rSrc.textContent = sp ? `${sp.toFixed(1)} HZ` : "\u2014";
      this.els.rDst.textContent = op ? `${op.toFixed(1)} HZ` : "\u2014";
      this.els.rShift.textContent = "DIFFUSION";
      this.els.outStat.textContent =
        `${(this._out.length / this.SR).toFixed(1)}S \u00b7 ${(ms / 1000).toFixed(1)}S`;
      this.flash(`CONVERTED WITH ${p.name} (ULTRA)`, "ok");
    } catch (e) {
      this.flash(`ULTRA CONVERT FAILED \u2014 ${String(e.message || e).slice(0, 60)}`, "alert");
    }
    this.els.convert.disabled = false;
    this.syncConvert();
  },

  async learnNeural() {
    const D = window.OmniVoiceDSP;
    this.els.learn.disabled = true;
    this.flash("NEURAL LEARNING\u2026 (WAVLM FEATURES)");
    try {
      const dir = await this.voiceDir();
      const id = `v${Date.now().toString(36)}`;
      const wavPath = await this.writeWav(`${dir}/tmp`, `${id}_ref.wav`, this._ref);
      const pt = `${dir}/profiles/${id}.pt`;
      await OmniNative.request("ce.mkdir",
        JSON.stringify({ path: `${dir}/profiles` }), 8000).catch(() => {});
      const r = await OmniNative.request("voice.exec",
        JSON.stringify({ args: ["learn", wavPath, pt] }), 600000);
      if (!r || !r.ok) throw new Error(r && r.error || "learn failed");
      const p = D.analyzeProfile(this._ref, this.SR); // 표시용 지표는 DSP로
      const name = (this.els.profName.value.trim()
        || `VOICE ${this._profiles.length + 1}`).toUpperCase();
      this._profiles.unshift({
        id, name,
        pitch: p.pitch || 0,
        centroid: p.centroid,
        duration: p.duration,
        ltas: Array.from(p.ltas),
        neural: pt,
        frames: r.frames,
      });
      this.els.profName.value = "";
      this.persist();
      this.renderProfiles();
      this.selectProfile(0);
      this.flash(`LEARNED ${name} \u00b7 ${r.frames} FRAMES (${r.device.toUpperCase()})`, "ok");
    } catch (e) {
      this.flash(`NEURAL LEARN FAILED \u2014 ${String(e.message || e).slice(0, 60)}`, "alert");
    }
    this.els.learn.disabled = false;
  },

  async convertNeural(p) {
    this.els.convert.disabled = true;
    this.flash("NEURAL CONVERTING\u2026");
    try {
      const dir = await this.voiceDir();
      const stamp = Date.now().toString(36);
      const inPath = await this.writeWav(`${dir}/tmp`, `${stamp}_in.wav`, this._tgt);
      const outPath = `${dir}/tmp/${stamp}_out.wav`;
      const t0 = performance.now();
      const r = await OmniNative.request("voice.exec",
        JSON.stringify({ args: ["convert", p.neural, inPath, outPath] }), 600000);
      if (!r || !r.ok) throw new Error(r && r.error || "convert failed");
      const ms = Math.round(performance.now() - t0);
      this.stopSlot("out", true);
      this._players.out.offset = 0;
      this._out = await this.readWav(outPath);
      this.drawWave(this.els.outWave, this._out);
      this.els.playOut.disabled = false;
      this.els.stopOut.disabled = false;
      this.els.save.disabled = false;
      const D = window.OmniVoiceDSP;
      const sp = D.estimatePitch(this._tgt, this.SR);
      const op = D.estimatePitch(this._out, this.SR);
      this.els.rSrc.textContent = sp ? `${sp.toFixed(1)} HZ` : "\u2014";
      this.els.rDst.textContent = op ? `${op.toFixed(1)} HZ` : "\u2014";
      this.els.rShift.textContent = "NEURAL";
      this.els.outStat.textContent =
        `${(this._out.length / this.SR).toFixed(1)}S \u00b7 ${(ms / 1000).toFixed(1)}S \u00b7 ${(r.device || "").toUpperCase()}`;
      this.flash(`CONVERTED WITH ${p.name} (NEURAL)`, "ok");
    } catch (e) {
      this.flash(`NEURAL CONVERT FAILED \u2014 ${String(e.message || e).slice(0, 60)}`, "alert");
    }
    this.els.convert.disabled = false;
    this.syncConvert();
  },

  renderProfiles() {
    const box = this.els.profiles;
    box.textContent = "";
    this.els.profCount.textContent = this._profiles.length
      ? `${this._profiles.length}` : "";
    if (!this._profiles.length) {
      const e = document.createElement("div");
      e.className = "vc-empty";
      e.textContent = "NO PROFILES — LEARN ONE FROM A VOICE SAMPLE";
      box.appendChild(e);
      this.syncConvert();
      return;
    }
    this._profiles.forEach((p, i) => {
      const it = document.createElement("div");
      it.className = `vc-item${i === this._active ? " active" : ""}`;
      const nm = document.createElement("span");
      nm.textContent = p.name;
      const hz = document.createElement("span");
      hz.className = "vc-hz";
      hz.textContent = `${p.ultra ? "ULTRA \u00b7 " : p.neural ? "NN \u00b7 " : ""}${p.pitch.toFixed(0)} HZ`;
      const x = document.createElement("span");
      x.className = "vc-x";
      x.textContent = "\u2715";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        this._profiles.splice(i, 1);
        if (this._active === i) this._active = -1;
        else if (this._active > i) this._active--;
        this.persist();
        this.renderProfiles();
      });
      it.append(nm, hz, x);
      it.addEventListener("click", () => this.selectProfile(i));
      box.appendChild(it);
    });
    this.syncConvert();
  },

  selectProfile(i) {
    this._active = i;
    const p = this._profiles[i];
    this.renderProfiles();
    if (!p) return;
    this.els.live.disabled = false;
    if (!this._liveSession) this.els.liveStat.textContent = "READY";
    this.els.dPitch.textContent = `${p.pitch.toFixed(1)} HZ`;
    this.els.dBright.textContent = `${Math.round(p.centroid)} HZ`;
    this.els.dDur.textContent = `${p.duration.toFixed(1)} S`;
    this.drawSpectrum(this.els.spec, p.ltas);
  },

  syncMode() {
    if (this._engine === "ultra") {
      this.els.rMode.textContent = "SEED-VC DIFFUSION";
      return;
    }
    if (this._engine === "neural") {
      this.els.rMode.textContent = "KNN-VC (WAVLM)";
      return;
    }
    const on = (k) => !!this.els.opts.querySelector(`[data-o="${k}"].active`);
    this.els.rMode.textContent = on("pitch") && on("timbre") ? "PITCH + TIMBRE"
      : on("pitch") ? "PITCH ONLY" : on("timbre") ? "TIMBRE ONLY" : "PASSTHROUGH";
  },

  syncConvert() {
    this.els.convert.disabled = !(this._tgt && this._profiles.length);
  },

  // ── 변환 ──
  convert() {
    const D = window.OmniVoiceDSP;
    const idx = this._active >= 0 ? this._active : 0;
    const p = this._profiles[idx];
    if (!p || !this._tgt) return;
    if (this._active < 0) this.selectProfile(0);
    if (this._engine === "ultra") {
      if (!p.ultra) {
        this.flash("RELEARN THIS PROFILE WITH ULTRA ENGINE", "alert");
        return;
      }
      this.convertUltra(p);
      return;
    }
    if (this._engine === "neural") {
      if (!p.neural) {
        this.flash("THIS PROFILE IS DSP-ONLY \u2014 RELEARN WITH NEURAL ENGINE", "alert");
        return;
      }
      this.convertNeural(p);
      return;
    }
    this.flash("CONVERTING\u2026");
    // 무거운 DSP — 상태 메시지가 먼저 그려지도록 다음 프레임에 실행
    setTimeout(() => {
      const t0 = performance.now();
      const on = (k) => !!this.els.opts.querySelector(`[data-o="${k}"].active`);
      const res = D.applyProfile(this._tgt, this.SR, {
        pitch: p.pitch,
        ltas: Float32Array.from(p.ltas),
        centroid: p.centroid,
      }, {
        pitch: on("pitch"),
        timbre: on("timbre"),
        strength: parseInt(this.els.strength.value, 10) / 100,
      });
      const ms = Math.round(performance.now() - t0);
      this.stopSlot("out", true);
      this._players.out.offset = 0;
      this._out = res.audio;
      this.drawWave(this.els.outWave, res.audio);
      this.els.playOut.disabled = false;
      this.els.stopOut.disabled = false;
      this.els.save.disabled = false;
      this.els.rSrc.textContent = res.tgtPitch ? `${res.tgtPitch.toFixed(1)} HZ` : "\u2014";
      this.els.rDst.textContent = `${p.pitch.toFixed(1)} HZ`;
      const semis = res.pitchRatio > 0 ? 12 * Math.log2(res.pitchRatio) : 0;
      this.els.rShift.textContent = `${semis >= 0 ? "+" : ""}${semis.toFixed(1)} ST`;
      this.els.outStat.textContent = `${(this._out.length / this.SR).toFixed(1)}S \u00b7 ${ms}MS`;
      this.flash(`CONVERTED WITH ${p.name}`, "ok");
    }, 30);
  },

  // ── 슬롯 플레이어: 재생/정지(위치 기억)/타임라인 탐색 ──
  _players: {
    ref: { offset: 0, playing: false, src: null, startedAt: 0 },
    tgt: { offset: 0, playing: false, src: null, startedAt: 0 },
    out: { offset: 0, playing: false, src: null, startedAt: 0 },
  },

  audioFor(slot) {
    return slot === "ref" ? this._ref : slot === "tgt" ? this._tgt : this._out;
  },

  waveCanvas(slot) {
    return slot === "ref" ? this.els.refWave
      : slot === "tgt" ? this.els.tgtWave : this.els.outWave;
  },

  stopButton(slot) {
    return slot === "ref" ? this.els.stopRef
      : slot === "tgt" ? this.els.stopTgt : this.els.stopOut;
  },

  playSlot(slot) {
    const audio = this.audioFor(slot);
    if (!audio) return;
    // 한 번에 하나만 재생
    for (const other of ["ref", "tgt", "out"]) {
      if (other !== slot) this.stopSlot(other, true);
    }
    const P = this._players[slot];
    if (P.playing) this.stopSlot(slot, true); // 재클릭 = 현재 위치에서 재시작
    const ac = this.audioCtx();
    ac.resume();
    const dur = audio.length / this.SR;
    if (P.offset >= dur - 0.05) P.offset = 0;
    const buf = ac.createBuffer(1, audio.length, this.SR);
    buf.getChannelData(0).set(audio);
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(ac.destination);
    src.start(0, P.offset);
    P.src = src;
    P.playing = true;
    P.startedAt = ac.currentTime - P.offset;
    this.stopButton(slot).disabled = false;
    src.onended = () => {
      if (P.src !== src) return; // 다른 재생으로 대체됨
      P.playing = false;
      P.src = null;
      P.offset = 0;
      this.paintWave(slot);
    };
    this.tickPlayhead();
  },

  stopSlot(slot, keepUi) {
    const P = this._players[slot];
    if (P.src) {
      const src = P.src;
      P.src = null; // onended 가드
      if (P.playing) {
        P.offset = Math.min(
          this.audioCtx().currentTime - P.startedAt,
          this.audioFor(slot) ? this.audioFor(slot).length / this.SR : 0);
      }
      try { src.stop(); } catch (e) {}
    }
    P.playing = false;
    if (!keepUi) this.paintWave(slot);
  },

  seekSlot(slot, frac) {
    const audio = this.audioFor(slot);
    if (!audio) return;
    const P = this._players[slot];
    P.offset = frac * (audio.length / this.SR);
    if (P.playing) this.playSlot(slot); // 새 위치에서 재시작
    else this.paintWave(slot);
  },

  // 재생 중 플레이헤드 애니메이션 (하나의 rAF 루프)
  tickPlayhead() {
    if (this._phRaf) return;
    const loop = () => {
      let any = false;
      for (const slot of ["ref", "tgt", "out"]) {
        if (this._players[slot].playing) {
          any = true;
          this.paintWave(slot);
        }
      }
      if (any) this._phRaf = requestAnimationFrame(loop);
      else this._phRaf = null;
    };
    this._phRaf = requestAnimationFrame(loop);
  },

  // 캐시된 파형 위에 플레이헤드만 얹어 그리기
  paintWave(slot) {
    const audio = this.audioFor(slot);
    const cv = this.waveCanvas(slot);
    if (!audio) return;
    this.drawWave(cv, audio);
    const P = this._players[slot];
    const dur = audio.length / this.SR;
    const pos = P.playing
      ? Math.min(dur, this.audioCtx().currentTime - P.startedAt)
      : P.offset;
    if (pos <= 0 && !P.playing) return;
    const ctx = cv.getContext("2d");
    const W = cv.clientWidth || cv.width;
    const H = cv.clientHeight || cv.height;
    const x = (pos / dur) * W;
    ctx.strokeStyle = "#ffc857";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
    ctx.fillStyle = "#ffc857";
    ctx.beginPath();
    ctx.moveTo(x - 4, 0);
    ctx.lineTo(x + 4, 0);
    ctx.lineTo(x, 6);
    ctx.closePath();
    ctx.fill();
  },

  // 16-bit PCM WAV 인코딩
  wavBlob(audio) {
    const n = audio.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const dv = new DataView(buf);
    const str = (o, s) => {
      for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
    };
    str(0, "RIFF");
    dv.setUint32(4, 36 + n * 2, true);
    str(8, "WAVEfmt ");
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true);
    dv.setUint32(24, this.SR, true);
    dv.setUint32(28, this.SR * 2, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    str(36, "data");
    dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, audio[i]));
      dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  },

  async saveWav() {
    if (!this._out) return;
    const p = this._profiles[this._active >= 0 ? this._active : 0];
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const name = `voice_${(p ? p.name : "out").toLowerCase().replace(/\s+/g, "-")}_${stamp}.wav`;
    const blob = this.wavBlob(this._out);
    if (!OmniNative.available) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
      return;
    }
    try {
      const dirRes = await OmniNative.request("voice.dir", null, 8000);
      if (!dirRes || !dirRes.ok) throw new Error("no dir");
      // 프로젝트 에디터에 이식된 상태면 프로젝트 폴더에도 함께 보관
      const dir = this._projectSaveDir || dirRes.path;
      const ok = await OmniOS.projectKeep(dir, name, await blob.arrayBuffer());
      this.flash(ok ? `SAVED ${name}` : "SAVE FAILED", ok ? "ok" : "alert");
    } catch (e) {
      this.flash("SAVE FAILED", "alert");
    }
  },

  // ── LIVE CHANGE: 마이크 실시간 변조 ──
  async goLive() {
    const p = this._profiles[this._active >= 0 ? this._active : 0];
    if (!p) {
      this.flash("SELECT A PROFILE FIRST", "alert");
      return;
    }
    if (this._active < 0) this.selectProfile(0);
    if (this._liveMode === "neural" && !p.neural) {
      this.flash("PROFILE IS DSP-ONLY \u2014 RELEARN WITH NEURAL ENGINE", "alert");
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      this.flash("MIC ACCESS DENIED", "alert");
      return;
    }
    const ac = this.audioCtx();
    await ac.resume();
    const session = {
      mode: this._liveMode, profile: p, stream, nodes: [], timers: [],
      nextT: 0, pitchHist: [],
    };
    this._liveSession = session;
    this.els.live.textContent = "\u25A0 STOP LIVE";
    this.els.live.classList.add("live-on");
    this.els.lPath.textContent = session.mode === "neural"
      ? "KNN-VC STREAM (0.5S CHUNKS)" : "GRANULAR + EQ BANK";
    try {
      if (session.mode === "neural") await this.liveNeural(session, ac);
      else await this.liveDsp(session, ac);
      this.els.liveStat.textContent = "LIVE";
      this.els.liveStat.className = "vc-stat rec";
    } catch (e) {
      this.flash(`LIVE START FAILED \u2014 ${String(e.message || e).slice(0, 50)}`, "alert");
      this.stopLive();
    }
  },

  // 신경망 라이브: 0.5초 16k 청크를 데몬으로 보내고 결과를 이어 재생
  async liveNeural(s, ac) {
    this.els.liveStat.textContent = "LOADING MODEL\u2026";
    const ready = new Promise((res, rej) => {
      s.readyRes = res;
      s.readyRej = rej;
      s.readyT = setTimeout(() => rej(new Error("engine timeout")), 90000);
    });
    const r = await OmniNative.request("voice.liveStart",
      JSON.stringify({ profile: s.profile.neural }), 10000);
    if (!r || !r.ok) throw new Error("daemon launch failed");
    await ready;
    const D = window.OmniVoiceDSP;
    const src = ac.createMediaStreamSource(s.stream);
    const tap = ac.createScriptProcessor(4096, 1, 1);
    const mute = ac.createGain();
    mute.gain.value = 0;
    src.connect(tap);
    tap.connect(mute);
    mute.connect(ac.destination);
    s.nodes.push(src, tap, mute);
    const need = Math.round(ac.sampleRate / 2); // 0.5초 @ ctx rate
    let acc = new Float32Array(0);
    tap.onaudioprocess = (e) => {
      const inp = e.inputBuffer.getChannelData(0);
      const merged = new Float32Array(acc.length + inp.length);
      merged.set(acc);
      merged.set(inp, acc.length);
      acc = merged;
      while (acc.length >= need) {
        const block = acc.subarray(0, need);
        acc = acc.slice(need);
        const ds = D.resample(block, this.SR / ac.sampleRate);
        // 피치 리드아웃
        const f0 = D.estimatePitch(ds, this.SR);
        if (f0 > 0) this.els.lPitch.textContent = `${f0.toFixed(0)} HZ`;
        this.els.lShift.textContent = "NEURAL";
        const bytes = new Uint8Array(ds.buffer, ds.byteOffset, ds.byteLength);
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null,
            bytes.subarray(i, i + 0x8000));
        }
        OmniNative.request("voice.liveFeed",
          JSON.stringify({ data: btoa(bin) })).catch(() => {});
      }
    };
  },

  onLiveState(state) {
    const s = this._liveSession;
    if (!s) return;
    if (state === "READY" && s.readyRes) {
      clearTimeout(s.readyT);
      s.readyRes();
    } else if (state.startsWith("ERR")) {
      this.flash(`LIVE ${state.slice(0, 60)}`, "alert");
    } else if (state === "EXITED" && s.mode === "neural") {
      this.stopLive();
    }
  },

  onLiveChunk(b64) {
    const s = this._liveSession;
    if (!s || s.mode !== "neural") return;
    const D = window.OmniVoiceDSP;
    const ac = this.audioCtx();
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const pcm = new Float32Array(bytes.buffer);
    const up = D.resample(pcm, ac.sampleRate / this.SR);
    // 경계 클릭 방지 3ms 페이드
    const fade = Math.round(ac.sampleRate * 0.003);
    for (let i = 0; i < fade && i < up.length; i++) {
      const g = i / fade;
      up[i] *= g;
      up[up.length - 1 - i] *= g;
    }
    const buf = ac.createBuffer(1, up.length, ac.sampleRate);
    buf.getChannelData(0).set(up);
    const node = ac.createBufferSource();
    node.buffer = buf;
    node.connect(ac.destination);
    const t = Math.max(ac.currentTime + 0.12, s.nextT || 0);
    node.start(t);
    s.nextT = t + buf.duration;
  },

  // DSP 라이브: 그래뉼러 피치 시프터(워클릿) + 프로파일 EQ 뱅크, 지연 ~50ms
  async liveDsp(s, ac) {
    const D = window.OmniVoiceDSP;
    const p = s.profile;
    const src = ac.createMediaStreamSource(s.stream);
    s.nodes.push(src);
    // 피치 시프터: AudioWorklet 우선, 실패 시 ScriptProcessor 폴백
    let shiftNode = null;
    let setRatio = null;
    try {
      if (!this._workletLoaded) {
        await ac.audioWorklet.addModule("vendor/dsp/pitch_worklet.js");
        this._workletLoaded = true;
      }
      shiftNode = new AudioWorkletNode(ac, "omni-grain-shifter",
        { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const param = shiftNode.parameters.get("ratio");
      setRatio = (r) => param.setTargetAtTime(r, ac.currentTime, 0.15);
    } catch (e) {
      const core = new window.OmniGrainCore(ac.sampleRate);
      let ratio = 1;
      shiftNode = ac.createScriptProcessor(1024, 1, 1);
      shiftNode.onaudioprocess = (ev) => core.process(
        ev.inputBuffer.getChannelData(0),
        ev.outputBuffer.getChannelData(0), ratio);
      setRatio = (r) => { ratio = r; };
    }
    s.setRatio = setRatio;
    // EQ 뱅크: 프로파일 포락선 vs 라이브 스펙트럼
    const bands = [120, 200, 330, 550, 900, 1500, 2500, 4000, 6000];
    const eq = bands.map((f) => {
      const b = ac.createBiquadFilter();
      b.type = "peaking";
      b.frequency.value = f;
      b.Q.value = 1.1;
      b.gain.value = 0;
      return b;
    });
    const analyser = ac.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.9;
    src.connect(analyser);
    src.connect(shiftNode);
    let prev = shiftNode;
    for (const b of eq) {
      prev.connect(b);
      prev = b;
    }
    const comp = ac.createDynamicsCompressor();
    prev.connect(comp);
    comp.connect(ac.destination);
    s.nodes.push(shiftNode, ...eq, analyser, comp);

    // 프로파일 포락선 밴드 기준값 (dB, 전체 평균 대비)
    const ltas = Float32Array.from(p.ltas);
    const sm = D.smoothLtas(ltas, 0.5);
    const binHz = this.SR / 2 / sm.length;
    const bandDb = (arrDb) => {
      const overall = arrDb.reduce((a, b) => a + b, 0) / arrDb.length;
      return arrDb.map((v) => v - overall);
    };
    const refDb = bandDb(bands.map((f) => {
      let sum = 0, cnt = 0;
      for (let k = Math.floor(f / 1.35 / binHz);
           k <= Math.min(sm.length - 1, Math.ceil(f * 1.35 / binHz)); k++) {
        sum += sm[k];
        cnt++;
      }
      return 20 * Math.log10(Math.max(1e-9, sum / Math.max(1, cnt)));
    }));

    // 실시간 피치 추적 → 자동 비율
    const td = new Float32Array(4096);
    s.timers.push(setInterval(() => {
      analyser.getFloatTimeDomainData(td);
      const f0 = D.estimatePitch(td, ac.sampleRate);
      if (f0 > 0 && p.pitch > 0) {
        s.pitchHist.push(f0);
        if (s.pitchHist.length > 8) s.pitchHist.shift();
        const med = [...s.pitchHist].sort((a, b) => a - b)[
          Math.floor(s.pitchHist.length / 2)];
        const ratio = Math.max(0.5, Math.min(2, p.pitch / med));
        setRatio(ratio);
        this.els.lPitch.textContent = `${med.toFixed(0)} HZ`;
        this.els.lShift.textContent =
          `${(12 * Math.log2(ratio)).toFixed(1)} ST`;
      }
    }, 300));
    // 라이브 스펙트럼 → EQ 갱신
    const fd = new Float32Array(analyser.frequencyBinCount);
    const acBin = ac.sampleRate / 2 / analyser.frequencyBinCount;
    s.timers.push(setInterval(() => {
      analyser.getFloatFrequencyData(fd);
      const liveDb = bandDb(bands.map((f) => {
        let sum = 0, cnt = 0;
        for (let k = Math.floor(f / 1.35 / acBin);
             k <= Math.min(fd.length - 1, Math.ceil(f * 1.35 / acBin)); k++) {
          if (Number.isFinite(fd[k])) {
            sum += fd[k];
            cnt++;
          }
        }
        return cnt ? sum / cnt : -80;
      }));
      eq.forEach((b, i) => {
        const g = Math.max(-12, Math.min(12, refDb[i] - liveDb[i]));
        b.gain.setTargetAtTime(g, ac.currentTime, 0.4);
      });
    }, 1500));
  },

  stopLive() {
    const s = this._liveSession;
    if (!s) return;
    this._liveSession = null;
    s.timers.forEach(clearInterval);
    clearTimeout(s.readyT);
    if (s.readyRej) s.readyRej = null;
    for (const n of s.nodes) {
      try {
        if (n.onaudioprocess !== undefined) n.onaudioprocess = null;
        n.disconnect();
      } catch (e) {}
    }
    try {
      s.stream.getTracks().forEach((t) => t.stop());
    } catch (e) {}
    if (s.mode === "neural") {
      OmniNative.request("voice.liveStop", null, 8000).catch(() => {});
    }
    this.els.live.textContent = "\u25CF GO LIVE";
    this.els.live.classList.remove("live-on");
    this.els.liveStat.textContent = "READY";
    this.els.liveStat.className = "vc-stat";
    this.els.lPitch.textContent = "\u2014";
    this.els.lShift.textContent = "\u2014";
  },

  // ── 시각화 ──
  fitCanvas(cv) {
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
    return { ctx, W, H };
  },

  drawWave(cv, audio) {
    const { ctx, W, H } = this.fitCanvas(cv);
    if (!audio || !audio.length) return;
    const mid = H / 2;
    const step = Math.max(1, Math.floor(audio.length / W));
    // 표시용 자동 스케일 — 조용한 녹음도 파형이 보이게 (오디오 자체는 그대로)
    let pk = 0;
    for (let i = 0; i < audio.length; i += Math.max(1, step >> 2)) {
      const a = Math.abs(audio[i]);
      if (a > pk) pk = a;
    }
    const vs = pk > 1e-4 ? 0.95 / pk : 1;
    ctx.strokeStyle = "rgba(53, 214, 255, 0.85)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < W; x++) {
      const s = x * step;
      let min = 1, max = -1;
      for (let i = 0; i < step && s + i < audio.length; i++) {
        const v = audio[s + i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      ctx.moveTo(x + 0.5, mid - Math.max(-1, Math.min(1, max * vs)) * mid * 0.92);
      ctx.lineTo(x + 0.5, mid - Math.max(-1, Math.min(1, min * vs)) * mid * 0.92);
    }
    ctx.stroke();
    ctx.strokeStyle = "rgba(53, 214, 255, 0.2)";
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(W, mid);
    ctx.stroke();
  },

  // 로그 주파수축 스펙트럼 포락선 (음색 지문)
  drawSpectrum(cv, ltas) {
    const { ctx, W, H } = this.fitCanvas(cv);
    if (!ltas || !ltas.length) return;
    const D = window.OmniVoiceDSP;
    const sm = D.smoothLtas(Float32Array.from(ltas), 0.4);
    let max = 0;
    for (const v of sm) if (v > max) max = v;
    if (max <= 0) return;
    const nyq = this.SR / 2;
    const fMin = 80;
    const toX = (f) => (Math.log2(Math.max(fMin, f) / fMin) / Math.log2(nyq / fMin)) * W;
    ctx.strokeStyle = "rgba(53, 214, 255, 0.15)";
    for (const f of [100, 500, 1000, 2000, 4000]) {
      const x = toX(f);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    ctx.strokeStyle = "#35d6ff";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    let started = false;
    for (let k = 1; k < sm.length; k++) {
      const f = (k * this.SR) / (sm.length * 2);
      const x = toX(f);
      const db = 20 * Math.log10(sm[k] / max + 1e-9);
      const y = H - Math.max(0, Math.min(1, (db + 60) / 60)) * (H - 4) - 2;
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  },

  resize() {
    if (this._ref) this.drawWave(this.els.refWave, this._ref);
    if (this._tgt) this.drawWave(this.els.tgtWave, this._tgt);
    if (this._out) this.drawWave(this.els.outWave, this._out);
    const p = this._profiles[this._active];
    if (p) this.drawSpectrum(this.els.spec, p.ltas);
  },
});

// ---------- module: NOTES (markdown vault) ----------
OmniOS.register("notes", {
  els: null,
  _cm: null,
  _vault: null,
  _cur: null,          // 열려 있는 노트 경로
  _index: [],          // [{name, path}] — 위키링크 해석용 전체 색인
  _mode: "edit",
  _saveT: null,
  _dirty: false,
  _booted: false,

  init() {
    const $ = (id) => document.getElementById(id);
    this.els = {
      panel: $("panel-notes"),
      vault: $("nt-vault"), msg: $("nt-msg"), mode: $("nt-mode"),
      open: $("nt-open"),
      newBtn: $("nt-new"), tree: $("nt-tree"), treeEmpty: $("nt-tree-empty"),
      title: $("nt-title"), editor: $("nt-editor"),
      preview: $("nt-preview"), empty: $("nt-empty"),
      toolbar: $("nt-toolbar"), imgInput: $("nt-img-input"),
    };
    this.els.toolbar.querySelectorAll("button[data-fmt]").forEach((b) =>
      b.addEventListener("click", () => this.fmt(b.dataset.fmt)));
    this.els.toolbar.querySelectorAll("button[data-color]").forEach((b) =>
      b.addEventListener("click", () => this.wrapSel(
        `<span style="color:${b.dataset.color}">`, "</span>")));
    this.els.toolbar.querySelectorAll("button[data-size]").forEach((b) =>
      b.addEventListener("click", () => this.wrapSel(
        `<span style="font-size:${b.dataset.size}px">`, "</span>")));
    this.els.imgInput.addEventListener("change", async () => {
      const files = [...this.els.imgInput.files];
      this.els.imgInput.value = "";
      if (files.length) await this.insertImages(files);
    });
    this.els.newBtn.addEventListener("click", () => this.newNote());
    this.els.open.addEventListener("click", () => this.pickFolder());
    this.els.mode.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => this.setMode(b.dataset.m)));
    document.addEventListener("omni:panel", (e) => {
      if (e.detail === "notes") {
        // 사이드바로 열면 무조건 메인 Notes 볼트 (프로젝트 이식 상태가 아니면)
        if (!this.els.panel.classList.contains("pj-embedded")) this.openMain();
        setTimeout(() => this._cm && this._cm.refresh(), 50);
        this.checkExternal(); // 패널 진입 즉시 외부 변경 반영
      }
    });
    // 외부 수정 자동 반영 (다른 에디터·옴니 AI의 edit_file 등)
    setInterval(() => this.checkExternal(), 3000);
    // 프리뷰의 위키링크 클릭 → 해당 노트 열기 (없으면 생성)
    this.els.preview.addEventListener("click", (e) => {
      const a = e.target.closest("a.wikilink");
      if (a) {
        e.preventDefault();
        this.openByName(a.dataset.note);
        return;
      }
      const ext = e.target.closest("a[href]");
      if (ext) {
        e.preventDefault();
        const url = ext.getAttribute("href");
        if (/^https?:\/\//.test(url)) {
          if (OmniNative.available) {
            OmniNative.request("open.url", JSON.stringify({ url })).catch(() => {});
          } else {
            window.open(url, "_blank");
          }
        }
      }
    });
  },

  async openMain() {
    if (!OmniNative.available) {
      if (!this._booted) {
        this._booted = true;
        this.flash("BROWSER DEV \u2014 VAULT NEEDS THE NATIVE APP");
      }
      return;
    }
    try {
      const r = await OmniNative.request("notes.vault", null, 8000);
      if (r && r.ok && this._vault !== r.path) this.setVault(r.path);
    } catch (e) {}
  },

  async pickFolder() {
    if (!OmniNative.available) return;
    try {
      const r = await OmniNative.request("ce.pickFolder", null, 120000);
      if (r && r.ok) this.setVault(r.path);
    } catch (e) {}
  },

  // 프로젝트 에디터가 프로젝트의 notes 폴더로 볼트를 바꿀 때 사용
  async openVault(path) {
    try {
      const r = await OmniNative.request("ce.addRoot", JSON.stringify({ path }), 8000);
      if (r && r.ok) this.setVault(r.path);
    } catch (e) {}
  },

  flash(text, tone) {
    const el = this.els.msg;
    el.textContent = text;
    el.className = `ts-item${tone ? " " + tone : ""}`;
    clearTimeout(this._msgT);
    if (tone === "ok") this._msgT = setTimeout(() => { el.textContent = ""; }, 2000);
  },

  async setVault(path) {
    if (this._dirty) await this.save();
    this._vault = path;
    this._cur = null;
    this._dirty = false;
    this.els.title.hidden = true;
    this.els.toolbar.hidden = true;
    this.els.preview.hidden = true;
    this.els.empty.hidden = false;
    if (this._cm) this._cm.setValue("");
    this.els.vault.textContent = path.replace(/^\/Users\/[^/]+/, "~").toUpperCase();
    await this.rescan();
  },

  // 볼트 전체 색인 (위키링크 해석 + 트리 렌더)
  async rescan() {
    this._index = [];
    this.els.tree.querySelectorAll(".ce-node, .ce-kids").forEach((n) => n.remove());
    await this.scanDir(this._vault, this.els.tree, 0);
    this.els.treeEmpty.hidden = this._index.length > 0;
  },

  async scanDir(path, container, depth) {
    if (depth > 4) return;
    let r;
    try {
      r = await OmniNative.request("ce.tree", JSON.stringify({ path }), 10000);
    } catch (e) {
      return;
    }
    if (!r || !r.ok) return;
    for (const ent of r.entries) {
      const full = `${path}/${ent.name}`;
      if (ent.dir) {
        const node = document.createElement("div");
        node.className = "ce-node dir";
        node.style.paddingLeft = `${6 + depth * 12}px`;
        const glyph = document.createElement("span");
        glyph.className = "glyph";
        glyph.textContent = "\u25BE";
        const label = document.createElement("span");
        label.textContent = ent.name;
        node.append(glyph, label);
        container.appendChild(node);
        const kids = document.createElement("div");
        kids.className = "ce-kids open";
        container.appendChild(kids);
        node.addEventListener("click", () => {
          const open = kids.classList.toggle("open");
          glyph.textContent = open ? "\u25BE" : "\u25B8";
        });
        node.addEventListener("contextmenu", (e) => this.treeMenu(e, {
          path: full, name: ent.name, isDir: true, parent: path, labelEl: label,
        }));
        await this.scanDir(full, kids, depth + 1);
      } else if (/\.md$/i.test(ent.name)) {
        const node = document.createElement("div");
        node.className = "ce-node";
        node.dataset.path = full;
        node.style.paddingLeft = `${6 + depth * 12}px`;
        const glyph = document.createElement("span");
        glyph.className = "glyph";
        glyph.textContent = "\u00B7";
        const label = document.createElement("span");
        label.textContent = ent.name.replace(/\.md$/i, "");
        node.append(glyph, label);
        node.addEventListener("click", () => this.openNote(full));
        node.addEventListener("contextmenu", (e) => this.treeMenu(e, {
          path: full, name: ent.name, isDir: false, parent: path, labelEl: label,
        }));
        container.appendChild(node);
        this._index.push({ name: ent.name.replace(/\.md$/i, ""), path: full });
      }
    }
  },

  // ── 서식 도구 ──
  wrapSel(prefix, suffix) {
    const cm = this._cm;
    if (!cm || !this._cur) return;
    const sel = cm.getSelection();
    if (sel) {
      cm.replaceSelection(prefix + sel + suffix);
    } else {
      const cur = cm.getCursor();
      cm.replaceRange(prefix + suffix, cur);
      cm.setCursor({ line: cur.line, ch: cur.ch + prefix.length });
    }
    cm.focus();
  },

  headingLine(level) {
    const cm = this._cm;
    if (!cm || !this._cur) return;
    const cur = cm.getCursor();
    const line = cm.getLine(cur.line);
    const stripped = line.replace(/^#{1,6}\s+/, "");
    const mark = "#".repeat(level) + " ";
    const already = line.startsWith(mark) && line.slice(mark.length) === stripped;
    cm.replaceRange(already ? stripped : mark + stripped,
      { line: cur.line, ch: 0 }, { line: cur.line, ch: line.length });
    cm.focus();
  },

  fmt(kind) {
    if (kind === "bold") this.wrapSel("**", "**");
    else if (kind === "italic") this.wrapSel("*", "*");
    else if (kind === "strike") this.wrapSel("~~", "~~");
    else if (kind === "code") this.wrapSel("`", "`");
    else if (kind === "h1") this.headingLine(1);
    else if (kind === "h2") this.headingLine(2);
    else if (kind === "h3") this.headingLine(3);
    else if (kind === "image") this.els.imgInput.click();
  },

  // ── 이미지 삽입: 볼트 assets/에 복사 후 상대 경로로 참조 ──
  async insertImages(files) {
    if (!this._vault || !this._cur || !OmniNative.available) {
      this.flash("IMAGE INSERT NEEDS THE NATIVE APP", "alert");
      return;
    }
    const ce = OmniOS.modules.ce;
    const assets = `${this._vault}/assets`;
    await ce.fileOp("ce.mkdir", { path: assets }); // 이미 있으면 무시
    let existing = [];
    try {
      const t = await OmniNative.request("ce.tree", JSON.stringify({ path: assets }), 10000);
      existing = ((t && t.entries) || []).map((x) => x.name);
    } catch (e) {}
    for (const f of files) {
      if (f.size > 50 * 1024 * 1024) {
        this.flash(`${f.name}: OVER 50MB`, "alert");
        continue;
      }
      let name = f.name.replace(/[\/\\:]/g, "");
      const dot = name.lastIndexOf(".");
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let n = 2;
      while (existing.includes(name)) name = `${base}-${n++}${ext}`;
      existing.push(name);
      const buf = await f.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      const ok = await ce.fileOp("ce.writeBin",
        { path: `${assets}/${name}`, data: btoa(bin) });
      if (ok) {
        const cm = this._cm;
        const cur = cm.getCursor();
        cm.replaceRange(`![${base}](assets/${name})\n`, cur);
        this.flash(`INSERTED ${name}`, "ok");
      } else {
        this.flash(`${name}: SAVE FAILED`, "alert");
      }
    }
    if (this._mode === "preview") this.renderPreview();
  },

  treeMenu(e, info) {
    // info: {path, name(파일명), isDir, parent, labelEl}
    e.preventDefault();
    e.stopPropagation();
    const ce = OmniOS.modules.ce;
    const items = [];
    if (info.isDir) {
      items.push({
        label: "NEW NOTE HERE",
        onClick: () => this.newNote(info.path),
      });
      items.push({
        label: "NEW FOLDER",
        onClick: async () => {
          let existing = [];
          try {
            const t = await OmniNative.request("ce.tree",
              JSON.stringify({ path: info.path }), 10000);
            existing = ((t && t.entries) || []).map((x) => x.name);
          } catch (err) {}
          let nm = "New Folder";
          let n = 2;
          while (existing.includes(nm)) nm = `New Folder ${n++}`;
          if (await ce.fileOp("ce.mkdir", { path: `${info.path}/${nm}` })) this.rescan();
        },
      });
      items.push({ sep: true });
    }
    items.push({
      label: "RENAME",
      onClick: () => {
        const shown = info.isDir ? info.name : info.name.replace(/\.md$/i, "");
        ce.inlineRename(info.labelEl, shown, async (newName) => {
          const fileName = info.isDir ? newName
            : (/\.md$/i.test(newName) ? newName : `${newName}.md`);
          const newPath = `${info.parent}/${fileName}`;
          if (await ce.fileOp("ce.rename", { path: info.path, to: newPath })) {
            if (this._cur === info.path) {
              this._cur = newPath;
              this.els.title.textContent = fileName.replace(/\.md$/i, "").toUpperCase();
            } else if (this._cur && this._cur.startsWith(`${info.path}/`)) {
              this._cur = newPath + this._cur.slice(info.path.length);
            }
            this.rescan();
          } else {
            this.flash("RENAME FAILED", "alert");
          }
        });
      },
    });
    items.push({
      label: "DUPLICATE",
      onClick: async () => {
        const nm = await ce.dupTargetName(info.parent, info.name);
        if (await ce.fileOp("ce.copy", { path: info.path, to: `${info.parent}/${nm}` })) {
          this.rescan();
        } else {
          this.flash("DUPLICATE FAILED", "alert");
        }
      },
    });
    items.push({ sep: true });
    items.push({
      label: "COPY PATH",
      onClick: () => ce.fileOp("ce.clip", { text: info.path }),
    });
    items.push({
      label: "COPY [[LINK]]",
      onClick: () => ce.fileOp("ce.clip",
        { text: `[[${info.name.replace(/\.md$/i, "")}]]` }),
    });
    items.push({
      label: "REVEAL IN FINDER",
      onClick: () => ce.fileOp("ce.reveal", { path: info.path }),
    });
    items.push({ sep: true });
    items.push({
      label: "MOVE TO TRASH",
      onClick: async () => {
        if (await ce.fileOp("ce.trash", { path: info.path })) {
          if (this._cur === info.path
              || (this._cur && this._cur.startsWith(`${info.path}/`))) {
            this._cur = null;
            this.els.title.hidden = true;
            this.els.toolbar.hidden = true;
            this.els.empty.hidden = false;
            this.els.preview.hidden = true;
            if (this._cm) this._cm.setValue("");
          }
          this.flash(`TRASHED ${info.name}`, "ok");
          this.rescan();
        } else {
          this.flash("TRASH FAILED", "alert");
        }
      },
    });
    OmniOS.ctxMenu(items, e.clientX, e.clientY);
  },

  ensureCM() {
    if (this._cm) return this._cm;
    if (typeof window.CodeMirror === "undefined") return null;
    this._cm = window.CodeMirror(this.els.editor, {
      mode: "markdown",
      lineNumbers: false,
      lineWrapping: true,
      indentUnit: 2,
      autoCloseBrackets: true,
    });
    this._cm.on("change", () => {
      if (!this._cur) return;
      this._dirty = true;
      clearTimeout(this._saveT);
      this._saveT = setTimeout(() => this.save(), 800); // 자동 저장
    });
    // [[ 위키링크 자동완성
    this._cm.on("inputRead", (cm, change) => {
      const cur = cm.getCursor();
      const line = cm.getLine(cur.line).slice(0, cur.ch);
      if (/\[\[[^\]]*$/.test(line)) this.linkHint(cm);
    });
    return this._cm;
  },

  linkHint(cm) {
    const CM = window.CodeMirror;
    cm.showHint({
      completeSingle: false,
      hint: (c) => {
        const cur = c.getCursor();
        const line = c.getLine(cur.line).slice(0, cur.ch);
        const m = line.match(/\[\[([^\]]*)$/);
        if (!m) return null;
        const partial = m[1].toLowerCase();
        const list = this._index
          .filter((n) => n.name.toLowerCase().includes(partial))
          .slice(0, 30)
          .map((n) => ({ text: `${n.name}]]` , displayText: n.name }));
        if (!list.length) return null;
        return {
          list,
          from: CM.Pos(cur.line, cur.ch - m[1].length),
          to: CM.Pos(cur.line, cur.ch),
        };
      },
    });
  },

  async newNote(dir) {
    if (!this._vault) return;
    const target = dir || this._vault;
    let name = "Untitled.md";
    let n = 2;
    const names = this._index.map((x) => `${x.name}.md`);
    while (names.includes(name)) name = `Untitled-${n++}.md`;
    const path = `${target}/${name}`;
    try {
      await OmniNative.request("ce.write",
        JSON.stringify({ path, data: `# ${name.replace(/\.md$/, "")}\n\n` }), 8000);
    } catch (e) {
      return;
    }
    await this.rescan();
    this.openNote(path);
  },

  async openNote(path) {
    if (this._dirty) await this.save();
    let r;
    try {
      r = await OmniNative.request("ce.read", JSON.stringify({ path }), 10000);
    } catch (e) {
      return;
    }
    if (!r || !r.ok) return;
    this._cur = path;
    const cm = this.ensureCM();
    cm.setValue(r.text);
    this._dirty = false;
    const name = path.split("/").pop().replace(/\.md$/i, "");
    this.els.title.hidden = false;
    this.els.title.textContent = name.toUpperCase();
    this.els.toolbar.hidden = false;
    this.els.empty.hidden = true;
    this.els.tree.querySelectorAll(".ce-node.active").forEach((x) => x.classList.remove("active"));
    const node = this.els.tree.querySelector(`.ce-node[data-path="${CSS.escape(path)}"]`);
    if (node) node.classList.add("active");
    this.setMode(this._mode); // 현재 모드 유지 (프리뷰면 다시 렌더)
    setTimeout(() => cm.refresh(), 0);
  },

  // ── 외부 변경 감시: 열린 노트는 디스크 내용과 diff 후 리로드(편집 중이면
  // 건너뜀), 트리는 파일 목록 시그니처가 바뀌었을 때만 재스캔 ──
  _watchTick: 0,
  _treeSig: null,

  async checkExternal() {
    if (!OmniNative.available || !this._vault) return;
    if (!this.els.panel.classList.contains("active")) return;
    // 1) 열린 노트 내용 — 매 틱 (사용자가 편집 중이면 덮어쓰지 않음)
    if (this._cur && this._cm && !this._dirty) {
      try {
        const r = await OmniNative.request("ce.read",
          JSON.stringify({ path: this._cur }), 8000);
        if (r && r.ok && typeof r.text === "string"
            && r.text !== this._cm.getValue() && !this._dirty) {
          const scroll = this._cm.getScrollInfo();
          const cursor = this._cm.getCursor();
          this._cm.setValue(r.text);
          this._dirty = false; // setValue의 change 이벤트가 dirty를 세우므로 리셋
          clearTimeout(this._saveT);
          this._cm.setCursor(cursor);
          this._cm.scrollTo(scroll.left, scroll.top);
          this.setMode(this._mode); // 프리뷰 모드면 다시 렌더
          this.flash("EXTERNAL CHANGE LOADED", "ok");
        }
      } catch (e) { /* 삭제/일시 오류 — 무시 */ }
    }
    // 2) 트리 — 3틱(9초)마다 얕은 시그니처 비교로 생성/삭제 반영
    this._watchTick = (this._watchTick + 1) % 3;
    if (this._watchTick !== 0) return;
    try {
      const sig = await this.treeSignature();
      if (sig !== null) {
        if (this._treeSig !== null && sig !== this._treeSig) {
          await this.rescan();
          const node = this._cur && this.els.tree.querySelector(
            `.ce-node[data-path="${CSS.escape(this._cur)}"]`);
          if (node) node.classList.add("active");
        }
        this._treeSig = sig;
      }
    } catch (e) { /* 무시 */ }
  },

  async treeSignature() {
    // 볼트 루트 + 1단계 하위 폴더의 항목명 목록 (가벼운 변경 감지용)
    const parts = [];
    const root = await OmniNative.request("ce.tree",
      JSON.stringify({ path: this._vault }), 8000).catch(() => null);
    if (!root || !root.ok) return null;
    const entries = root.entries || [];
    parts.push(entries.map((e) => e.name).join(","));
    for (const e of entries.slice(0, 12)) {
      if (!e.dir) continue;
      const sub = await OmniNative.request("ce.tree",
        JSON.stringify({ path: `${this._vault}/${e.name}` }), 8000).catch(() => null);
      if (sub && sub.ok) {
        parts.push(`${e.name}:${(sub.entries || []).map((x) => x.name).join(",")}`);
      }
    }
    return parts.join("|");
  },

  async openByName(name) {
    const hit = this._index.find((n) => n.name.toLowerCase() === name.toLowerCase());
    if (hit) {
      this.openNote(hit.path);
      return;
    }
    // 없는 노트는 즉석 생성
    const path = `${this._vault}/${name}.md`;
    try {
      await OmniNative.request("ce.write",
        JSON.stringify({ path, data: `# ${name}\n\n` }), 8000);
      await this.rescan();
      this.openNote(path);
    } catch (e) {}
  },

  async save() {
    if (!this._cur || !this._cm || !this._dirty) return;
    this._dirty = false;
    try {
      const r = await OmniNative.request("ce.write",
        JSON.stringify({ path: this._cur, data: this._cm.getValue() }), 10000);
      if (r && r.ok) this.flash("SAVED", "ok");
      else this.flash("SAVE FAILED", "alert");
    } catch (e) {
      this.flash("SAVE FAILED", "alert");
    }
  },

  setMode(m) {
    this._mode = m;
    this.els.mode.querySelectorAll("button").forEach((b) =>
      b.classList.toggle("active", b.dataset.m === m));
    if (m === "preview" && this._cur) {
      this.renderPreview();
      this.els.preview.hidden = false;
    } else {
      this.els.preview.hidden = true;
      if (this._cm) setTimeout(() => this._cm.refresh(), 0);
    }
  },

  renderPreview() {
    if (typeof window.marked === "undefined" || !this._cm) return;
    let md = this._cm.getValue();
    // [[위키링크]] → 클릭 가능한 앵커 (존재하지 않으면 앰버)
    md = md.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (all, target, label) => {
      const exists = this._index.some((n) => n.name.toLowerCase() === target.toLowerCase());
      const cls = exists ? "wikilink" : "wikilink missing";
      const text = label || target;
      return `<a class="${cls}" data-note="${target.replace(/"/g, "&quot;")}">${text}</a>`;
    });
    this.els.preview.innerHTML = window.marked.parse(md, { gfm: true, breaks: true });
    // 상대 경로 이미지 → 로컬 미디어 스킴 (볼트 기준)
    this.els.preview.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src") || "";
      if (!/^(https?:|omni:|data:)/.test(src)) {
        img.src = `omni://local/__media__?p=${encodeURIComponent(`${this._vault}/${src}`)}`;
      }
    });
  },

  resize() {
    if (this._cm) this._cm.refresh();
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
      theme: $("ce-theme"),
      nfModal: $("ce-modal"), nfName: $("ce-nf-name"), nfExt: $("ce-nf-ext"),
      nfDir: $("ce-nf-dir"), nfCancel: $("ce-nf-cancel"), nfCreate: $("ce-nf-create"),
    };
    this.els.run.addEventListener("click", () => this.runActive());
    const savedTheme = (localStorage.getItem("omni.ce.theme") || "visual").replace("vscode", "visual");
    this.els.theme.value = savedTheme;
    this.els.editor.dataset.theme = savedTheme;
    this.els.theme.value = savedTheme;
    this.els.theme.addEventListener("change", () => {
      const t = this.els.theme.value;
      this.els.editor.dataset.theme = t;
      localStorage.setItem("omni.ce.theme", t);
    });
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

  // 프로젝트 에디터가 프로젝트의 code 폴더를 열 때 사용
  async openPath(path) {
    try {
      const r = await OmniNative.request("ce.addRoot", JSON.stringify({ path }), 8000);
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
      const rerender = () => {
        if (container === this.els.tree) {
          this.els.tree.querySelectorAll(":scope > .ce-node, :scope > .ce-kids")
            .forEach((n) => n.remove());
          this.expandDir(this._root, this.els.tree, 0);
        } else {
          container.textContent = "";
          this.expandDir(path, container, depth);
        }
      };
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
        node.addEventListener("contextmenu", (e) => this.treeMenu(e, {
          path: full, name: ent.name, isDir: true, parent: path,
          container, depth, labelEl: label, kidsEl: kids, rerender,
        }));
      } else {
        node.addEventListener("click", () => {
          this.els.tree.querySelectorAll(".ce-node.active")
            .forEach((n) => n.classList.remove("active"));
          node.classList.add("active");
          this.openFile(full);
        });
        node.addEventListener("contextmenu", (e) => this.treeMenu(e, {
          path: full, name: ent.name, isDir: false, parent: path,
          container, depth, labelEl: label, rerender,
        }));
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
    if (f.dirty) await this.saveActive(); // 실행 전 자동 저장
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

  // 언어별 완성 사전 — keywords/builtins + 모듈 멤버 (자동완성 사전)
  DICTS: {
    python: {
      keywords: ("and as assert async await break class continue def del elif else except finally "
        + "for from global if import in is lambda nonlocal not or pass raise return try while with yield "
        + "True False None self").split(" "),
      builtins: ("print len range open input str int float bool list dict set tuple enumerate zip map "
        + "filter sorted reversed sum min max abs round pow divmod type isinstance issubclass super "
        + "hasattr getattr setattr delattr callable repr format vars dir id hash iter next any all "
        + "exec eval compile globals locals bytes bytearray frozenset slice staticmethod classmethod "
        + "property Exception ValueError TypeError KeyError IndexError RuntimeError StopIteration "
        + "random math os sys time json re string datetime collections itertools functools pathlib "
        + "subprocess threading argparse typing").split(" "),
      members: {
        random: "choice choices sample shuffle randint random uniform randrange seed gauss betavariate triangular".split(" "),
        math: "pi e tau inf nan sqrt floor ceil sin cos tan asin acos atan atan2 log log2 log10 exp pow fabs factorial gcd degrees radians hypot trunc isclose".split(" "),
        os: "path getcwd chdir listdir mkdir makedirs remove rmdir rename environ system popen sep linesep name cpu_count".split(" "),
        sys: "argv exit path stdin stdout stderr platform version maxsize executable".split(" "),
        time: "time sleep monotonic perf_counter strftime strptime localtime gmtime ctime time_ns".split(" "),
        json: "dumps loads dump load JSONDecodeError".split(" "),
        re: "match search findall finditer sub subn split compile fullmatch escape IGNORECASE MULTILINE DOTALL".split(" "),
        string: "ascii_letters ascii_lowercase ascii_uppercase digits punctuation whitespace hexdigits".split(" "),
        datetime: "datetime date time timedelta timezone now today utcnow fromtimestamp strftime strptime".split(" "),
        collections: "Counter defaultdict deque namedtuple OrderedDict ChainMap".split(" "),
        itertools: "count cycle repeat chain product permutations combinations groupby islice zip_longest".split(" "),
        functools: "reduce partial lru_cache wraps cache cmp_to_key".split(" "),
        subprocess: "run Popen call check_output check_call PIPE DEVNULL".split(" "),
      },
      modules: ("os sys time json re math random datetime collections itertools functools pathlib "
        + "subprocess threading multiprocessing argparse typing string csv sqlite3 socket http urllib "
        + "logging unittest asyncio dataclasses enum abc io shutil glob pickle hashlib base64 secrets "
        + "statistics decimal fractions heapq bisect queue struct zlib gzip tarfile zipfile tempfile "
        + "webbrowser platform getpass uuid copy warnings traceback inspect signal select textwrap "
        + "numpy pandas requests flask django matplotlib scipy pytest PIL cv2 torch tensorflow "
        + "sounddevice serial mediapipe").split(" "),
      generic: ("append extend insert remove pop clear index count sort reverse copy keys values items "
        + "get update setdefault add discard union intersection join split strip lstrip rstrip replace "
        + "startswith endswith find rfind upper lower title capitalize format encode decode isdigit "
        + "isalpha isalnum splitlines zfill ljust rjust center read write readlines close").split(" "),
    },
    js: {
      keywords: ("const let var function return if else for while do switch case default break continue "
        + "class extends constructor new this super import export from async await try catch finally "
        + "throw typeof instanceof in of delete void yield static get set null undefined true false").split(" "),
      builtins: ("console Math JSON Object Array String Number Boolean Promise Date RegExp Map Set "
        + "WeakMap Symbol Error TypeError parseInt parseFloat isNaN isFinite fetch setTimeout "
        + "setInterval clearTimeout clearInterval requestAnimationFrame document window navigator "
        + "localStorage sessionStorage location history alert confirm prompt structuredClone "
        + "encodeURIComponent decodeURIComponent btoa atob").split(" "),
      members: {
        console: "log error warn info debug table trace time timeEnd group groupEnd assert count dir".split(" "),
        Math: "floor ceil round random abs max min sqrt cbrt pow hypot sin cos tan atan2 log log2 log10 exp sign trunc PI E".split(" "),
        JSON: "parse stringify".split(" "),
        Object: "keys values entries assign freeze create defineProperty getPrototypeOf fromEntries hasOwn".split(" "),
        Array: "isArray from of".split(" "),
        Promise: "all allSettled race any resolve reject".split(" "),
        Number: "parseInt parseFloat isInteger isFinite isNaN MAX_SAFE_INTEGER EPSILON".split(" "),
        String: "fromCharCode fromCodePoint raw".split(" "),
        Date: "now parse UTC".split(" "),
        document: "getElementById querySelector querySelectorAll createElement createTextNode addEventListener body head title".split(" "),
        window: "addEventListener removeEventListener requestAnimationFrame innerWidth innerHeight devicePixelRatio open close scrollTo".split(" "),
        localStorage: "getItem setItem removeItem clear key length".split(" "),
      },
      modules: ("fs path os http https crypto util events stream url querystring child_process "
        + "readline zlib assert buffer cluster net tls dns worker_threads react react-dom vue svelte "
        + "express axios lodash moment dayjs uuid chalk commander inquirer dotenv ws socket.io "
        + "three jquery d3 chart.js zod").split(" "),
      generic: ("map filter reduce forEach find findIndex some every includes indexOf lastIndexOf push "
        + "pop shift unshift slice splice concat join reverse sort flat flatMap fill keys values entries "
        + "length split replace replaceAll trim trimStart trimEnd toUpperCase toLowerCase padStart "
        + "padEnd startsWith endsWith charAt charCodeAt codePointAt repeat substring at then catch "
        + "finally addEventListener removeEventListener appendChild removeChild classList style dataset "
        + "textContent innerHTML value checked disabled hidden getAttribute setAttribute toString "
        + "toFixed hasOwnProperty").split(" "),
    },
    c: {
      keywords: ("auto break case char const continue default do double else enum extern float for goto "
        + "if inline int long register return short signed sizeof static struct switch typedef union "
        + "unsigned void volatile while bool true false class public private protected virtual override "
        + "namespace using new delete template typename nullptr NULL NSString NSArray NSDictionary "
        + "NSNumber NSData NSObject BOOL YES NO id instancetype").split(" "),
      builtins: ("printf sprintf snprintf fprintf scanf sscanf malloc calloc realloc free memcpy memset "
        + "memcmp strlen strcpy strncpy strcmp strncmp strcat strstr strchr fopen fclose fread fwrite "
        + "fgets fputs fseek ftell exit abs rand srand atoi atof qsort main NSLog "
        + "dispatch_async dispatch_get_main_queue").split(" "),
      members: {},
      modules: ("stdio.h stdlib.h string.h math.h time.h stdbool.h stdint.h ctype.h assert.h "
        + "limits.h float.h signal.h unistd.h fcntl.h errno.h stdarg.h stddef.h setjmp.h locale.h "
        + "pthread.h sys/types.h sys/stat.h sys/socket.h netinet/in.h arpa/inet.h "
        + "iostream vector string map set unordered_map unordered_set algorithm memory thread chrono "
        + "functional fstream sstream iomanip numeric utility tuple array deque queue stack bitset "
        + "regex cmath cstdio cstdlib cstring Foundation/Foundation.h Cocoa/Cocoa.h "
        + "Arduino.h WiFi.h Wire.h SPI.h Servo.h EEPROM.h").split(" "),
      generic: [],
    },
    shell: {
      keywords: "if then else elif fi for while do done case esac function in return local export".split(" "),
      builtins: ("echo cd ls pwd cat grep sed awk cut sort uniq head tail find xargs chmod chown mkdir "
        + "rmdir rm cp mv touch which curl wget tar zip unzip ssh scp git python3 node npm brew open "
        + "kill ps top df du date sleep read printf source alias history clear env set unset").split(" "),
      members: { git: "add commit push pull clone status log diff branch checkout merge rebase stash reset fetch remote tag".split(" ") },
      generic: [],
    },
  },

  langOf(name) {
    const ext = (name || "").split(".").pop().toLowerCase();
    if (ext === "py") return "python";
    if (["js", "mjs", "cjs", "jsx", "ts", "tsx", "json", "html", "htm"].includes(ext)) return "js";
    if (["c", "cpp", "cc", "h", "hpp", "ino", "m", "mm", "java", "swift", "rs", "go"].includes(ext)) return "c";
    if (["sh", "zsh", "bash"].includes(ext)) return "shell";
    return null;
  },

  bufferWords(cm, exclude) {
    const words = new Set();
    const re = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
    const text = cm.getValue();
    let m;
    while ((m = re.exec(text)) !== null && words.size < 400) words.add(m[0]);
    words.delete(exclude);
    return [...words];
  },

  // import X as Y / const Y = X 별칭을 수집해 멤버 완성에 반영
  aliasMap(cm, lang) {
    const map = {};
    const text = cm.getValue();
    if (lang === "python") {
      for (const m of text.matchAll(/^[ \t]*import[ \t]+([^\n#]+)/gm)) {
        for (const part of m[1].split(",")) {
          const am = part.trim().match(/^([A-Za-z_][\w.]*)[ \t]+as[ \t]+([A-Za-z_]\w*)$/);
          if (am) map[am[2]] = am[1];
        }
      }
    } else if (lang === "js") {
      for (const m of text.matchAll(
        /(?:const|let|var)[ \t]+([A-Za-z_$]\w*)[ \t]*=[ \t]*([A-Za-z_$]\w*)[ \t]*;?(?:\n|$)/g)) {
        map[m[1]] = m[2];
      }
    }
    return map;
  },

  hintFn(cm) {
    const CM = window.CodeMirror;
    const cur = cm.getCursor();
    const line = cm.getLine(cur.line).slice(0, cur.ch);
    const f = this._files[this._active];
    const lang = this.langOf(f && f.name) || "js";
    const D = this.DICTS[lang];

    // 임포트 컨텍스트: 모듈/라이브러리 이름 완성
    // (JS의 'pkg', C의 <h>는 문자열 토큰 안이므로 문자열 가드보다 먼저)
    const modList = D.modules || [];
    let modMatch = null;
    if (lang === "python") {
      const fromImp = line.match(/^\s*from\s+([A-Za-z_]\w*)\s+import\s+([\w]*)$/);
      if (fromImp && D.members[fromImp[1]]) {
        // from random import cho... → 멤버 완성
        const partial = fromImp[2];
        const list = D.members[fromImp[1]]
          .filter((t) => t.startsWith(partial))
          .map((t) => ({ text: t, kind: fromImp[1] }));
        if (!list.length) return null;
        return this.hintResult(list, cur, partial.length);
      }
      modMatch = line.match(/^\s*(?:import|from)\s+([A-Za-z_][\w.]*)?$/);
    } else if (lang === "js") {
      modMatch = line.match(/(?:from\s*|require\s*\(\s*)['"]([^'"]*)$/);
    } else if (lang === "c") {
      modMatch = line.match(/#(?:include|import)\s*[<"]([^>"]*)$/);
    }
    if (modMatch !== null) {
      const partial = modMatch[1] || "";
      const list = modList
        .filter((t) => t.toLowerCase().startsWith(partial.toLowerCase()))
        .map((t) => ({ text: t, kind: "module" }));
      if (!list.length) return null;
      return this.hintResult(list, cur, partial.length);
    }

    // 이하 일반 완성은 주석/문자열 안에서 비활성
    const tok = cm.getTokenAt(cur);
    if (/\b(comment|string)\b/.test(tok.type || "")) return null;

    // receiver.partial — 모듈/객체 멤버 완성
    const dot = line.match(/([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z0-9_]*)$/);
    let cands = [];
    let from, to = CM.Pos(cur.line, cur.ch);
    if (dot) {
      const partial = dot[2];
      from = CM.Pos(cur.line, cur.ch - partial.length);
      let recv = dot[1];
      if (!D.members[recv]) {
        const alias = this.aliasMap(cm, lang)[recv];
        if (alias && D.members[alias]) recv = alias; // rd. → random.
      }
      const members = D.members[recv];
      const pool = members
        ? members.map((t) => ({ text: t, kind: recv }))
        : D.generic.map((t) => ({ text: t, kind: "method" }));
      cands = pool.filter((c) => c.text.startsWith(partial));
    } else {
      const word = line.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
      if (!word) return null;
      const prefix = word[1];
      from = CM.Pos(cur.line, cur.ch - prefix.length);
      const pool = [
        ...D.keywords.map((t) => ({ text: t, kind: "keyword" })),
        ...D.builtins.map((t) => ({ text: t, kind: "builtin" })),
        ...Object.keys(this.aliasMap(cm, lang)).map((t) => ({ text: t, kind: "alias" })),
        ...this.bufferWords(cm, prefix).map((t) => ({ text: t, kind: "word" })),
      ];
      const seen = new Set();
      const starts = [];
      const contains = [];
      for (const c of pool) {
        if (seen.has(c.text)) continue;
        seen.add(c.text);
        const lower = c.text.toLowerCase();
        const p = prefix.toLowerCase();
        if (lower.startsWith(p)) starts.push(c);
        else if (lower.includes(p)) contains.push(c);
      }
      cands = [...starts, ...contains];
    }
    if (!cands.length) return null;
    return {
      list: this.hintItems(cands),
      from,
      to,
    };
  },

  hintItems(cands) {
    return cands.slice(0, 60).map((c) => ({
      text: c.text,
      render: (el) => {
        const name = document.createElement("span");
        name.textContent = c.text;
        const kind = document.createElement("span");
        kind.className = "hint-kind";
        kind.textContent = c.kind.toUpperCase();
        el.append(name, kind);
      },
    }));
  },

  hintResult(cands, cur, partialLen) {
    const CM = window.CodeMirror;
    return {
      list: this.hintItems(cands),
      from: CM.Pos(cur.line, cur.ch - partialLen),
      to: CM.Pos(cur.line, cur.ch),
    };
  },

  // ── 파일 조작 (우클릭 메뉴 공용) ──
  async fileOp(cmd, payload) {
    try {
      const r = await OmniNative.request(cmd, JSON.stringify(payload), 15000);
      return !!(r && r.ok);
    } catch (e) {
      return false;
    }
  },

  // 트리 라벨을 입력창으로 바꿔 인라인 이름 변경
  inlineRename(labelEl, oldName, commit) {
    const input = document.createElement("input");
    input.className = "ino-input ce-rename";
    input.value = oldName;
    labelEl.replaceWith(input);
    input.focus();
    const dotIdx = oldName.lastIndexOf(".");
    input.setSelectionRange(0, dotIdx > 0 ? dotIdx : oldName.length);
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      const v = input.value.trim().replace(/[\/\\:]/g, "");
      input.replaceWith(labelEl);
      if (ok && v && v !== oldName) commit(v);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
      e.stopPropagation();
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("mousedown", (e) => e.stopPropagation());
    input.addEventListener("click", (e) => e.stopPropagation());
  },

  // 열린 탭 경로 동기화 (이름 변경/삭제 후)
  syncTabsRename(oldPath, newPath) {
    for (const f of this._files) {
      if (f.path === oldPath) {
        f.path = newPath;
        f.name = newPath.split("/").pop();
      } else if (f.path.startsWith(`${oldPath}/`)) {
        f.path = newPath + f.path.slice(oldPath.length);
      }
    }
    this.renderTabs();
  },

  syncTabsDelete(path) {
    for (let i = this._files.length - 1; i >= 0; i--) {
      const p = this._files[i].path;
      if (p === path || p.startsWith(`${path}/`)) this.closeTab(i);
    }
  },

  async dupTargetName(parent, name) {
    let existing = [];
    try {
      const t = await OmniNative.request("ce.tree", JSON.stringify({ path: parent }), 10000);
      existing = ((t && t.entries) || []).map((e) => e.name);
    } catch (e) {}
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let cand = `${base} copy${ext}`;
    let n = 2;
    while (existing.includes(cand)) cand = `${base} copy ${n++}${ext}`;
    return cand;
  },

  treeMenu(e, info) {
    // info: {path, name, isDir, parent, container, depth, labelEl, rerender}
    e.preventDefault();
    e.stopPropagation();
    const items = [];
    if (info.isDir) {
      items.push({
        label: "NEW FILE",
        onClick: () => {
          this._selDir = { path: info.path, kidsEl: info.kidsEl, depth: info.depth + 1 };
          this.openNewFile();
        },
      });
      items.push({
        label: "NEW FOLDER",
        onClick: async () => {
          let existing = [];
          try {
            const t = await OmniNative.request("ce.tree",
              JSON.stringify({ path: info.path }), 10000);
            existing = ((t && t.entries) || []).map((x) => x.name);
          } catch (e) {}
          let nm = "New Folder";
          let n = 2;
          while (existing.includes(nm)) nm = `New Folder ${n++}`;
          if (await this.fileOp("ce.mkdir", { path: `${info.path}/${nm}` })) {
            info.rerender();
          } else {
            this.flash("MKDIR FAILED", "alert");
          }
        },
      });
      items.push({ sep: true });
    }
    items.push({
      label: "RENAME",
      onClick: () => {
        this.inlineRename(info.labelEl, info.name, async (newName) => {
          const newPath = `${info.parent}/${newName}`;
          if (await this.fileOp("ce.rename", { path: info.path, to: newPath })) {
            this.syncTabsRename(info.path, newPath);
            info.rerender();
          } else {
            this.flash("RENAME FAILED", "alert");
          }
        });
      },
    });
    items.push({
      label: "DUPLICATE",
      onClick: async () => {
        const nm = await this.dupTargetName(info.parent, info.name);
        if (await this.fileOp("ce.copy", { path: info.path, to: `${info.parent}/${nm}` })) {
          info.rerender();
        } else {
          this.flash("DUPLICATE FAILED", "alert");
        }
      },
    });
    items.push({ sep: true });
    items.push({
      label: "COPY PATH",
      onClick: () => this.fileOp("ce.clip", { text: info.path }),
    });
    items.push({
      label: "COPY NAME",
      onClick: () => this.fileOp("ce.clip", { text: info.name }),
    });
    items.push({
      label: "REVEAL IN FINDER",
      onClick: () => this.fileOp("ce.reveal", { path: info.path }),
    });
    items.push({ sep: true });
    items.push({
      label: "MOVE TO TRASH",
      onClick: async () => {
        if (await this.fileOp("ce.trash", { path: info.path })) {
          this.syncTabsDelete(info.path);
          this.flash(`TRASHED ${info.name}`, "ok");
          info.rerender();
        } else {
          this.flash("TRASH FAILED", "alert");
        }
      },
    });
    OmniOS.ctxMenu(items, e.clientX, e.clientY);
  },

  ensureCM() {
    if (this._cm) return this._cm;
    if (typeof window.CodeMirror === "undefined") return null;
    this._cm = window.CodeMirror(this.els.editor, {
      mode: "text/plain",
      lineNumbers: true,
      indentUnit: 2,
      tabSize: 4,
      autoCloseBrackets: true, // ( → ), { → }, " → ", ' → ' 자동 닫기
      extraKeys: {
        "Cmd-S": () => this.saveActive(),
        "Ctrl-S": () => this.saveActive(),
        "Ctrl-Space": (cm) => this.showHints(cm),
      },
    });
    // 타이핑하는 동안 자동으로 완성 팝업 (공백/따옴표/<는 임포트 컨텍스트용)
    this._cm.on("inputRead", (cm, change) => {
      const ch = change.text[change.text.length - 1];
      if (/[A-Za-z_.]$/.test(ch)) {
        this.showHints(cm);
      } else if (/[\s'"<(]$/.test(ch)) {
        const cur = cm.getCursor();
        const line = cm.getLine(cur.line).slice(0, cur.ch);
        if (/(?:^\s*(?:import|from)\s+$)|(?:from\s*['"]$)|(?:require\s*\(\s*['"]?$)|(?:#(?:include|import)\s*[<"]$)|(?:\s+import\s+$)/.test(line)) {
          this.showHints(cm);
        }
      }
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

  showHints(cm) {
    if (cm.state.completionActive) return; // 이미 열려 있으면 필터링은 애드온이 처리
    cm.showHint({
      hint: (c) => this.hintFn(c),
      completeSingle: false,
      alignWithWord: true,
    });
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
        if (this._projectSaveDir
            && !f.path.startsWith(`${this._projectSaveDir.replace(/\/code$/, "")}/`)) {
          OmniOS.projectKeep(this._projectSaveDir, f.name, f.doc.getValue());
        }
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
  // 실측 조립 지오메트리 (assembly_layout.scad):
  // level_z(i) = 26*(7-i) - 4 + horn_top_z(50) [mm] → ch0(+30°) 상단 228mm … ch6(-30°) 72mm
  CH_HEIGHTS: [0.228, 0.202, 0.176, 0.150, 0.124, 0.098, 0.072], // sensor z on mast (m)
  SENSOR_FWD: 0.020, // 마스트 회전축 → 센서 발광면 전방 오프셋 (장착면 9.6 + 스페이서 10mm)
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

    // 실제 조립 형상 마커 (assembly_layout.scad 실측): 스탠드 + 기둥 + 7개 틸트 스페이서
    const mastMat = new THREE.MeshBasicMaterial({
      color: 0x35d6ff, transparent: true, opacity: 0.85 });
    const mastGrp = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.008, 0.07), mastMat);
    base.position.y = 0.004;
    mastGrp.add(base);
    const servo = new THREE.Mesh(new THREE.BoxGeometry(0.030, 0.042, 0.045), mastMat);
    servo.position.y = 0.029;
    mastGrp.add(servo);
    const column = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.236, 0.0254), mastMat);
    column.position.y = 0.05 + 0.118;
    mastGrp.add(column);
    for (let ch = 0; ch < 7; ch++) {
      const sp = new THREE.Group();
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.010, 0.016, 0.0285), mastMat);
      plate.position.x = 0.005;
      sp.add(plate);
      sp.position.set(0.0146, this.CH_HEIGHTS[ch], 0);
      sp.rotation.z = (this.TILTS[ch] * Math.PI) / 180;
      mastGrp.add(sp);
    }
    scene.add(mastGrp);

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
    const horiz = this.SENSOR_FWD + r * Math.cos(th); // 센서는 축에서 2cm 앞
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
      const rho = Math.max(0.001, Math.hypot(x, z) - this.SENSOR_FWD);
      const mm = Math.hypot(rho, y - this.CH_HEIGHTS[3]) * 1000;
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
          // 센서 기준 상대좌표: 수평 성분에서 전방 오프셋 제거
          const elev = Math.atan2(y - this.CH_HEIGHTS[ch], rho) * 180 / Math.PI;
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
      if (this._projectSaveDir) {
        for (const f of r.files || []) {
          OmniOS.projectKeep(this._projectSaveDir, f.name, f.content);
        }
      }
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
      if (this._projectSaveDir) {
        OmniOS.projectKeep(this._projectSaveDir, f.name, f.doc.getValue());
      }
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

// ---------- shared: OmniNet (허용 호스트 HTTP GET) ----------
// 앱에서는 네이티브 프록시(net.get, 허용 호스트만)로 CORS를 우회하고,
// 브라우저 개발 모드에서는 직접 fetch (CORS 열린 API만 동작).
const OmniNet = {
  async get(url, timeout = 20000) {
    if (OmniNative.available) {
      const r = await OmniNative.request("net.get", JSON.stringify({ url }), timeout);
      if (!r || !r.ok) throw new Error((r && r.error) || `HTTP ${r && r.status}`);
      return r.body;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  },
  async json(url, timeout) { return JSON.parse(await this.get(url, timeout)); },
  // Halo 안경 브리지용 스냅샷 내보내기 (~/.omni/store/halo_<name>.json)
  haloExport(name, data) {
    if (!OmniNative.available) return;
    OmniNative.request("store.write", JSON.stringify({
      name: `halo_${name}`, data: JSON.stringify({ ts: Date.now(), ...data }),
    }), 8000).catch(() => {});
  },
  openUrl(url) {
    if (OmniNative.available) {
      OmniNative.request("open.url", JSON.stringify({ url }), 8000).catch(() => {});
    } else {
      window.open(url, "_blank");
    }
  },
  // IP 기반 대략적 현위치 (정확도 도시 단위) — 두 서비스 순차 시도
  async ipLocate() {
    try {
      const j = await OmniNet.json("https://ipwho.is/", 8000);
      if (j && j.success !== false && j.latitude) {
        return { lat: +j.latitude, lon: +j.longitude, name: [j.city, j.region].filter(Boolean).join(", ") };
      }
    } catch (e) { /* 다음 서비스 */ }
    try {
      const j = await OmniNet.json("https://get.geojs.io/v1/ip/geo.json", 8000);
      if (j && j.latitude) {
        return { lat: +j.latitude, lon: +j.longitude, name: [j.city, j.region].filter(Boolean).join(", ") };
      }
    } catch (e) { /* 실패 */ }
    return null;
  },
};

// ---------- module: WEATHER (Open-Meteo — 키 없음) ----------
OmniOS.register("weather", {
  // WMO 코드 → [한글 설명, 글리프 종류]
  WMO: {
    0: ["맑음", "clear"], 1: ["대체로 맑음", "clear"], 2: ["구름 조금", "partly"], 3: ["흐림", "cloudy"],
    45: ["안개", "fog"], 48: ["짙은 안개", "fog"],
    51: ["약한 이슬비", "rain"], 53: ["이슬비", "rain"], 55: ["강한 이슬비", "rain"],
    56: ["어는 이슬비", "rain"], 57: ["강한 어는 이슬비", "rain"],
    61: ["약한 비", "rain"], 63: ["비", "rain"], 65: ["강한 비", "rain"],
    66: ["어는 비", "rain"], 67: ["강한 어는 비", "rain"],
    71: ["약한 눈", "snow"], 73: ["눈", "snow"], 75: ["폭설", "snow"], 77: ["싸락눈", "snow"],
    80: ["소나기", "rain"], 81: ["소나기", "rain"], 82: ["강한 소나기", "rain"],
    85: ["소낙눈", "snow"], 86: ["강한 소낙눈", "snow"],
    95: ["뇌우", "storm"], 96: ["뇌우·우박", "storm"], 99: ["강한 뇌우·우박", "storm"],
  },
  // 단색 기하 글리프 (stroke = currentColor)
  GLYPH: {
    clear: '<circle cx="32" cy="32" r="11"/><g stroke-linecap="round">' +
      '<line x1="32" y1="6" x2="32" y2="13"/><line x1="32" y1="51" x2="32" y2="58"/>' +
      '<line x1="6" y1="32" x2="13" y2="32"/><line x1="51" y1="32" x2="58" y2="32"/>' +
      '<line x1="13.6" y1="13.6" x2="18.6" y2="18.6"/><line x1="45.4" y1="45.4" x2="50.4" y2="50.4"/>' +
      '<line x1="13.6" y1="50.4" x2="18.6" y2="45.4"/><line x1="45.4" y1="18.6" x2="50.4" y2="13.6"/></g>',
    partly: '<circle cx="24" cy="24" r="9"/><g stroke-linecap="round"><line x1="24" y1="8" x2="24" y2="12"/>' +
      '<line x1="8" y1="24" x2="12" y2="24"/><line x1="12.7" y1="12.7" x2="15.5" y2="15.5"/><line x1="35.3" y1="12.7" x2="32.5" y2="15.5"/></g>' +
      '<path d="M22 50h24a8 8 0 0 0 1-15.9A11 11 0 0 0 26 32a8 8 0 0 0-4 18z"/>',
    cloudy: '<path d="M18 48h28a9 9 0 0 0 1.5-17.9A13 13 0 0 0 22.5 26 9.5 9.5 0 0 0 18 48z"/>',
    fog: '<path d="M18 38h28a9 9 0 0 0 1.5-17.9A13 13 0 0 0 22.5 16 9.5 9.5 0 0 0 18 38z"/>' +
      '<g stroke-linecap="round"><line x1="14" y1="46" x2="50" y2="46"/><line x1="20" y1="54" x2="44" y2="54"/></g>',
    rain: '<path d="M18 40h28a9 9 0 0 0 1.5-17.9A13 13 0 0 0 22.5 18 9.5 9.5 0 0 0 18 40z"/>' +
      '<g stroke-linecap="round"><line x1="24" y1="46" x2="21" y2="54"/><line x1="33" y1="46" x2="30" y2="54"/><line x1="42" y1="46" x2="39" y2="54"/></g>',
    snow: '<path d="M18 40h28a9 9 0 0 0 1.5-17.9A13 13 0 0 0 22.5 18 9.5 9.5 0 0 0 18 40z"/>' +
      '<g stroke-linecap="round"><line x1="24" y1="46" x2="24" y2="54"/><line x1="20.5" y1="48" x2="27.5" y2="52"/><line x1="27.5" y1="48" x2="20.5" y2="52"/>' +
      '<line x1="40" y1="46" x2="40" y2="54"/><line x1="36.5" y1="48" x2="43.5" y2="52"/><line x1="43.5" y1="48" x2="36.5" y2="52"/></g>',
    storm: '<path d="M18 38h28a9 9 0 0 0 1.5-17.9A13 13 0 0 0 22.5 16 9.5 9.5 0 0 0 18 38z"/>' +
      '<polyline points="34,40 28,50 34,50 29,60" stroke-linejoin="round"/>',
  },
  loc: null,     // {name, lat, lon}
  data: null,
  _at: 0,
  _busy: false,

  init() {
    const $ = (id) => document.getElementById(id);
    this.els = {
      loc: $("wx-loc"), search: $("wx-search"), here: $("wx-here"), updated: $("wx-updated"),
      refresh: $("wx-refresh"), err: $("wx-err"), glyph: $("wx-glyph"), temp: $("wx-temp"),
      cond: $("wx-cond"), feels: $("wx-feels"), hum: $("wx-hum"), wind: $("wx-wind"),
      rain: $("wx-rain"), hourly: $("wx-hourly"), daily: $("wx-daily"),
    };
    try { this.loc = JSON.parse(localStorage.getItem("omni.wx.loc") || "null"); } catch (e) { this.loc = null; }
    this.els.search.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && this.els.search.value.trim()) {
        this.setCity(this.els.search.value.trim());
        this.els.search.value = "";
      }
    });
    this.els.here.addEventListener("click", () => this.locateHere());
    this.els.refresh.addEventListener("click", () => this.refresh());
    document.addEventListener("omni:panel", (e) => {
      if (e.detail === "weather") {
        if (Date.now() - this._at > 10 * 60000) this.refresh();
        else this.drawHourly();
      }
    });
    window.addEventListener("resize", () => this.drawHourly());
    setInterval(() => { if (this.data) this.refresh(); }, 15 * 60000);
    // 첫 로드: 저장된 위치 → 없으면 IP 위치 → 서울
    setTimeout(() => this.refresh(), 1500);
  },

  locName() { return this.loc ? this.loc.name : "—"; },

  glyphSvg(kind, size) {
    return `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.4"${size ? ` width="${size}" height="${size}"` : ""}>${this.GLYPH[kind] || this.GLYPH.cloudy}</svg>`;
  },

  describe(code) { return this.WMO[code] || ["알 수 없음", "cloudy"]; },

  async locateHere() {
    this.setErr("");
    const p = await OmniNet.ipLocate();
    if (!p) { this.setErr("현위치를 알 수 없습니다 — 도시를 검색하십시오"); return false; }
    this.loc = { name: p.name || "현위치", lat: p.lat, lon: p.lon };
    localStorage.setItem("omni.wx.loc", JSON.stringify(this.loc));
    await this.refresh();
    return true;
  },

  setCoords(lat, lon, name) {
    this.loc = { name: name || `${lat.toFixed(3)}, ${lon.toFixed(3)}`, lat, lon };
    localStorage.setItem("omni.wx.loc", JSON.stringify(this.loc));
    return this.refresh();
  },

  async setCity(q) {
    this.setErr("");
    try {
      const j = await OmniNet.json(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=ko&format=json`);
      const rs = (j && j.results) || [];
      if (!rs.length) { this.setErr(`도시를 찾지 못했습니다: ${q}`); return false; }
      // 동명 지명은 인구가 가장 많은 곳 우선
      rs.sort((a, b) => (b.population || 0) - (a.population || 0));
      const r = rs[0];
      this.loc = { name: [r.name, r.admin1, r.country_code !== "KR" ? r.country : ""].filter(Boolean).join(", "),
        lat: r.latitude, lon: r.longitude };
      localStorage.setItem("omni.wx.loc", JSON.stringify(this.loc));
      await this.refresh();
      return true;
    } catch (e) {
      this.setErr(`검색 실패: ${e.message}`);
      return false;
    }
  },

  setErr(msg) {
    this.els.err.textContent = msg;
    this.els.err.hidden = !msg;
  },

  async refresh() {
    if (this._busy) return this.data;
    this._busy = true;
    try {
      if (!this.loc) {
        const p = await OmniNet.ipLocate();
        this.loc = p ? { name: p.name || "현위치", lat: p.lat, lon: p.lon }
          : { name: "Seoul", lat: 37.5665, lon: 126.978 };
        localStorage.setItem("omni.wx.loc", JSON.stringify(this.loc));
      }
      this.els.loc.textContent = this.loc.name.toUpperCase();
      const url = "https://api.open-meteo.com/v1/forecast"
        + `?latitude=${this.loc.lat}&longitude=${this.loc.lon}`
        + "&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation"
        + "&hourly=temperature_2m,precipitation_probability,weather_code"
        + "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"
        + "&timezone=auto&forecast_days=7";
      this.data = await OmniNet.json(url);
      this._at = Date.now();
      this.setErr("");
      this.render();
    } catch (e) {
      this.setErr(`날씨 조회 실패: ${e.message}`);
    } finally {
      this._busy = false;
    }
    return this.data;
  },

  render() {
    const d = this.data;
    if (!d || !d.current) return;
    const c = d.current;
    const [txt, kind] = this.describe(c.weather_code);
    this.els.glyph.innerHTML = this.glyphSvg(kind);
    this.els.glyph.style.color = "var(--cyan)";
    this.els.temp.textContent = `${Math.round(c.temperature_2m)}°`;
    this.els.cond.textContent = txt.toUpperCase();
    this.els.feels.textContent = `${Math.round(c.apparent_temperature)}°`;
    this.els.hum.textContent = `${c.relative_humidity_2m}%`;
    this.els.wind.textContent = `${Math.round(c.wind_speed_10m)} km/h`;
    this.els.rain.textContent = `${(c.precipitation || 0).toFixed(1)} mm`;
    const t = new Date();
    this.els.updated.textContent = `UPDATED ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    this.renderDaily();
    this.drawHourly();
    OmniNet.haloExport("weather", { loc: this.loc.name, summary: this.summary() });
  },

  // 현재 시각 이후 24시간 슬라이스
  hourlySlice() {
    const d = this.data;
    if (!d || !d.hourly) return null;
    const now = d.current.time.slice(0, 13);
    let i = d.hourly.time.findIndex((x) => x.slice(0, 13) >= now);
    if (i < 0) i = 0;
    return {
      time: d.hourly.time.slice(i, i + 24),
      temp: d.hourly.temperature_2m.slice(i, i + 24),
      pop: d.hourly.precipitation_probability.slice(i, i + 24),
    };
  },

  drawHourly() {
    const h = this.hourlySlice();
    const cv = this.els.hourly;
    if (!h || !cv || !cv.offsetWidth) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.offsetWidth, H = 120;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    const padL = 30, padR = 12, padT = 16, padB = 22;
    const n = h.temp.length;
    const x = (i) => padL + (i / (n - 1)) * (W - padL - padR);
    let min = Math.min(...h.temp), max = Math.max(...h.temp);
    if (max - min < 4) { max += 2; min -= 2; }
    const y = (v) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
    const css = getComputedStyle(document.documentElement);
    const cyan = css.getPropertyValue("--cyan").trim() || "#35d6ff";
    const blue = css.getPropertyValue("--blue").trim() || "#2f7bff";
    const dim = css.getPropertyValue("--text-dim").trim() || "#6fa8c9";
    // 강수확률 막대
    const bw = Math.max(2, (W - padL - padR) / n * 0.5);
    for (let i = 0; i < n; i++) {
      const p = h.pop[i] || 0;
      if (!p) continue;
      const bh = (p / 100) * (H - padT - padB);
      ctx.fillStyle = `rgba(47, 123, 255, ${0.15 + p / 250})`;
      ctx.fillRect(x(i) - bw / 2, H - padB - bh, bw, bh);
    }
    // 격자 + 온도 라벨
    ctx.strokeStyle = "rgba(53, 214, 255, 0.12)"; ctx.lineWidth = 1;
    ctx.fillStyle = dim; ctx.font = "9px 'Share Tech Mono', monospace"; ctx.textAlign = "right";
    for (let k = 0; k <= 2; k++) {
      const v = min + (max - min) * (k / 2);
      const yy = y(v);
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
      ctx.fillText(`${Math.round(v)}°`, padL - 6, yy + 3);
    }
    // 온도 라인 (글로우)
    ctx.strokeStyle = cyan; ctx.lineWidth = 2; ctx.shadowColor = cyan; ctx.shadowBlur = 8;
    ctx.beginPath();
    h.temp.forEach((v, i) => { if (i === 0) ctx.moveTo(x(i), y(v)); else ctx.lineTo(x(i), y(v)); });
    ctx.stroke();
    ctx.shadowBlur = 0;
    // 시각 라벨 (3시간 간격)
    ctx.fillStyle = dim; ctx.textAlign = "center";
    for (let i = 0; i < n; i += 3) {
      ctx.fillText(`${h.time[i].slice(11, 13)}h`, x(i), H - 6);
    }
    // 현재 온도 포인트
    ctx.fillStyle = cyan;
    ctx.beginPath(); ctx.arc(x(0), y(h.temp[0]), 3, 0, Math.PI * 2); ctx.fill();
    void blue;
  },

  renderDaily() {
    const d = this.data;
    const el = this.els.daily;
    el.textContent = "";
    if (!d || !d.daily) return;
    const DAY = ["일", "월", "화", "수", "목", "금", "토"];
    d.daily.time.forEach((t, i) => {
      const date = new Date(`${t}T00:00:00`);
      const label = i === 0 ? "오늘" : i === 1 ? "내일" : `${DAY[date.getDay()]}요일`;
      const [txt, kind] = this.describe(d.daily.weather_code[i]);
      const row = document.createElement("div");
      row.className = "wx-day";
      row.innerHTML = `<span class="d">${label} <span style="color:var(--text-dim)">${t.slice(5).replace("-", "/")}</span></span>`
        + `<span class="g" style="color:var(--cyan)">${this.glyphSvg(kind)}</span>`
        + `<span class="c">${txt}</span>`
        + `<span class="r">${d.daily.precipitation_probability_max[i] ?? 0}% RAIN</span>`
        + `<span class="t">${Math.round(d.daily.temperature_2m_max[i])}° <span class="lo">/ ${Math.round(d.daily.temperature_2m_min[i])}°</span></span>`;
      el.appendChild(row);
    });
  },

  // AI 도구용 요약 텍스트
  summary() {
    const d = this.data;
    if (!d || !d.current) return "";
    const c = d.current;
    const lines = [
      `위치: ${this.loc.name} (${c.time.replace("T", " ")} 기준)`,
      `현재: ${Math.round(c.temperature_2m)}°C ${this.describe(c.weather_code)[0]}, 체감 ${Math.round(c.apparent_temperature)}°C, 습도 ${c.relative_humidity_2m}%, 바람 ${Math.round(c.wind_speed_10m)}km/h, 강수 ${(c.precipitation || 0).toFixed(1)}mm`,
    ];
    const h = this.hourlySlice();
    if (h) {
      const maxPop = Math.max(...h.pop.map((p) => p || 0));
      const peak = h.pop.indexOf(maxPop);
      lines.push(`24시간: 최고 ${Math.round(Math.max(...h.temp))}° / 최저 ${Math.round(Math.min(...h.temp))}°, 최대 강수확률 ${maxPop}%${maxPop ? ` (${h.time[peak].slice(11, 16)}경)` : ""}`);
    }
    const D = ["일", "월", "화", "수", "목", "금", "토"];
    d.daily.time.forEach((t, i) => {
      const name = i === 0 ? "오늘" : i === 1 ? "내일" : `${t.slice(5)}(${D[new Date(`${t}T00:00:00`).getDay()]})`;
      lines.push(`${name}: ${this.describe(d.daily.weather_code[i])[0]}, ${Math.round(d.daily.temperature_2m_max[i])}°/${Math.round(d.daily.temperature_2m_min[i])}°, 강수확률 ${d.daily.precipitation_probability_max[i] ?? 0}%`);
    });
    return lines.join("\n");
  },
});

// ---------- module: NEWS (RSS 헤드라인 — 키 없음) ----------
OmniOS.register("news", {
  BASE: "https://news.google.com/rss",
  SUFFIX: "hl=ko&gl=KR&ceid=KR:ko",
  CATS: {
    top: "", world: "headlines/section/topic/WORLD", business: "headlines/section/topic/BUSINESS",
    tech: "headlines/section/topic/TECHNOLOGY", science: "headlines/section/topic/SCIENCE",
    sports: "headlines/section/topic/SPORTS",
  },
  LABELS: { top: "주요", world: "세계", business: "경제", tech: "IT/과학", science: "과학", sports: "스포츠" },
  cat: "top",
  query: "",
  items: [],
  _at: 0,

  init() {
    const $ = (id) => document.getElementById(id);
    this.els = { sub: $("nw-sub"), search: $("nw-search"), updated: $("nw-updated"),
      refresh: $("nw-refresh"), tabs: $("nw-tabs"), list: $("nw-list") };
    this.els.tabs.querySelectorAll(".ig-tab").forEach((b) =>
      b.addEventListener("click", () => this.load(b.dataset.cat)));
    this.els.search.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && this.els.search.value.trim()) {
        this.search(this.els.search.value.trim());
        this.els.search.value = "";
      }
    });
    this.els.refresh.addEventListener("click", () => this.reload());
    document.addEventListener("omni:panel", (e) => {
      if (e.detail === "news" && Date.now() - this._at > 10 * 60000) this.reload();
    });
    setInterval(() => { if (this._at) this.reload(); }, 15 * 60000);
  },

  url(cat) {
    const p = this.CATS[cat] || "";
    return p ? `${this.BASE}/${p}?${this.SUFFIX}` : `${this.BASE}?${this.SUFFIX}`;
  },

  reload() { return this.query ? this.search(this.query) : this.load(this.cat); },
  refresh() { return this.reload(); },

  async load(cat) {
    if (!this.CATS.hasOwnProperty(cat)) cat = "top";
    this.cat = cat; this.query = "";
    this.els.tabs.querySelectorAll(".ig-tab").forEach((b) => b.classList.toggle("active", b.dataset.cat === cat));
    this.els.sub.textContent = `${this.LABELS[cat].toUpperCase()} · KR`;
    return this.fetch(this.url(cat));
  },

  async search(q) {
    this.query = q;
    this.els.tabs.querySelectorAll(".ig-tab").forEach((b) => b.classList.remove("active"));
    this.els.sub.textContent = `SEARCH · ${q}`;
    return this.fetch(`${this.BASE}/search?q=${encodeURIComponent(q)}&${this.SUFFIX}`);
  },

  async fetch(url) {
    this.els.list.innerHTML = '<div class="nf-empty">LOADING&hellip;</div>';
    try {
      const xml = await OmniNet.get(url, 20000);
      this.items = this.parse(xml);
      this._at = Date.now();
      const t = new Date();
      this.els.updated.textContent = `UPDATED ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
      this.render();
      OmniNet.haloExport("news", { cat: this.cat, query: this.query,
        items: this.items.slice(0, 12).map((i) => ({ title: i.title, source: i.source, ts: i.ts })) });
    } catch (e) {
      this.items = [];
      this.els.list.innerHTML = "";
      const err = document.createElement("div");
      err.className = "nf-err";
      err.textContent = OmniNative.available ? `뉴스 조회 실패: ${e.message}` : "브라우저 개발 모드 — 뉴스는 앱에서만 조회됩니다 (CORS)";
      this.els.list.appendChild(err);
    }
    return this.items;
  },

  decode(s) {
    return String(s || "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
      .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
  },

  // RSS 2.0 <item> 파서 (정규식 — DOMParser 없이 노드에서도 검증 가능)
  parse(xml) {
    const out = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    const pick = (s, tag) => {
      const r = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i").exec(s);
      return r ? r[1] : "";
    };
    while ((m = re.exec(xml)) && out.length < 60) {
      const it = m[1];
      let title = this.decode(pick(it, "title"));
      const link = this.decode(pick(it, "link"));
      const source = this.decode(pick(it, "source"));
      const pub = pick(it, "pubDate");
      if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
      const ts = pub ? Date.parse(pub) / 1000 : 0;
      if (title && link) out.push({ title, link, source, ts });
    }
    return out;
  },

  fmtTime(ts) {
    if (!ts) return "--:--";
    const d = new Date(ts * 1000);
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return d.toDateString() === new Date().toDateString()
      ? hm : `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
  },

  render() {
    const el = this.els.list;
    el.textContent = "";
    if (!this.items.length) {
      el.innerHTML = '<div class="nf-empty">NO HEADLINES</div>';
      return;
    }
    const fresh = Date.now() / 1000 - 2 * 3600;
    for (const it of this.items) {
      const row = document.createElement("div");
      row.className = `nw-item${it.ts > fresh ? " fresh" : ""}`;
      row.title = "클릭하면 기사 열기";
      row.addEventListener("click", () => OmniNet.openUrl(it.link));
      const t = document.createElement("span"); t.className = "t"; t.textContent = this.fmtTime(it.ts);
      const s = document.createElement("span"); s.className = "s"; s.textContent = it.source || "—";
      const h = document.createElement("span"); h.className = "h"; h.textContent = it.title;
      row.append(t, s, h);
      el.appendChild(row);
    }
  },
});

// ---------- module: MAP (지도 타일 + 장소 검색) ----------
OmniOS.register("map", {
  // 키 없는 OSM 표준 타일 — CSS 반전 필터(.leaflet-tile-pane)로 다크 블루 톤을 만든다
  TILES: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  _map: null,
  _pin: null,
  _here: null,
  _pinLL: null,

  init() {
    const $ = (id) => document.getElementById(id);
    this.els = { coords: $("mp-coords"), search: $("mp-search"), locate: $("mp-locate"),
      weather: $("mp-weather"), canvas: $("mp-canvas"), hud: $("mp-hud") };
    this.els.search.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && this.els.search.value.trim()) {
        this.search(this.els.search.value.trim());
        this.els.search.value = "";
      }
    });
    this.els.locate.addEventListener("click", () => this.locate());
    this.els.weather.addEventListener("click", () => this.weatherHere());
    document.addEventListener("omni:panel", (e) => {
      if (e.detail === "map") {
        this.ensure();
        if (this._map) setTimeout(() => this._map.invalidateSize(), 50);
      }
    });
  },

  ensure() {
    if (this._map) return true;
    if (typeof window.L === "undefined") {
      this.els.hud.textContent = "지도 라이브러리 로드 실패";
      return false;
    }
    let view = { lat: 37.5665, lon: 126.978, z: 12 };
    try { view = { ...view, ...JSON.parse(localStorage.getItem("omni.map.view") || "{}") }; } catch (e) { /* 기본값 */ }
    this._map = L.map(this.els.canvas, { zoomControl: true, attributionControl: false })
      .setView([view.lat, view.lon], view.z);
    L.tileLayer(this.TILES, { maxZoom: 19 }).addTo(this._map);
    this._map.on("moveend", () => {
      const c = this._map.getCenter();
      localStorage.setItem("omni.map.view", JSON.stringify({ lat: c.lat, lon: c.lng, z: this._map.getZoom() }));
      this.els.coords.textContent = `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)} · Z${this._map.getZoom()}`;
    });
    this._map.on("click", (e) => this.setPin(e.latlng.lat, e.latlng.lng, `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`));
    this._map.fire("moveend");
    this.els.hud.textContent = "클릭: 핀 · 검색: 장소 이동 · LOCATE: IP 기반 현위치";
    return true;
  },

  setPin(lat, lon, label, cls) {
    if (!this.ensure()) return;
    const icon = L.divIcon({ className: "", html: `<div class="mp-pin${cls ? " " + cls : ""}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] });
    if (cls === "here") {
      if (this._here) this._here.remove();
      this._here = L.marker([lat, lon], { icon }).addTo(this._map).bindPopup(label);
    } else {
      if (this._pin) this._pin.remove();
      this._pin = L.marker([lat, lon], { icon }).addTo(this._map).bindPopup(label);
      this._pinLL = { lat, lon, label };
    }
    this.els.hud.textContent = label;
  },

  async search(q) {
    if (!this.ensure()) return null;
    this.els.hud.textContent = `SEARCHING · ${q}`;
    try {
      const j = await OmniNet.json(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&accept-language=ko`, 15000);
      const r = j && j[0];
      if (!r) { this.els.hud.textContent = `장소를 찾지 못했습니다: ${q}`; return null; }
      const lat = +r.lat, lon = +r.lon;
      const short = r.display_name.split(",").slice(0, 3).map((s) => s.trim()).join(", ");
      this._map.setView([lat, lon], 15);
      this.setPin(lat, lon, short);
      this._pin.openPopup();
      return short;
    } catch (e) {
      this.els.hud.textContent = `검색 실패: ${e.message}`;
      return null;
    }
  },

  async locate() {
    if (!this.ensure()) return;
    this.els.hud.textContent = "LOCATING…";
    const p = await OmniNet.ipLocate();
    if (!p) { this.els.hud.textContent = "현위치를 알 수 없습니다"; return; }
    this._map.setView([p.lat, p.lon], 12);
    this.setPin(p.lat, p.lon, `현위치(IP 추정) · ${p.name}`, "here");
  },

  async weatherHere() {
    const ll = this._pinLL || (this._map ? { lat: this._map.getCenter().lat, lon: this._map.getCenter().lng } : null);
    if (!ll) return;
    const btn = document.querySelector('.nav-item[data-panel="weather"]');
    if (btn) btn.click();
    await OmniOS.modules.weather.setCoords(ll.lat, ll.lon, ll.label);
  },
});

// ---------- module: MARKETS (환율 + 주식/지수/코인 — 키 없음) ----------
OmniOS.register("markets", {
  FX_URL: "https://open.er-api.com/v6/latest/USD",
  CHART: (sym, range, iv) => `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${iv}`,
  FX_PAIRS: [["USD", 1, "미국 달러"], ["JPY", 100, "일본 엔 (100)"], ["EUR", 1, "유로"], ["CNY", 1, "중국 위안"], ["GBP", 1, "영국 파운드"]],
  DEFAULT: ["^KS11", "^KQ11", "^GSPC", "^IXIC", "005930.KS", "AAPL", "NVDA", "BTC-USD"],
  NAMES: { "^KS11": "코스피", "^KQ11": "코스닥", "^GSPC": "S&P 500", "^IXIC": "나스닥", "005930.KS": "삼성전자",
    "000660.KS": "SK하이닉스", "035420.KS": "NAVER", "035720.KS": "카카오", "AAPL": "애플", "NVDA": "엔비디아",
    "TSLA": "테슬라", "MSFT": "마이크로소프트", "GOOGL": "알파벳", "AMZN": "아마존", "BTC-USD": "비트코인", "ETH-USD": "이더리움" },
  list: [],
  fx: null,
  quotes: {},
  _at: 0,
  _busy: false,

  init() {
    const $ = (id) => document.getElementById(id);
    this.els = { add: $("mk-add"), updated: $("mk-updated"), refresh: $("mk-refresh"), err: $("mk-err"),
      fx: $("mk-fx"), list: $("mk-list"), count: $("mk-count") };
    try { this.list = JSON.parse(localStorage.getItem("omni.mk.list") || "null") || this.DEFAULT.slice(); }
    catch (e) { this.list = this.DEFAULT.slice(); }
    this.els.add.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && this.els.add.value.trim()) {
        this.addSymbol(this.els.add.value.trim().toUpperCase());
        this.els.add.value = "";
      }
    });
    this.els.refresh.addEventListener("click", () => this.refresh());
    document.addEventListener("omni:panel", (e) => {
      if (e.detail === "markets" && Date.now() - this._at > 5 * 60000) this.refresh();
    });
    setInterval(() => { if (this._at) this.refresh(); }, 10 * 60000);
    setTimeout(() => this.refresh(), 2500);
  },

  save() { localStorage.setItem("omni.mk.list", JSON.stringify(this.list)); },

  async addSymbol(sym) {
    if (this.list.includes(sym)) return;
    const q = await this.quote(sym);
    if (!q) { this.setErr(`심볼을 찾지 못했습니다: ${sym}`); return; }
    this.setErr("");
    this.list.push(sym); this.save();
    this.quotes[sym] = q;
    this.renderList();
  },

  removeSymbol(sym) {
    this.list = this.list.filter((s) => s !== sym); this.save();
    delete this.quotes[sym];
    this.renderList();
  },

  setErr(msg) { this.els.err.textContent = msg; this.els.err.hidden = !msg; },

  // 단일 종목 시세 (+ 당일 스파크라인)
  async quote(sym) {
    try {
      const j = await OmniNet.json(this.CHART(sym, "1d", "5m"), 15000);
      const r = j && j.chart && j.chart.result && j.chart.result[0];
      if (!r || !r.meta) return null;
      const m = r.meta;
      const closes = ((r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || [])
        .filter((v) => typeof v === "number");
      const prev = m.chartPreviousClose ?? m.previousClose ?? (closes[0] || m.regularMarketPrice);
      const price = m.regularMarketPrice;
      return { sym, name: this.NAMES[sym] || m.shortName || m.longName || sym, price, prev,
        chg: prev ? ((price - prev) / prev) * 100 : 0, cur: m.currency || "", type: m.instrumentType || "",
        spark: closes.slice(-60), exch: m.exchangeName || "", t: m.regularMarketTime || 0 };
    } catch (e) {
      return null;
    }
  },

  async refresh() {
    if (this._busy) return;
    this._busy = true;
    try {
      const [fx, ...qs] = await Promise.all([
        OmniNet.json(this.FX_URL, 15000).catch(() => null),
        ...this.list.map((s) => this.quote(s)),
      ]);
      if (fx && fx.rates) this.fx = fx;
      qs.forEach((q, i) => { if (q) this.quotes[this.list[i]] = q; });
      this._at = Date.now();
      const t = new Date();
      this.els.updated.textContent = `UPDATED ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
      this.setErr(fx ? "" : (OmniNative.available ? "환율 조회 실패" : "브라우저 개발 모드 — 일부 시세는 앱에서만 조회됩니다 (CORS)"));
      this.render();
      OmniNet.haloExport("markets", { summary: this.summary() });
    } finally {
      this._busy = false;
    }
  },

  fmtNum(v, cur) {
    if (typeof v !== "number") return "—";
    const digits = cur === "KRW" || v >= 1000 ? 0 : 2;
    return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  },

  fmtQuote(q) {
    const sign = q.chg > 0 ? "+" : "";
    return `${q.name} (${q.sym}): ${this.fmtNum(q.price, q.cur)} ${q.cur} (${sign}${q.chg.toFixed(2)}%)`;
  },

  render() { this.renderFx(); this.renderList(); },

  renderFx() {
    const el = this.els.fx;
    el.textContent = "";
    if (!this.fx || !this.fx.rates) { el.innerHTML = '<div class="nf-empty">NO FX DATA</div>'; return; }
    const krw = this.fx.rates.KRW;
    for (const [code, unit, label] of this.FX_PAIRS) {
      const r = this.fx.rates[code];
      if (!r || !krw) continue;
      const v = (krw / r) * unit;
      const card = document.createElement("div");
      card.className = "mk-fxcard";
      card.innerHTML = `<div class="p">${label}</div><div class="v">${v.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}<small>KRW</small></div>`;
      el.appendChild(card);
    }
    const upd = new Date((this.fx.time_last_update_unix || 0) * 1000);
    this.els.fx.title = `기준 ${upd.toLocaleString("ko-KR")}`;
  },

  renderList() {
    const el = this.els.list;
    el.textContent = "";
    this.els.count.textContent = String(this.list.length);
    if (!this.list.length) { el.innerHTML = '<div class="nf-empty">WATCHLIST EMPTY — 위에 심볼을 추가하십시오</div>'; return; }
    for (const sym of this.list) {
      const q = this.quotes[sym];
      const row = document.createElement("div");
      row.className = "mk-row";
      const cls = !q ? "flat" : q.chg > 0.005 ? "up" : q.chg < -0.005 ? "down" : "flat";
      const sign = q && q.chg > 0 ? "+" : "";
      row.innerHTML = `<div class="n"><span class="nm">${q ? q.name : sym}</span><span class="sy">${sym}</span></div>`
        + `<canvas class="sp"></canvas>`
        + `<span class="px">${q ? this.fmtNum(q.price, q.cur) : "—"}</span>`
        + `<span class="ch ${cls}">${q ? `${sign}${q.chg.toFixed(2)}%` : "—"}</span>`
        + `<span class="mk">${q ? q.cur : ""}</span>`
        + `<button class="rm" title="제거">&#10005;</button>`;
      row.querySelector(".rm").addEventListener("click", () => this.removeSymbol(sym));
      el.appendChild(row);
      if (q && q.spark.length > 1) this.drawSpark(row.querySelector("canvas"), q.spark, cls);
    }
  },

  drawSpark(cv, data, cls) {
    const dpr = window.devicePixelRatio || 1;
    const W = cv.offsetWidth || 120, H = 26;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext("2d");
    ctx.scale(dpr, dpr);
    const min = Math.min(...data), max = Math.max(...data);
    const span = max - min || 1;
    const css = getComputedStyle(document.documentElement);
    const color = cls === "up" ? css.getPropertyValue("--alert").trim() : cls === "down" ? css.getPropertyValue("--blue").trim() : css.getPropertyValue("--text-dim").trim();
    ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.shadowColor = color; ctx.shadowBlur = 4;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (data.length - 1)) * W;
      const y = 3 + (1 - (v - min) / span) * (H - 6);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  },

  summary() {
    const lines = [];
    if (this.fx && this.fx.rates) {
      const krw = this.fx.rates.KRW;
      lines.push("환율(원화): " + this.FX_PAIRS.map(([c, u, l]) => {
        const r = this.fx.rates[c];
        return r ? `${l} ${((krw / r) * u).toFixed(2)}원` : null;
      }).filter(Boolean).join(", "));
    }
    for (const sym of this.list) {
      const q = this.quotes[sym];
      if (q) lines.push(this.fmtQuote(q));
    }
    return lines.join("\n");
  },
});

// ---------- module: CALENDAR (맥 캘린더 — EventKit) ----------
OmniOS.register("calendar", {
  items: [],
  _at: 0,
  _err: null,
  DAYS: 14,

  init() {
    const $ = (id) => document.getElementById(id);
    this.els = { next: $("cl-next"), updated: $("cl-updated"), refresh: $("cl-refresh"), err: $("cl-err"),
      days: $("cl-days"), title: $("cl-title"), date: $("cl-date"), time: $("cl-time"), dur: $("cl-dur"), addbtn: $("cl-addbtn") };
    this.els.refresh.addEventListener("click", () => this.refresh());
    this.els.addbtn.addEventListener("click", () => this.quickAdd());
    this.els.title.addEventListener("keydown", (e) => { if (e.key === "Enter") this.quickAdd(); });
    const today = new Date();
    this.els.date.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    document.addEventListener("omni:panel", (e) => {
      if (e.detail === "calendar" && Date.now() - this._at > 2 * 60000) this.refresh();
    });
    if (OmniNative.available) {
      setTimeout(() => this.refresh(), 4000);
      setInterval(() => this.refresh(), 5 * 60000);
      setInterval(() => this.renderNext(), 30000);
    } else {
      this.els.days.innerHTML = '<div class="nf-err">브라우저 개발 모드 — 캘린더는 앱에서만 조회됩니다</div>';
    }
  },

  async refresh(days) {
    if (!OmniNative.available) return null;
    const n = days || this.DAYS;
    let r = null;
    try {
      r = await OmniNative.request("cal.events", JSON.stringify({ days: n }), 20000);
    } catch (e) { r = { ok: false, error: e.message }; }
    if (!r || !r.ok) {
      this._err = (r && r.error) === "CAL_DENIED"
        ? "캘린더 접근 권한 필요 — 시스템 설정 > 개인정보 보호 및 보안 > 캘린더에서 Omni OS를 허용한 뒤 REFRESH"
        : `조회 실패: ${(r && r.error) || "unknown"}`;
      this.render();
      return r;
    }
    this._err = null;
    this.items = (r.items || []).slice();
    this._at = Date.now();
    const t = new Date();
    this.els.updated.textContent = `UPDATED ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    this.render();
    // 안경 브리지용: 앞으로 3일치
    const lim = Date.now() / 1000 + 3 * 86400;
    OmniNet.haloExport("calendar", { items: this.items.filter((i) => i.start < lim).slice(0, 40)
      .map((i) => ({ id: i.id, title: i.title, start: i.start, end: i.end, allDay: i.allDay, calendar: i.calendar })) });
    return r;
  },

  // 'YYYY-MM-DD HH:mm' | 'YYYY-MM-DD' | ISO → {start(초), end(초), allDay}
  parseWhen(startStr, minutes) {
    const s = String(startStr || "").trim().replace("T", " ");
    const mDate = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(s);
    if (!mDate) {
      const d = new Date(s);
      if (isNaN(d)) return null;
      return { start: d.getTime() / 1000, end: d.getTime() / 1000 + (minutes || 60) * 60, allDay: false };
    }
    const [, Y, M, D, h, mi] = mDate;
    if (h === undefined) {
      const d = new Date(+Y, +M - 1, +D, 0, 0, 0);
      return { start: d.getTime() / 1000, end: d.getTime() / 1000 + 86400, allDay: true };
    }
    const d = new Date(+Y, +M - 1, +D, +h, +mi, 0);
    return { start: d.getTime() / 1000, end: d.getTime() / 1000 + (minutes || 60) * 60, allDay: false };
  },

  async add(input) {
    if (!OmniNative.available) return { ok: false, msg: "앱에서만 가능" };
    const title = String(input.title || "").trim();
    if (!title) return { ok: false, msg: "제목 없음" };
    const w = this.parseWhen(input.start, Number(input.minutes) || 60);
    if (!w) return { ok: false, msg: `시각을 해석하지 못했습니다: ${input.start}` };
    let r = null;
    try {
      r = await OmniNative.request("cal.add", JSON.stringify({
        title, start: w.start, end: w.end, allDay: w.allDay,
        location: input.location || "", notes: input.notes || "", calendar: input.calendar || "",
      }), 20000);
    } catch (e) { r = { ok: false, error: e.message }; }
    if (!r || !r.ok) {
      return { ok: false, msg: (r && r.error) === "CAL_DENIED" ? "캘린더 접근 권한 필요" : `추가 실패: ${(r && r.error) || "unknown"}` };
    }
    await this.refresh();
    const d = new Date(w.start * 1000);
    const when = w.allDay ? `${d.getMonth() + 1}/${d.getDate()} 종일`
      : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return { ok: true, msg: `${title} · ${when} (${r.calendar || "기본 캘린더"})`, id: r.id };
  },

  async quickAdd() {
    const title = this.els.title.value.trim();
    if (!title) { this.els.title.focus(); return; }
    const start = this.els.time.value ? `${this.els.date.value} ${this.els.time.value}` : this.els.date.value;
    const r = await this.add({ title, start, minutes: Number(this.els.dur.value) || 60 });
    if (r.ok) { this.els.title.value = ""; this.els.time.value = ""; this.setErr(""); }
    else this.setErr(r.msg);
  },

  async remove(id) {
    try {
      const r = await OmniNative.request("cal.remove", JSON.stringify({ id }), 15000);
      if (r && r.ok) await this.refresh(); else this.setErr(`삭제 실패: ${(r && r.error) || "unknown"}`);
    } catch (e) { this.setErr(`삭제 실패: ${e.message}`); }
  },

  setErr(msg) { this.els.err.textContent = msg; this.els.err.hidden = !msg; },

  fmtHM(ts) {
    const d = new Date(ts * 1000);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  },

  renderNext() {
    const now = Date.now() / 1000;
    const nx = this.items.find((i) => !i.allDay && i.start > now);
    if (!nx) { this.els.next.textContent = this._err ? "—" : "NO UPCOMING TIMED EVENT"; return; }
    const mins = Math.round((nx.start - now) / 60);
    const rel = mins < 60 ? `${mins}분 후` : mins < 1440 ? `${Math.floor(mins / 60)}시간 ${mins % 60}분 후` : `${Math.floor(mins / 1440)}일 후`;
    this.els.next.textContent = `NEXT · ${nx.title} · ${rel}`;
  },

  render() {
    this.setErr(this._err || "");
    const el = this.els.days;
    el.textContent = "";
    this.renderNext();
    if (!this.items.length) {
      el.innerHTML = `<div class="nf-empty">${this._err ? "" : "NO EVENTS IN THE NEXT " + this.DAYS + " DAYS"}</div>`;
      return;
    }
    const DAY = ["일", "월", "화", "수", "목", "금", "토"];
    const now = Date.now() / 1000;
    const todayKey = new Date().toDateString();
    const groups = new Map();
    for (const it of this.items) {
      const d = new Date(it.start * 1000);
      const key = d.toDateString();
      if (!groups.has(key)) groups.set(key, { d, items: [] });
      groups.get(key).items.push(it);
    }
    for (const [key, g] of groups) {
      const day = document.createElement("div");
      day.className = `cl-day${key === todayKey ? " today" : ""}`;
      const label = key === todayKey ? "오늘" : key === new Date(Date.now() + 86400000).toDateString() ? "내일" : "";
      day.innerHTML = `<div class="h"><span>${g.d.getMonth() + 1}/${g.d.getDate()} ${DAY[g.d.getDay()]}</span><span>${label}</span><span class="cnt">${g.items.length}</span></div>`;
      for (const it of g.items) {
        const row = document.createElement("div");
        const past = it.end < now, cur = it.start <= now && it.end > now;
        row.className = `cl-ev${past ? " past" : ""}${cur ? " now" : ""}`;
        row.innerHTML = `<span class="t">${it.allDay ? "종일" : `${this.fmtHM(it.start)} – ${this.fmtHM(it.end)}`}</span>`
          + `<span class="dot" style="color:${it.color};background:${it.color}"></span>`
          + `<span class="ti"></span><span class="cal"></span>`;
        const ti = row.querySelector(".ti");
        ti.textContent = it.title;
        if (it.location) { const sm = document.createElement("small"); sm.textContent = it.location; ti.appendChild(sm); }
        const cal = row.querySelector(".cal");
        cal.textContent = it.calendar.toUpperCase();
        const rm = document.createElement("button");
        rm.className = "rm"; rm.title = "삭제"; rm.innerHTML = "&#10005;";
        rm.addEventListener("click", (e) => { e.stopPropagation(); if (confirm(`삭제: ${it.title}?`)) this.remove(it.id); });
        cal.appendChild(rm);
        day.appendChild(row);
      }
      el.appendChild(day);
    }
  },

  // AI 도구용 — 시작·종료 시각을 모두 넣는다 (종료를 안 주면 모델이 추정해 지어냄)
  summary(days) {
    const lim = Date.now() / 1000 + (days || 7) * 86400;
    const now = Date.now() / 1000;
    const DAY = ["일", "월", "화", "수", "목", "금", "토"];
    const today = new Date().toDateString();
    const tomorrow = new Date(Date.now() + 86400000).toDateString();
    const list = this.items.filter((i) => i.start < lim && i.end > now - 60).slice(0, 40);
    if (!list.length) return "";
    const head = `기준 현재 시각 ${new Date().toLocaleString("ko-KR", { hour12: false })} · 아래는 캘린더 원본 그대로 (시작–종료). 여기 없는 시각은 추정하지 말 것.`;
    return head + "\n" + list.map((i) => {
      const d = new Date(i.start * 1000);
      const key = d.toDateString();
      const label = key === today ? "오늘" : key === tomorrow ? "내일" : `${DAY[d.getDay()]}요일`;
      const mins = Math.round((i.end - i.start) / 60);
      const when = i.allDay ? "종일"
        : `${this.fmtHM(i.start)}–${this.fmtHM(i.end)} (${mins >= 60 ? `${Math.floor(mins / 60)}시간${mins % 60 ? ` ${mins % 60}분` : ""}` : `${mins}분`})`;
      const state = !i.allDay && i.start <= now && i.end > now ? " [진행 중]" : "";
      return `[${label} ${d.getMonth() + 1}/${d.getDate()} ${when}] ${i.title}${i.location ? ` @${i.location}` : ""} (${i.calendar})${state}`;
    }).join("\n");
  },
});

// ---------------- SMART CONTROL — Tapo 플러그·전구 로컬 제어 (scripts/omni_smart.py) ----------------
// 옴니 전권: smart_control 도구 / smart.on|off|toggle|timer|scan|list 액션 / app_ui. 안경: halo_smart 스냅샷.
OmniOS.register("smart", {
  devices: [],
  timers: {},          // host → { at, action, alias, handle }
  _at: 0,
  _busy: false,
  _status: null,

  init() {
    const $ = (id) => document.getElementById(id);
    this.els = { sub: $("sc-sub"), updated: $("sc-updated"), refresh: $("sc-refresh"), scan: $("sc-scan"), err: $("sc-err"),
      hint: $("sc-hint"), setup: $("sc-setup"), setupToggle: $("sc-setup-toggle"), user: $("sc-user"), pass: $("sc-pass"),
      save: $("sc-save"), setupState: $("sc-setup-state"), grid: $("sc-grid"), ip: $("sc-ip"), addip: $("sc-addip") };
    this.els.refresh.addEventListener("click", () => this.refresh());
    this.els.scan.addEventListener("click", () => this.scan());
    this.els.save.addEventListener("click", () => this.saveCreds());
    this.els.addip.addEventListener("click", () => this.addByIp());
    this.els.ip.addEventListener("keydown", (e) => { if (e.key === "Enter") this.addByIp(); });
    this.els.pass.addEventListener("keydown", (e) => { if (e.key === "Enter") this.saveCreds(); });
    this.els.setupToggle.addEventListener("click", () => { this.els.setup.hidden = !this.els.setup.hidden; });
    this.els.grid.addEventListener("click", (e) => this.onGridClick(e));
    this.els.grid.addEventListener("change", (e) => this.onGridChange(e));
    document.addEventListener("omni:panel", async (e) => {
      if (e.detail !== "smart") return;
      await this.status();
      if (this._status.hasCreds && Date.now() - this._at > 60000) this.refresh();
    });
    if (OmniNative.available) {
      setTimeout(async () => { await this.status(); if (this._status.hasCreds && this._status.count) this.refresh(); }, 7000);
      setInterval(() => { if (this._status && this._status.hasCreds && this.devices.length) this.refresh(); }, 3 * 60000);
    } else {
      this.els.grid.innerHTML = '<div class="nf-err">브라우저 개발 모드 — 스마트 기기는 앱에서만 제어됩니다</div>';
      this.els.setup.hidden = false;
    }
    setInterval(() => this.renderTimers(), 1000);
  },

  async status() {
    const r = OmniNative.available ? await OmniNative.request("smart.status", null, 8000).catch(() => null) : null;
    this._status = r && r.ok ? r : { hasCreds: false, count: 0, known: [], engine: false };
    const s = this._status;
    this.els.setupState.textContent = s.hasCreds ? `저장됨 · ${s.username}` : "계정 미저장";
    this.els.setupState.className = `sc-setup-state${s.hasCreds ? " ok" : ""}`;
    this.els.sub.textContent = s.hasCreds ? `TAPO · ${s.count}개 기기` : "TAPO 계정 필요 — SETUP";
    if (!s.hasCreds) { this.els.setup.hidden = false; if (!this.devices.length) this.els.grid.innerHTML = '<div class="nf-empty">SETUP에서 Tapo 계정을 저장한 뒤 SCAN</div>'; }
    if (OmniNative.available && !s.engine) this.setErr("smart_engine/venv가 없습니다 — 터미널: python3 -m venv smart_engine/venv && smart_engine/venv/bin/pip install python-kasa");
    return s;
  },

  async saveCreds() {
    const username = this.els.user.value.trim(), password = this.els.pass.value;
    if (!username || !password) { this.setErr("이메일과 비밀번호를 모두 입력"); return; }
    const r = await OmniNative.request("smart.setup", JSON.stringify({ username, password }), 8000).catch(() => null);
    if (!r || !r.ok) { this.setErr("계정 저장 실패"); return; }
    this.els.pass.value = "";
    this.setErr("");
    this.devices = [];
    await this.status();
    this.scan();
  },

  async addByIp() {
    const host = this.els.ip.value.trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) { this.setErr("IP 형식이 아닙니다 (예: 192.168.0.31)"); return; }
    if (this._busy) return;
    this._busy = true;
    this.els.addip.textContent = "ADDING…";
    try {
      const r = await this.run("add", { host });
      if (r.ok && r.devices && r.devices.length) {
        // 기존 목록에 합치기
        for (const d of r.devices) { const i = this.devices.findIndex((x) => x.host === d.host); if (i >= 0) this.devices[i] = d; else this.devices.push(d); }
        r.devices = this.devices;
        this.els.ip.value = "";
      }
      this.apply(r, true);
    } finally { this._busy = false; this.els.addip.textContent = "ADD BY IP"; }
  },

  setErr(msg) { this.els.err.hidden = !msg; this.els.err.textContent = msg || ""; },
  setHint(msg) { this.els.hint.hidden = !msg; this.els.hint.textContent = msg || ""; },

  async run(cmd, args) {
    if (!OmniNative.available) return { ok: false, error: "앱에서만 가능" };
    const r = await OmniNative.request("smart.run", JSON.stringify({ cmd, args: args || {} }), 50000).catch((e) => ({ ok: false, error: e.message }));
    return r || { ok: false, error: "응답 없음" };
  },

  async scan() {
    if (this._busy) return null;
    this._busy = true;
    this.els.scan.textContent = "SCANNING…";
    this.setHint("같은 와이파이에서 Tapo 기기를 찾는 중 (약 8초)…");
    try {
      const r = await this.run("discover");
      this.apply(r, true);
      return r;
    } finally {
      this._busy = false;
      this.els.scan.textContent = "SCAN";
    }
  },

  async refresh() {
    if (this._busy) return null;
    this._busy = true;
    try {
      const r = await this.run("states");
      this.apply(r, false);
      return r;
    } finally { this._busy = false; }
  },

  apply(r, fromScan) {
    if (!r) return;
    if (r.ok && Array.isArray(r.devices)) {
      this.devices = r.devices;
      this._at = Date.now();
      const t = new Date();
      this.els.updated.textContent = `UPDATED ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
      this.els.sub.textContent = `TAPO · ${this.devices.length}개 기기${this.devices.filter((d) => d.on).length ? ` · ${this.devices.filter((d) => d.on).length}개 켜짐` : ""}`;
      this.setErr("");
      const errs = (r.errors || []).map((e) => `${e.model || e.host}: ${e.error}`).join(" / ");
      this.setHint([r.hint || "", errs].filter(Boolean).join(" · "));
      if (fromScan && this.devices.length) { this.els.setup.hidden = true; if (this._status) this._status.count = this.devices.length; }
    } else {
      this.setErr(`${r.error || "오류"}${r.hint ? ` — ${r.hint}` : ""}`);
      if (r.error === "NO_CREDS") this.els.setup.hidden = false;
    }
    this.render();
    OmniNet.haloExport("smart", { devices: this.devices.map((d) => ({ alias: d.alias, model: d.model, host: d.host, on: !!d.on,
      brightness: d.brightness, power_w: d.power_w, offline: !!d.offline })) });
  },

  // 이름·모델·IP로 기기 찾기 (부분 일치, 대소문자 무시)
  find(name) {
    const n = String(name || "").trim().toLowerCase();
    if (!n) return this.devices.length === 1 ? this.devices[0] : null;
    return this.devices.find((d) => (d.alias || "").toLowerCase() === n)
      || this.devices.find((d) => (d.alias || "").toLowerCase().includes(n) || (d.model || "").toLowerCase().includes(n) || d.host === n)
      || null;
  },

  label(d) { return d.alias || d.model || d.host; },
  fmt(d) {
    if (d.offline) return `${this.label(d)} (${d.model}): 오프라인`;
    const extra = [d.brightness != null ? `밝기 ${d.brightness}%` : "", d.power_w != null ? `${Number(d.power_w).toFixed(1)}W` : ""].filter(Boolean).join(", ");
    const tm = this.timers[d.host];
    return `${this.label(d)} (${d.model}): ${d.on ? "켜짐" : "꺼짐"}${extra ? ` · ${extra}` : ""}${tm ? ` · ${Math.max(0, Math.ceil((tm.at - Date.now()) / 60000))}분 뒤 ${tm.action === "on" ? "켜짐" : "꺼짐"} 예약` : ""}`;
  },

  // AI 도구용 요약
  summary() {
    if (!this.devices.length) return "";
    return this.devices.map((d) => this.fmt(d)).join("\n");
  },

  // 옴니·안경·패널 공통 제어 진입점 → {ok, msg}
  async control(input) {
    const action = String(input.action || "status").toLowerCase();
    if (!OmniNative.available) return { ok: false, msg: "앱에서만 가능" };
    if (action === "scan") {
      const r = await this.scan();
      if (!r || !r.ok) return { ok: false, msg: `${(r && r.error) || "검색 실패"}${r && r.hint ? ` — ${r.hint}` : ""}` };
      return { ok: true, msg: this.devices.length ? `기기 ${this.devices.length}개:\n${this.summary()}` : (r.hint || "기기를 찾지 못했습니다") };
    }
    if (action === "list" || action === "status") {
      if (!this.devices.length || Date.now() - this._at > 20000) await this.refresh();
      if (!this.devices.length) {
        const s = await this.status();
        return { ok: false, msg: s.hasCreds ? "등록된 스마트 기기가 없습니다. 사용자에게 안내하라: SMART CONTROL 패널에서 SCAN을 누르거나 Tapo 앱에서 플러그를 먼저 설정해 주십시오." : "Tapo 계정이 아직 저장되지 않았습니다. 사용자에게 안내하라: SMART CONTROL 패널 SETUP에서 Tapo 계정 이메일·비밀번호를 저장해 주십시오." };
      }
      if (input.device) { const d = this.find(input.device); return d ? { ok: true, msg: this.fmt(d) } : { ok: false, msg: `기기를 찾지 못함: ${input.device}. 있는 기기: ${this.devices.map((x) => this.label(x)).join(", ")}` }; }
      return { ok: true, msg: this.summary() };
    }
    if (!this.devices.length) await this.refresh();
    const d = this.find(input.device);
    if (!d) {
      return { ok: false, msg: this.devices.length ? `기기를 찾지 못함: ${input.device || "(이름 없음)"}. 있는 기기: ${this.devices.map((x) => this.label(x)).join(", ")}` : "등록된 스마트 기기가 없습니다 — SMART CONTROL 패널에서 SCAN" };
    }
    if (action === "timer") {
      const min = Number(input.minutes);
      if (!(min > 0)) return { ok: false, msg: "분 단위 시간이 필요합니다" };
      const act = input.timer_action === "on" || input.then === "on" ? "on" : "off";
      this.setTimer(d, min, act);
      return { ok: true, msg: `${this.label(d)}: ${min}분 뒤 ${act === "on" ? "켜기" : "끄기"} 예약됨` };
    }
    if (action === "cancel_timer") {
      this.clearTimer(d.host);
      return { ok: true, msg: `${this.label(d)}: 예약 취소` };
    }
    let r;
    if (action === "on" || action === "off" || action === "toggle") r = await this.run(action, { target: d.host });
    else if (action === "brightness" || action === "color_temp" || action === "hsv") {
      const args = { target: d.host };
      if (action === "brightness") args.brightness = Number(input.brightness ?? input.value);
      if (action === "color_temp") args.color_temp = Number(input.color_temp ?? input.value);
      if (action === "hsv") args.hsv = input.hsv;
      r = await this.run("set", args);
    } else return { ok: false, msg: `알 수 없는 동작: ${action}` };
    if (!r.ok) return { ok: false, msg: `${r.error || "실패"}${r.hint ? ` — ${r.hint}` : ""}` };
    if (r.device) {
      const i = this.devices.findIndex((x) => x.host === r.device.host);
      if (i >= 0) this.devices[i] = r.device; else this.devices.push(r.device);
      this._at = Date.now();
      this.render();
      OmniMem.append("action", `스마트 제어: ${this.label(r.device)} ${action}${input.brightness != null ? ` ${input.brightness}%` : ""} → ${r.device.on ? "켜짐" : "꺼짐"}`);
      OmniNet.haloExport("smart", { devices: this.devices.map((x) => ({ alias: x.alias, model: x.model, host: x.host, on: !!x.on, brightness: x.brightness, power_w: x.power_w, offline: !!x.offline })) });
      return { ok: true, msg: this.fmt(r.device) };
    }
    return { ok: true, msg: "완료" };
  },

  setTimer(d, minutes, action) {
    this.clearTimer(d.host);
    const at = Date.now() + minutes * 60000;
    const handle = setTimeout(async () => {
      delete this.timers[d.host];
      const r = await this.control({ device: d.host, action });
      const ai = OmniOS.modules.ai;
      if (ai) ai.logLine("sys", `[스마트] 예약 실행 · ${this.label(d)} ${action === "on" ? "켜짐" : "꺼짐"} · ${r.msg}`).classList.add("ignored");
      this.render();
    }, minutes * 60000);
    this.timers[d.host] = { at, action, alias: this.label(d), handle };
    this.render();
  },
  clearTimer(host) {
    if (this.timers[host]) { clearTimeout(this.timers[host].handle); delete this.timers[host]; }
  },

  render() {
    const g = this.els.grid;
    if (!this.devices.length) {
      g.innerHTML = `<div class="nf-empty">${this._status && this._status.hasCreds ? "기기 없음 — SCAN으로 같은 와이파이의 Tapo 기기를 찾습니다" : "SETUP에서 Tapo 계정을 저장한 뒤 SCAN"}</div>`;
      return;
    }
    g.innerHTML = "";
    for (const d of this.devices) {
      const card = document.createElement("div");
      card.className = `sc-card${d.on ? " on" : ""}${d.offline ? " offline" : ""}`;
      card.dataset.host = d.host;
      const meta = [d.model, d.host, d.power_w != null ? `${Number(d.power_w).toFixed(1)} W` : "", d.today_kwh != null ? `오늘 ${Number(d.today_kwh).toFixed(2)} kWh` : ""].filter(Boolean).join(" · ");
      card.innerHTML = `
        <div class="sc-name">${this.esc(this.label(d))}</div>
        <div class="sc-meta">${this.esc(meta)}</div>
        <div class="sc-state">${d.offline ? "OFFLINE" : d.on ? "ON" : "OFF"}</div>
        <div class="sc-btns">
          <button class="nf-btn sc-on${d.on ? " active" : ""}" data-act="on">ON</button>
          <button class="nf-btn sc-off${!d.on && !d.offline ? " active" : ""}" data-act="off">OFF</button>
        </div>
        ${d.brightness != null ? `<div class="sc-brow"><span>밝기</span><input type="range" class="sc-bright" min="1" max="100" value="${Number(d.brightness)}" title="밝기"><span class="sc-bval">${Number(d.brightness)}%</span></div>` : ""}
        <div class="sc-timer">
          <input class="wx-search sc-min" type="number" min="1" step="5" value="30" placeholder="분" title="분">
          <button class="nf-btn" data-act="timer-off">OFF IN N MIN</button>
          <button class="nf-btn" data-act="timer-on">ON IN N MIN</button>
          <span class="sc-countdown"></span>
        </div>`;
      g.appendChild(card);
    }
    this.renderTimers();
  },

  renderTimers() {
    for (const card of this.els.grid.querySelectorAll(".sc-card")) {
      const tm = this.timers[card.dataset.host];
      const el = card.querySelector(".sc-countdown");
      if (!el) continue;
      if (!tm) { el.textContent = ""; continue; }
      const s = Math.max(0, Math.round((tm.at - Date.now()) / 1000));
      el.textContent = `${tm.action === "on" ? "ON" : "OFF"} IN ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} · 취소는 다시 누르기`;
    }
  },

  async onGridClick(e) {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const card = btn.closest(".sc-card");
    const d = this.devices.find((x) => x.host === card.dataset.host);
    if (!d) return;
    const act = btn.dataset.act;
    if (act === "timer-off" || act === "timer-on") {
      if (this.timers[d.host]) { this.clearTimer(d.host); this.render(); return; }
      const min = Number(card.querySelector(".sc-min").value) || 30;
      this.setTimer(d, min, act === "timer-on" ? "on" : "off");
      return;
    }
    btn.disabled = true;
    const r = await this.control({ device: d.host, action: act });
    btn.disabled = false;
    if (!r.ok) this.setErr(r.msg);
  },

  async onGridChange(e) {
    const inp = e.target.closest(".sc-bright");
    if (!inp) return;
    const card = inp.closest(".sc-card");
    const r = await this.control({ device: card.dataset.host, action: "brightness", brightness: Number(inp.value) });
    if (!r.ok) this.setErr(r.msg);
  },

  esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); },
});
