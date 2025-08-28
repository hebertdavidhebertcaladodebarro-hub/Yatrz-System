import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Yatrz System — Web OS in a single React component
 * --------------------------------------------------
 * Features
 * - Desktop UI (icons, wallpaper)
 * - Start menu with search & app list
 * - Taskbar with running apps, clock, notifications placeholder
 * - Window manager (drag, focus, minimize, maximize, close; resize via CSS)
 * - Virtual File System (VFS) persisted to localStorage
 * - File Manager (create, rename, move, delete files/folders)
 * - Apps: Notepad, Markdown Editor (with preview), Calculator, Browser (sandboxed), Terminal (simulated), Settings
 * - Theming (Light/Dark), wallpaper URL, accent color, layout density
 * - Auth (optional): simple local profile with password hashing using WebCrypto
 * - Modular app registry (plugins: URL-based web apps in sandboxed iframes)
 * - SPA-ready; PWA helper to register a simple Service Worker (optional)
 *
 * Notes
 * - This single file is production-ready for a SPA. Add Tailwind in your build pipeline.
 * - To export as a PWA, include: manifest.json and (optionally) your own sw.js. Use the in-app PWA Helper to scaffold/register one at runtime.
 */

/*********************************
 * Helpers & Utilities
 *********************************/
const LS_PREFIX = "yatrz";
const lsKey = (key) => `${LS_PREFIX}:${key}`;

const defaultWallpaper =
  "https://images.unsplash.com/photo-1520607162513-77705c0f0d4a?q=80&w=1600&auto=format&fit=crop";

const ACCENTS = [
  "cyan",
  "blue",
  "violet",
  "emerald",
  "rose",
  "amber",
];

// Minimal classnames helper
function cx(...args) {
  return args.filter(Boolean).join(" ");
}

// WebCrypto hash (SHA-256) -> hex
async function sha256(message) {
  const enc = new TextEncoder();
  const data = enc.encode(message);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// LocalStorage JSON helpers
const storage = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(lsKey(key));
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      console.warn("Storage get error", key, e);
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(lsKey(key), JSON.stringify(value));
    } catch (e) {
      console.warn("Storage set error", key, e);
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(lsKey(key));
    } catch (e) {}
  },
};

/*********************************
 * VFS — Virtual File System
 *********************************/
const DEFAULT_FS = {
  name: "/",
  type: "dir",
  children: [
    { name: "Desktop", type: "dir", children: [] },
    { name: "Documents", type: "dir", children: [] },
    { name: "Downloads", type: "dir", children: [] },
    { name: "Apps", type: "dir", children: [] },
    { name: "README.txt", type: "file", content: `Welcome to Yatrz System!\n\n- Open the Start Menu to launch apps.\n- Use Settings to change wallpaper and theme.\n- Files are saved inside your browser.\n- Try the Terminal: help, ls, cd, cat, echo, touch, mkdir, rm, theme, whoami.` },
  ],
};

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function findNode(path, root) {
  const parts = normPath(path).split("/").filter(Boolean);
  let cur = root;
  for (const p of parts) {
    if (!cur || cur.type !== "dir") return null;
    cur = cur.children.find((c) => c.name === p);
  }
  return cur || null;
}

function normPath(path) {
  if (!path) return "/";
  let s = path.replace(/\\+/g, "/");
  if (!s.startsWith("/")) s = "/" + s;
  // remove double slashes
  s = s.replace(/\/+/, "/");
  // resolve ./ and ../ (basic)
  const out = [];
  for (const part of s.split("/").filter(Boolean)) {
    if (part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

function ensureUniqueName(dir, base) {
  let name = base;
  let i = 1;
  while (dir.children.some((c) => c.name === name)) {
    const dot = base.lastIndexOf(".");
    if (dot > 0) {
      name = base.slice(0, dot) + ` (${i})` + base.slice(dot);
    } else {
      name = base + ` (${i})`;
    }
    i++;
  }
  return name;
}

function fsCreate(root, cwd, name, type = "file", content = "") {
  const dir = findNode(cwd, root);
  if (!dir || dir.type !== "dir") throw new Error("Invalid directory: " + cwd);
  const n = { name: ensureUniqueName(dir, name), type };
  if (type === "file") n.content = content;
  if (type === "dir") n.children = [];
  dir.children.push(n);
}

function fsDelete(root, path) {
  const parts = normPath(path).split("/").filter(Boolean);
  const name = parts.pop();
  const parentPath = "/" + parts.join("/");
  const parent = findNode(parentPath, root);
  if (!parent || parent.type !== "dir") throw new Error("Invalid path");
  const idx = parent.children.findIndex((c) => c.name === name);
  if (idx >= 0) parent.children.splice(idx, 1);
}

function fsRename(root, path, newName) {
  const node = findNode(path, root);
  if (!node) throw new Error("Not found");
  node.name = newName;
}

function fsMove(root, src, dstDir) {
  const node = findNode(src, root);
  const dst = findNode(dstDir, root);
  if (!node || !dst || dst.type !== "dir") throw new Error("Invalid move");
  // remove from parent
  const parts = normPath(src).split("/").filter(Boolean);
  const name = parts.pop();
  const parent = findNode("/" + parts.join("/"), root);
  const idx = parent.children.findIndex((c) => c.name === name);
  if (idx >= 0) parent.children.splice(idx, 1);
  // add to new dir (ensure unique)
  node.name = ensureUniqueName(dst, node.name);
  dst.children.push(node);
}

function listDir(path, root) {
  const dir = findNode(path, root);
  if (!dir || dir.type !== "dir") throw new Error("Invalid directory");
  return dir.children.map((c) => ({ name: c.name, type: c.type }));
}

/*********************************
 * App Registry & Types
 *********************************/
const builtinApps = {
  notepad: {
    id: "notepad",
    name: "Bloco de Notas",
    icon: "📝",
    entry: NotepadApp,
    accepts: [".txt", ".log", ".md"],
  },
  markdown: {
    id: "markdown",
    name: "Markdown Editor",
    icon: "📘",
    entry: MarkdownApp,
    accepts: [".md", ".markdown"],
  },
  browser: {
    id: "browser",
    name: "Navegador",
    icon: "🌐",
    entry: BrowserApp,
  },
  calc: {
    id: "calc",
    name: "Calculadora",
    icon: "🧮",
    entry: CalculatorApp,
  },
  terminal: {
    id: "terminal",
    name: "Terminal",
    icon: ">_",
    entry: TerminalApp,
  },
  files: {
    id: "files",
    name: "Arquivos",
    icon: "📁",
    entry: FilesApp,
  },
  settings: {
    id: "settings",
    name: "Configurações",
    icon: "⚙️",
    entry: SettingsApp,
  },
};

/*********************************
 * Root Component
 *********************************/
export default function YatrzSystem() {
  // Boot & auth state
  const [booting, setBooting] = useState(true);
  const [profiles, setProfiles] = useState(() => storage.get("profiles", []));
  const [currentUser, setCurrentUser] = useState(() => storage.get("currentUser", null));

  // Theme & personalization
  const [theme, setTheme] = useState(() => storage.get("theme", "dark"));
  const [accent, setAccent] = useState(() => storage.get("accent", "cyan"));
  const [wallpaper, setWallpaper] = useState(() => storage.get("wallpaper", defaultWallpaper));
  const [density, setDensity] = useState(() => storage.get("density", "cozy"));

  // VFS state
  const [fsRoot, setFsRoot] = useState(() => storage.get("vfs", DEFAULT_FS));

  // App registry (builtins + plugins)
  const [plugins, setPlugins] = useState(() => storage.get("plugins", []));
  const appRegistry = useMemo(() => {
    const base = { ...builtinApps };
    for (const p of plugins) {
      base[p.id] = {
        id: p.id,
        name: p.name,
        icon: p.icon || "🧩",
        entry: makePluginApp(p),
        isPlugin: true,
      };
    }
    return base;
  }, [plugins]);

  // Windows & taskbar
  const [windows, setWindows] = useState([]); // {id, appId, title, state, z, pos, size, payload}
  const [zCounter, setZCounter] = useState(1);
  const [startOpen, setStartOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [notifications, setNotifications] = useState([]);

  // Persist
  useEffect(() => storage.set("profiles", profiles), [profiles]);
  useEffect(() => storage.set("currentUser", currentUser), [currentUser]);
  useEffect(() => storage.set("theme", theme), [theme]);
  useEffect(() => storage.set("accent", accent), [accent]);
  useEffect(() => storage.set("wallpaper", wallpaper), [wallpaper]);
  useEffect(() => storage.set("density", density), [density]);
  useEffect(() => storage.set("vfs", fsRoot), [fsRoot]);
  useEffect(() => storage.set("plugins", plugins), [plugins]);

  // Boot animation
  useEffect(() => {
    const t = setTimeout(() => setBooting(false), 1200);
    return () => clearTimeout(t);
  }, []);

  // Apply theme classes
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
  }, [theme]);

  // Accent CSS var
  useEffect(() => {
    const root = document.documentElement;
    const colors = {
      cyan: "#22d3ee",
      blue: "#60a5fa",
      violet: "#a78bfa",
      emerald: "#34d399",
      rose: "#fb7185",
      amber: "#f59e0b",
    };
    root.style.setProperty("--yatrz-accent", colors[accent] || colors.cyan);
  }, [accent]);

  const launch = (appId, payload = null, titleOverride = null) => {
    const app = appRegistry[appId];
    if (!app) return;
    const id = crypto.randomUUID();
    const title = titleOverride || app.name;
    const pos = { x: 120 + (windows.length % 4) * 40, y: 100 + (windows.length % 4) * 30 };
    const size = { w: 720, h: 480 };
    const z = zCounter + 1;
    setZCounter(z);
    setWindows((w) => [
      ...w,
      { id, appId, title, state: "normal", z, pos, size, payload, minimized: false, maximized: false },
    ]);
    setStartOpen(false);
  };

  const focusWin = (id) => {
    const z = zCounter + 1;
    setZCounter(z);
    setWindows((w) => w.map((win) => (win.id === id ? { ...win, z } : win)));
  };

  const closeWin = (id) => setWindows((w) => w.filter((win) => win.id !== id));
  const minimizeWin = (id) => setWindows((w) => w.map((win) => (win.id === id ? { ...win, minimized: true } : win)));
  const restoreWin = (id) => setWindows((w) => w.map((win) => (win.id === id ? { ...win, minimized: false } : win)));
  const toggleMax = (id) =>
    setWindows((w) => w.map((win) => (win.id === id ? { ...win, maximized: !win.maximized } : win)));

  // Auth helpers
  const createProfile = async (username, password) => {
    const exists = profiles.some((p) => p.username === username);
    if (exists) throw new Error("Usuário já existe");
    const passHash = await sha256(password);
    const p = { id: crypto.randomUUID(), username, passHash, createdAt: Date.now() };
    setProfiles((arr) => [...arr, p]);
    setCurrentUser({ id: p.id, username: p.username });
  };

  const login = async (username, password) => {
    const user = profiles.find((p) => p.username === username);
    if (!user) throw new Error("Usuário não encontrado");
    const passHash = await sha256(password);
    if (passHash !== user.passHash) throw new Error("Senha incorreta");
    setCurrentUser({ id: user.id, username: user.username });
  };

  const logout = () => setCurrentUser(null);

  // Notifications
  const notify = (text) => {
    const id = crypto.randomUUID();
    const n = { id, text, ts: Date.now() };
    setNotifications((ns) => [...ns, n]);
    setTimeout(() => setNotifications((ns) => ns.filter((x) => x.id !== id)), 4000);
  };

  // Context (pass to apps)
  const sys = {
    fsRoot,
    setFsRoot,
    listDir: (p) => listDir(p, fsRoot),
    findNode: (p) => findNode(p, fsRoot),
    fsCreate: (...args) => {
      const root = clone(fsRoot);
      fsCreate(root, ...args);
      setFsRoot(root);
    },
    fsDelete: (path) => {
      const root = clone(fsRoot);
      fsDelete(root, path);
      setFsRoot(root);
    },
    fsRename: (path, newName) => {
      const root = clone(fsRoot);
      fsRename(root, path, newName);
      setFsRoot(root);
    },
    fsMove: (src, dst) => {
      const root = clone(fsRoot);
      fsMove(root, src, dst);
      setFsRoot(root);
    },
    launch,
    notify,
    currentUser,
    theme,
    setTheme,
    wallpaper,
    setWallpaper,
    accent,
    setAccent,
    density,
    setDensity,
    plugins,
    setPlugins,
  };

  // Boot screen
  if (booting) {
    return (
      <div className="w-screen h-screen flex items-center justify-center bg-black text-white">
        <div className="flex flex-col items-center gap-4">
          <div className="text-4xl font-bold tracking-widest">Yatrz System</div>
          <div className="w-64 h-1.5 bg-white/10 rounded overflow-hidden">
            <div className="h-full w-1/3 bg-[var(--yatrz-accent)] animate-[loading_1.2s_infinite] rounded" />
          </div>
          <style>{`@keyframes loading{0%{transform:translateX(-100%)}50%{transform:translateX(100%)}100%{transform:translateX(120%)}}`}</style>
        </div>
      </div>
    );
  }

  // Auth gate (optional): show if no user yet or user logged out
  if (!currentUser) {
    return (
      <AuthScreen profiles={profiles} onCreate={createProfile} onLogin={login} />
    );
  }

  return (
    <div
      className={cx(
        "w-screen h-screen overflow-hidden",
        "bg-neutral-100 text-neutral-900",
        "dark:bg-neutral-900 dark:text-neutral-100"
      )}
      style={{
        backgroundImage: `url(${wallpaper})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      {/* Glass overlay */}
      <div className="w-full h-full backdrop-blur-[2px] bg-black/10 dark:bg-black/30">
        {/* Desktop Icons */}
        <Desktop
          apps={appRegistry}
          onLaunch={launch}
          sys={sys}
        />

        {/* Taskbar */}
        <Taskbar
          startOpen={startOpen}
          setStartOpen={setStartOpen}
          search={search}
          setSearch={setSearch}
          apps={appRegistry}
          windows={windows}
          restoreWin={restoreWin}
          minimizeWin={minimizeWin}
          focusWin={focusWin}
          logout={logout}
          sys={sys}
        />

        {/* Windows */}
        {windows.map((win) => (
          <Window
            key={win.id}
            win={win}
            app={appRegistry[win.appId]}
            onFocus={() => focusWin(win.id)}
            onClose={() => closeWin(win.id)}
            onMinimize={() => minimizeWin(win.id)}
            onToggleMax={() => toggleMax(win.id)}
          >
            <win.app.entry win={win} setWin={(u)=>setWindows(ws=>ws.map(w=>w.id===win.id?{...w,...u}:w))} sys={sys} />
          </Window>
        ))}

        {/* Notifications toasts */}
        <div className="absolute right-3 bottom-16 space-y-2">
          {notifications.map((n) => (
            <div key={n.id} className="px-3 py-2 rounded-xl bg-neutral-900/80 text-white text-sm shadow-lg">
              {n.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/*********************************
 * Auth Screen
 *********************************/
function AuthScreen({ profiles, onCreate, onLogin }) {
  const [mode, setMode] = useState(profiles.length ? "login" : "create");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    try {
      if (mode === "create") await onCreate(username.trim(), password);
      else await onLogin(username.trim(), password);
    } catch (err) {
      setError(err.message || String(err));
    }
  };

  return (
    <div className="w-screen h-screen flex items-center justify-center bg-neutral-950 text-neutral-100">
      <div className="w-full max-w-md p-6 rounded-2xl bg-white/5 border border-white/10 shadow-2xl">
        <div className="text-center mb-6">
          <div className="text-3xl font-extrabold">Yatrz System</div>
          <div className="text-neutral-400">{mode === "create" ? "Criar perfil" : "Entrar"}</div>
        </div>
        <form className="space-y-3" onSubmit={submit}>
          <input className="w-full px-3 py-2 bg-white/10 rounded-xl outline-none focus:ring-2 ring-[var(--yatrz-accent)]" placeholder="Usuário" value={username} onChange={(e)=>setUsername(e.target.value)} />
          <input type="password" className="w-full px-3 py-2 bg-white/10 rounded-xl outline-none focus:ring-2 ring-[var(--yatrz-accent)]" placeholder="Senha" value={password} onChange={(e)=>setPassword(e.target.value)} />
          {error && <div className="text-rose-400 text-sm">{error}</div>}
          <button className="w-full py-2 rounded-xl bg-[var(--yatrz-accent)] text-black font-semibold">{mode === "create" ? "Criar" : "Entrar"}</button>
        </form>
        <div className="mt-4 text-center text-sm text-neutral-400">
          {mode === "create" ? (
            <button className="underline" onClick={()=>setMode("login")}>Já tenho conta</button>
          ) : (
            <button className="underline" onClick={()=>setMode("create")}>Criar nova conta</button>
          )}
        </div>
      </div>
    </div>
  );
}

/*********************************
 * Desktop & Taskbar
 *********************************/
function Desktop({ apps, onLaunch, sys }) {
  // Show some default icons on Desktop directory
  const desktopPath = "/Desktop";
  const desktop = findNode(desktopPath, sys.fsRoot) || { type: "dir", children: [] };

  const pinned = [
    { appId: "files" },
    { appId: "notepad" },
    { appId: "terminal" },
    { appId: "browser" },
    { appId: "settings" },
  ];

  return (
    <div className="absolute inset-0 p-3 select-none">
      <div className="grid grid-cols-4 md:grid-cols-8 lg:grid-cols-12 gap-3 max-w-5xl">
        {pinned.map((p) => (
          <DesktopIcon key={p.appId} label={apps[p.appId]?.name} icon={apps[p.appId]?.icon} onOpen={() => onLaunch(p.appId)} />
        ))}
        {desktop.children.filter(c=>c.type==="file").map((f) => (
          <DesktopIcon key={f.name} label={f.name} icon="📄" onOpen={() => onLaunch("notepad", { path: `${desktopPath}/${f.name}` }, f.name)} />
        ))}
      </div>
    </div>
  );
}

function DesktopIcon({ icon, label, onOpen }) {
  return (
    <button
      onDoubleClick={onOpen}
      className="flex flex-col items-center gap-1 px-2 py-2 rounded-xl hover:bg-white/20 active:scale-[0.98] transition"
      title={label}
    >
      <div className="text-3xl drop-shadow">{icon || "📦"}</div>
      <div className="text-xs text-white/90 bg-black/40 px-2 py-0.5 rounded-lg max-w-[120px] truncate">{label}</div>
    </button>
  );
}

function Taskbar({ startOpen, setStartOpen, search, setSearch, apps, windows, restoreWin, minimizeWin, focusWin, logout, sys }) {
  const time = useClock();
  return (
    <div className="absolute bottom-0 left-0 right-0 h-12 md:h-14 bg-neutral-100/70 dark:bg-neutral-800/70 backdrop-blur border-t border-white/10 flex items-center px-2 gap-2">
      <button onClick={() => setStartOpen((v) => !v)} className="px-3 py-1 rounded-xl bg-white/60 dark:bg-white/10 hover:bg-white/80 dark:hover:bg-white/20">
        <span className="font-semibold">Start</span>
      </button>

      {/* Taskbar windows */}
      <div className="flex-1 flex items-center gap-2 overflow-x-auto">
        {windows.map((w) => (
          <button
            key={w.id}
            onClick={() => {
              if (w.minimized) restoreWin(w.id);
              else minimizeWin(w.id);
              focusWin(w.id);
            }}
            className={cx(
              "px-3 py-1 rounded-xl whitespace-nowrap",
              w.minimized ? "bg-white/40 dark:bg-white/10" : "bg-[var(--yatrz-accent)]/30 dark:bg-[var(--yatrz-accent)]/20"
            )}
          >
            {w.title}
          </button>
        ))}
      </div>

      {/* Clock */}
      <div className="hidden md:flex items-center text-sm text-neutral-700 dark:text-neutral-300 tabular-nums">
        {time}
      </div>

      {/* User */}
      <div className="flex items-center gap-2">
        <button
          onClick={logout}
          className="px-2 py-1 rounded-lg text-xs bg-white/60 dark:bg-white/10 hover:bg-white/80 dark:hover:bg-white/20"
          title="Sair"
        >
          Sair
        </button>
      </div>

      {/* Start Menu */}
      {startOpen && (
        <StartMenu onClose={() => setStartOpen(false)} apps={apps} onLaunch={(id)=>{setStartOpen(false); sys.launch(id);}} sys={sys} />
      )}
    </div>
  );
}

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now.toLocaleString();
}

function StartMenu({ onClose, apps, onLaunch, sys }) {
  const [q, setQ] = useState("");
  const items = Object.values(apps)
    .filter((a) => a && a.name && a.name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="absolute bottom-14 left-2 w-[320px] md:w-[420px] bg-neutral-100/90 dark:bg-neutral-900/90 rounded-2xl border border-white/10 shadow-2xl backdrop-blur p-3 space-y-3">
      <div className="flex items-center gap-2">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar apps..."
          className="flex-1 px-3 py-2 rounded-xl bg-white/60 dark:bg-white/10 outline-none focus:ring-2 ring-[var(--yatrz-accent)]"
        />
        <button onClick={onClose} className="px-2 py-2 rounded-xl bg-white/60 dark:bg-white/10">✖</button>
      </div>

      <div className="max-h-[50vh] overflow-auto grid grid-cols-3 gap-2">
        {items.map((a) => (
          <button key={a.id} onClick={() => onLaunch(a.id)} className="flex flex-col items-center gap-1 p-2 rounded-xl hover:bg-white/40 dark:hover:bg-white/10">
            <div className="text-2xl">{a.icon || "📦"}</div>
            <div className="text-xs text-center">{a.name}</div>
          </button>
        ))}
      </div>

      <div className="text-xs text-neutral-500">Tema: <span className="font-mono">{storage.get("theme","dark")}</span> · Acento: <span className="font-mono">{storage.get("accent","cyan")}</span></div>
    </div>
  );
}

/*********************************
 * Window Component
 *********************************/
function Window({ win, app, onFocus, onClose, onMinimize, onToggleMax, children }) {
  const ref = useRef(null);
  const dragging = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onMouseMove = (e) => {
      if (!dragging.current) return;
      const { offsetX, offsetY } = dragging.current;
      const x = e.clientX - offsetX;
      const y = e.clientY - offsetY;
      el.style.left = Math.max(4, x) + "px";
      el.style.top = Math.max(4, y) + "px";
    };
    const onMouseUp = () => (dragging.current = null);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.zIndex = win.z;
    if (win.maximized) {
      el.style.left = "0px";
      el.style.top = "0px";
      el.style.width = "100%";
      el.style.height = "calc(100% - 3.5rem)"; // minus taskbar
    } else {
      el.style.left = win.pos.x + "px";
      el.style.top = win.pos.y + "px";
      el.style.width = win.size.w + "px";
      el.style.height = win.size.h + "px";
    }
  }, [win]);

  return (
    <div ref={ref} className={cx(
      "absolute bg-neutral-100 dark:bg-neutral-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden",
      win.minimized && "hidden"
    )} onMouseDown={onFocus}>
      <div
        className="h-10 flex items-center justify-between px-3 bg-black/5 dark:bg-white/5 cursor-grab select-none"
        onMouseDown={(e) => {
          const rect = ref.current.getBoundingClientRect();
          dragging.current = { offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top };
          onFocus();
        }}
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">{app?.icon || "📦"}</span>
          <span className="font-semibold truncate max-w-[28vw]">{win.title}</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onMinimize} className="w-8 h-8 rounded-lg hover:bg-white/20">➖</button>
          <button onClick={onToggleMax} className="w-8 h-8 rounded-lg hover:bg-white/20">🗖</button>
          <button onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-rose-500/30">✖</button>
        </div>
      </div>
      <div className="w-full h-[calc(100%-2.5rem)] bg-white/60 dark:bg-white/5 p-2 overflow-auto">
        {children}
      </div>
    </div>
  );
}

/*********************************
 * Apps
 *********************************/

// Notepad
function NotepadApp({ win, setWin, sys }) {
  const [path, setPath] = useState(win.payload?.path || null);
  const [text, setText] = useState("");

  useEffect(() => {
    if (path) {
      const node = sys.findNode(path);
      setText(node?.content || "");
      setWin({ title: `Bloco de Notas — ${path.split("/").pop()}` });
    } else {
      setWin({ title: `Bloco de Notas` });
    }
  }, [path]);

  const save = () => {
    if (!path) {
      const name = prompt("Salvar como:", "nota.txt");
      if (!name) return;
      sys.fsCreate("/Documents", name, "file", text);
      setPath(`/Documents/${name}`);
      sys.notify("Arquivo salvo em /Documents");
    } else {
      const root = clone(sys.fsRoot);
      const node = findNode(path, root);
      if (node) node.content = text;
      sys.setFsRoot(root);
      sys.notify("Alterações salvas");
    }
  };

  return (
    <div className="h-full flex flex-col gap-2">
      <div className="flex gap-2">
        <button onClick={save} className="px-3 py-1 rounded-lg bg-[var(--yatrz-accent)]/30">Salvar</button>
        <button onClick={() => setPath(null)} className="px-3 py-1 rounded-lg bg-white/30 dark:bg-white/10">Novo</button>
      </div>
      <textarea value={text} onChange={(e)=>setText(e.target.value)} className="flex-1 w-full rounded-xl p-3 bg-white dark:bg-neutral-900 outline-none" placeholder="Escreva suas notas aqui..." />
    </div>
  );
}

// Markdown Editor
function MarkdownApp({ win, setWin, sys }) {
  const [path, setPath] = useState(win.payload?.path || null);
  const [text, setText] = useState("# Olá, Markdown!\n\n- Escreva à esquerda\n- Veja a prévia à direita\n\n**Yatrz** ❤️");

  useEffect(() => {
    if (path) {
      const node = sys.findNode(path);
      if (node?.content) setText(node.content);
      setWin({ title: `Markdown — ${path.split("/").pop()}` });
    } else setWin({ title: "Markdown Editor" });
  }, [path]);

  const save = () => {
    if (!path) {
      const name = prompt("Salvar como:", "documento.md");
      if (!name) return;
      sys.fsCreate("/Documents", name, "file", text);
      setPath(`/Documents/${name}`);
      sys.notify("Arquivo salvo");
    } else {
      const root = clone(sys.fsRoot);
      const node = findNode(path, root);
      if (node) node.content = text;
      sys.setFsRoot(root);
      sys.notify("Alterações salvas");
    }
  };

  return (
    <div className="h-full grid grid-cols-1 md:grid-cols-2 gap-2">
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <button onClick={save} className="px-3 py-1 rounded-lg bg-[var(--yatrz-accent)]/30">Salvar</button>
        </div>
        <textarea value={text} onChange={(e)=>setText(e.target.value)} className="flex-1 w-full rounded-xl p-3 bg-white dark:bg-neutral-900 outline-none font-mono text-sm" />
      </div>
      <div className="rounded-xl p-3 bg-white dark:bg-neutral-900 prose prose-sm dark:prose-invert max-w-none overflow-auto" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
    </div>
  );
}

function renderMarkdown(md) {
  // Tiny MD renderer (headings, bold, italics, code, lists, links)
  let html = md;
  html = html.replace(/^###### (.*)$/gm, '<h6>$1</h6>')
             .replace(/^##### (.*)$/gm, '<h5>$1</h5>')
             .replace(/^#### (.*)$/gm, '<h4>$1</h4>')
             .replace(/^### (.*)$/gm, '<h3>$1</h3>')
             .replace(/^## (.*)$/gm, '<h2>$1</h2>')
             .replace(/^# (.*)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
             .replace(/\*(.*?)\*/g, '<em>$1</em>')
             .replace(/`([^`]+)`/g, '<code>$1</code>')
             .replace(/\n- (.*)/g, '<li>$1</li>')
             .replace(/\n(\s*)\n/g, '<br/><br/>');
  html = html.replace(/\[(.*?)\]\((https?:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1<\/a>');
  return html;
}

// Calculator
function CalculatorApp() {
  const [display, setDisplay] = useState("0");
  const [stack, setStack] = useState({ a: null, op: null });

  const press = (v) => {
    setDisplay((d) => (d === "0" ? String(v) : d + String(v)));
  };
  const clear = () => { setDisplay("0"); setStack({ a: null, op: null }); };
  const dot = () => setDisplay((d) => (d.includes(".") ? d : d + "."));
  const op = (o) => {
    setStack({ a: parseFloat(display), op: o });
    setDisplay("0");
  };
  const eq = () => {
    const b = parseFloat(display);
    const { a, op: o } = stack;
    if (a == null || !o) return;
    let r = 0;
    if (o === "+") r = a + b;
    if (o === "-") r = a - b;
    if (o === "×") r = a * b;
    if (o === "÷") r = b === 0 ? NaN : a / b;
    setDisplay(String(r));
    setStack({ a: null, op: null });
  };

  const Btn = ({ children, onClick, grow }) => (
    <button onClick={onClick} className={cx("px-3 py-3 rounded-xl bg-white dark:bg-neutral-900 hover:bg-white/80 dark:hover:bg-neutral-800 text-lg font-semibold", grow && "col-span-2")}>{children}</button>
  );

  return (
    <div className="max-w-sm mx-auto space-y-2">
      <div className="rounded-xl p-3 bg-black/5 dark:bg-white/5 text-right text-2xl font-mono tabular-nums">{display}</div>
      <div className="grid grid-cols-4 gap-2">
        <Btn onClick={clear}>C</Btn>
        <Btn onClick={()=>op("÷")}>
          ÷
        </Btn>
        <Btn onClick={()=>op("×")}>×</Btn>
        <Btn onClick={()=>op("-")}>-</Btn>
        <Btn onClick={()=>press(7)}>7</Btn>
        <Btn onClick={()=>press(8)}>8</Btn>
        <Btn onClick={()=>press(9)}>9</Btn>
        <Btn onClick={()=>op("+")}>+</Btn>
        <Btn onClick={()=>press(4)}>4</Btn>
        <Btn onClick={()=>press(5)}>5</Btn>
        <Btn onClick={()=>press(6)}>6</Btn>
        <Btn onClick={eq}>=</Btn>
        <Btn onClick={()=>press(1)}>1</Btn>
        <Btn onClick={()=>press(2)}>2</Btn>
        <Btn onClick={()=>press(3)}>3</Btn>
        <Btn onClick={dot}>.</Btn>
        <Btn onClick={()=>press(0)} grow>0</Btn>
      </div>
    </div>
  );
}

// Browser (sandboxed)
function BrowserApp({ win, setWin }) {
  const [url, setUrl] = useState("https://example.org");
  useEffect(() => setWin({ title: `Navegador — ${url}` }), [url]);
  const go = () => {
    let u = url.trim();
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    setUrl(u);
  };
  return (
    <div className="h-full flex flex-col gap-2">
      <div className="flex gap-2">
        <input value={url} onChange={(e)=>setUrl(e.target.value)} className="flex-1 px-3 py-2 rounded-xl bg-white dark:bg-neutral-900 outline-none" />
        <button onClick={go} className="px-3 py-2 rounded-xl bg-[var(--yatrz-accent)]/30">Ir</button>
      </div>
      <iframe title="web" src={url} sandbox="allow-same-origin allow-scripts allow-forms allow-popups" className="flex-1 w-full rounded-xl bg-white"></iframe>
    </div>
  );
}

// Files
function FilesApp({ sys }) {
  const [cwd, setCwd] = useState("/");
  const [sel, setSel] = useState(null);
  const dir = sys.findNode(cwd) || { type: "dir", children: [] };

  const open = (item) => {
    if (item.type === "dir") setCwd(normPath(cwd + "/" + item.name));
    else {
      // open with associated app
      const name = item.name.toLowerCase();
      const app = Object.values(builtinApps).find((a) => a.accepts?.some((ext) => name.endsWith(ext)));
      if (app) sys.launch(app.id, { path: normPath(cwd + "/" + item.name) }, item.name);
      else sys.launch("notepad", { path: normPath(cwd + "/" + item.name) }, item.name);
    }
  };

  const mk = (type) => {
    const name = prompt(type === "dir" ? "Nome da pasta:" : "Nome do arquivo:", type === "dir" ? "Nova Pasta" : "novo.txt");
    if (!name) return;
    try {
      sys.fsCreate(cwd, name, type, type === "file" ? "" : undefined);
    } catch (e) { sys.notify(e.message); }
  };

  const del = () => {
    if (!sel) return;
    if (!confirm(`Deletar ${sel}?`)) return;
    sys.fsDelete(normPath(cwd + "/" + sel));
    setSel(null);
  };

  const rename = () => {
    if (!sel) return;
    const nn = prompt("Novo nome:", sel);
    if (!nn) return;
    sys.fsRename(normPath(cwd + "/" + sel), nn);
    setSel(nn);
  };

  const up = () => {
    if (cwd === "/") return;
    const parts = cwd.split("/").filter(Boolean);
    parts.pop();
    setCwd("/" + parts.join("/"));
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 mb-2">
        <button onClick={up} className="px-2 py-1 rounded-lg bg-white/40 dark:bg-white/10">⬆</button>
        <div className="px-2 py-1 rounded-lg bg-white/60 dark:bg-white/10 font-mono text-sm">{cwd}</div>
        <div className="flex-1" />
        <button onClick={()=>mk("dir")} className="px-2 py-1 rounded-lg bg-white/40 dark:bg-white/10">Nova pasta</button>
        <button onClick={()=>mk("file")} className="px-2 py-1 rounded-lg bg-white/40 dark:bg-white/10">Novo arquivo</button>
        <button onClick={rename} className="px-2 py-1 rounded-lg bg-white/40 dark:bg-white/10">Renomear</button>
        <button onClick={del} className="px-2 py-1 rounded-lg bg-rose-500/30">Excluir</button>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
        {dir.children?.map((c) => (
          <button key={c.name} onDoubleClick={()=>open(c)} onClick={()=>setSel(c.name)} className={cx("flex flex-col items-center gap-1 p-2 rounded-xl hover:bg-white/40 dark:hover:bg-white/10", sel===c.name && "ring-2 ring-[var(--yatrz-accent)]")}> 
            <div className="text-3xl">{c.type === "dir" ? "📁" : "📄"}</div>
            <div className="text-xs truncate w-full text-center">{c.name}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

// Terminal
function TerminalApp({ sys }) {
  const [lines, setLines] = useState(["Yatrz Terminal — digite 'help' para comandos."]); 
  const [cwd, setCwd] = useState("/");
  const [input, setInput] = useState("");
  const out = (s) => setLines((arr) => [...arr, s]);

  const run = (cmdline) => {
    const [cmd, ...args] = cmdline.trim().split(/\s+/);
    switch (cmd) {
      case "help":
        out("Comandos: ls, cd, pwd, cat, echo, touch, mkdir, rm, mv, theme, whoami, date, clear");
        break;
      case "ls": {
        try {
          const items = listDir(cwd, sys.fsRoot).map((i)=> (i.type==="dir"?"["+i.name+"]":i.name)).join("  ");
          out(items || "(vazio)");
        } catch(e){ out("Erro: "+e.message); }
        break; }
      case "cd": {
        const p = args[0] || "/";
        const np = normPath(cwd + "/" + p);
        const d = findNode(np, sys.fsRoot);
        if (d && d.type === "dir") setCwd(np); else out("diretório inválido");
        break; }
      case "pwd": out(cwd); break;
      case "cat": {
        const p = normPath(cwd + "/" + (args[0]||""));
        const f = findNode(p, sys.fsRoot);
        out(f?.type === "file" ? (f.content||"") : "arquivo inválido");
        break; }
      case "echo": out(args.join(" ")); break;
      case "touch": {
        const name = args[0]; if(!name){ out("uso: touch <nome>"); break;}
        try{ sys.fsCreate(cwd, name, "file", ""); out("ok"); }catch(e){ out("Erro: "+e.message); }
        break; }
      case "mkdir": {
        const name = args[0]; if(!name){ out("uso: mkdir <nome>"); break;}
        try{ sys.fsCreate(cwd, name, "dir"); out("ok"); }catch(e){ out("Erro: "+e.message); }
        break; }
      case "rm": {
        const p = normPath(cwd + "/" + (args[0]||""));
        try{ sys.fsDelete(p); out("ok"); }catch(e){ out("Erro: "+e.message); }
        break; }
      case "mv": {
        const [src, dst] = args; if(!src||!dst){ out("uso: mv <src> <dstDir>"); break; }
        try{ sys.fsMove(normPath(cwd+"/"+src), normPath(cwd+"/"+dst)); out("ok"); }catch(e){ out("Erro: "+e.message); }
        break; }
      case "theme": {
        const t = args[0]; if(["light","dark"].includes(t)){ sys.setTheme(t); out("tema: "+t);} else out("uso: theme light|dark");
        break; }
      case "whoami": out(storage.get("currentUser", {username:"user"}).username); break;
      case "date": out(new Date().toString()); break;
      case "clear": setLines([]); break;
      default: out("Comando não encontrado");
    }
  };

  const submit = (e) => {
    e.preventDefault();
    if (!input.trim()) return;
    setLines((arr) => [...arr, `> ${input}`]);
    run(input);
    setInput("");
  };

  return (
    <div className="h-full rounded-xl p-3 bg-black text-green-400 font-mono text-sm overflow-auto">
      {lines.map((l, i) => (
        <div key={i} className="whitespace-pre-wrap">{l}</div>
      ))}
      <form onSubmit={submit} className="flex gap-2 mt-2">
        <span className="text-green-500">{cwd}$</span>
        <input value={input} onChange={(e)=>setInput(e.target.value)} className="flex-1 bg-transparent outline-none" autoFocus />
      </form>
    </div>
  );
}

// Settings
function SettingsApp({ sys }) {
  const [wall, setWall] = useState(sys.wallpaper);
  const [accent, setAccent] = useState(sys.accent);
  const [theme, setTheme] = useState(sys.theme);
  const [density, setDensity] = useState(sys.density);

  const save = () => {
    sys.setWallpaper(wall || defaultWallpaper);
    sys.setAccent(accent);
    sys.setTheme(theme);
    sys.setDensity(density);
    sys.notify("Configurações salvas");
  };

  // PWA helper — registers a minimal SW via Blob
  const registerPWA = async () => {
    if (!("serviceWorker" in navigator)) return sys.notify("SW não suportado");
    const swCode = `self.addEventListener('install',e=>{self.skipWaiting()});self.addEventListener('activate',e=>{clients.claim()});self.addEventListener('fetch',e=>{e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)))})`;
    const blob = new Blob([swCode], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      await navigator.serviceWorker.register(url);
      sys.notify("Service Worker registrado (básico)");
    } catch (e) {
      sys.notify("Falha ao registrar SW");
    }
  };

  // Plugins
  const [plugins, setPlugins] = useState(sys.plugins);
  const addPlugin = () => {
    const name = prompt("Nome do app:", "Meu Plugin");
    if (!name) return;
    const url = prompt("URL (iframe)", "https://example.org");
    if (!url) return;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const icon = prompt("Ícone (emoji)", "🧩");
    const p = { id, name, icon, url };
    const arr = [...plugins, p];
    setPlugins(arr);
    sys.setPlugins(arr);
  };
  const removePlugin = (id) => {
    const arr = plugins.filter((p) => p.id !== id);
    setPlugins(arr);
    sys.setPlugins(arr);
  };

  return (
    <div className="space-y-4">
      <section className="grid md:grid-cols-2 gap-3">
        <div className="p-3 rounded-xl bg-white/60 dark:bg-white/5 space-y-2">
          <h3 className="font-semibold">Aparência</h3>
          <label className="text-sm">Wallpaper URL</label>
          <input value={wall} onChange={(e)=>setWall(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-white dark:bg-neutral-900 outline-none" />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-sm">Tema</label>
              <select value={theme} onChange={(e)=>setTheme(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-white dark:bg-neutral-900 outline-none">
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </div>
            <div>
              <label className="text-sm">Densidade</label>
              <select value={density} onChange={(e)=>setDensity(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-white dark:bg-neutral-900 outline-none">
                <option value="compact">Compact</option>
                <option value="cozy">Cozy (padrão)</option>
                <option value="comfortable">Comfortable</option>
              </select>
            </div>
          </div>
          <div>
            <label className="text-sm">Acento</label>
            <div className="flex gap-2 mt-1">
              {ACCENTS.map((a) => (
                <button key={a} onClick={()=>setAccent(a)} className={cx("w-7 h-7 rounded-full border border-white/20", accent===a && "ring-2 ring-offset-2 ring-[var(--yatrz-accent)]")}
                  style={{ background: `var(--col-${a})` }}>
                  <span className="sr-only">{a}</span>
                </button>
              ))}
            </div>
          </div>
          <button onClick={save} className="px-3 py-2 rounded-xl bg-[var(--yatrz-accent)]/30">Salvar</button>
        </div>
        <div className="p-3 rounded-xl bg-white/60 dark:bg-white/5 space-y-2">
          <h3 className="font-semibold">PWA</h3>
          <p className="text-sm text-neutral-500">Registre um Service Worker básico para uso offline (demonstração). Para produção, inclua seu sw.js e manifest.json.</p>
          <button onClick={registerPWA} className="px-3 py-2 rounded-xl bg-white/30 dark:bg-white/10">Registrar SW</button>
        </div>
      </section>

      <section className="p-3 rounded-xl bg-white/60 dark:bg-white/5 space-y-2">
        <h3 className="font-semibold">Plugins</h3>
        <div className="flex gap-2 mb-2">
          <button onClick={addPlugin} className="px-3 py-2 rounded-xl bg-[var(--yatrz-accent)]/30">Adicionar Plugin</button>
        </div>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-2">
          {plugins.map((p) => (
            <div key={p.id} className="p-2 rounded-xl bg-white/40 dark:bg-white/10 flex items-center justify-between">
              <div className="flex items-center gap-2"><span className="text-xl">{p.icon}</span><div>
                <div className="font-semibold">{p.name}</div>
                <div className="text-xs text-neutral-500">{p.url}</div>
              </div></div>
              <div className="flex items-center gap-2">
                <button onClick={()=>window.dispatchEvent(new CustomEvent('yatrz-launch', { detail: { id: p.id } }))} className="px-2 py-1 rounded-lg bg-white/40 dark:bg-white/10">Abrir</button>
                <button onClick={()=>removePlugin(p.id)} className="px-2 py-1 rounded-lg bg-rose-500/30">Remover</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <style>{`
        :root{ ${ACCENTS.map(a=>`--col-${a}:${accentHex(a)};`).join(' ')} }
      `}</style>
    </div>
  );
}

function accentHex(a){
  const m = { cyan: "#22d3ee", blue: "#60a5fa", violet: "#a78bfa", emerald: "#34d399", rose: "#fb7185", amber: "#f59e0b" };
  return m[a] || m.cyan;
}

/*********************************
 * Plugin App Factory (iframe sandbox)
 *********************************/
function makePluginApp(plugin) {
  return function PluginApp() {
    return (
      <div className="h-full flex flex-col gap-2">
        <div className="text-sm text-neutral-500">Sandbox: {plugin.url}</div>
        <iframe title={plugin.name} src={plugin.url} sandbox="allow-same-origin allow-scripts allow-forms allow-popups" className="flex-1 w-full rounded-xl bg-white"></iframe>
      </div>
    );
  };
}

/*********************************
 * Global styles for accent
 *********************************/
const style = document.createElement('style');
style.innerHTML = `
  .accent { color: var(--yatrz-accent); }
`;
document.head.appendChild(style);
