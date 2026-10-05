// main.js — CARRION WASM bootstrap
import { dotnet } from './_framework/dotnet.js';

const canvas = document.getElementById("canvas");
const progressEl = document.getElementById("loading-progress");
const overlayEl = document.getElementById("loading-overlay");

if (canvas) {
    canvas.width = 1280;
    canvas.height = 720;
}

function setStatus(msg) {
    console.log("[Carrion.Web] " + msg);
    if (progressEl) progressEl.textContent = msg;
}

setStatus("Initialising .NET WebAssembly runtime...");

globalThis.Module = globalThis.Module || {};
if (canvas) {
    globalThis.Module.canvas = canvas;
}

// ---------------------------------------------------------------------------
// 1. Web Audio: Autoplay Unlock & Safe ScriptProcessor Clamping
// ---------------------------------------------------------------------------
const activeAudioContexts = new Set();
window._audioContexts = activeAudioContexts;
const OrigAudioContext = window.AudioContext || window.webkitAudioContext;

if (OrigAudioContext) {
    const WrappedAudioContext = function(...args) {
        let opts = args[0];
        if (!opts || typeof opts !== 'object') opts = {};
        else opts = Object.assign({}, opts);
        if (!opts.sampleRate) opts.sampleRate = 48000;
        const ctx = new OrigAudioContext(opts);
        activeAudioContexts.add(ctx);
        console.log("[Carrion Audio] AudioContext created. Sample rate:", ctx.sampleRate, "State:", ctx.state);
        ctx.addEventListener('statechange', () => {
            console.log("[Carrion Audio] AudioContext state:", ctx.state);
        });
        return ctx;
    };
    WrappedAudioContext.prototype = OrigAudioContext.prototype;

    const origCSP = OrigAudioContext.prototype.createScriptProcessor;
    if (origCSP) {
        OrigAudioContext.prototype.createScriptProcessor = function(bufferSize, inChannels, outChannels) {
            const validPowers = [256, 512, 1024, 2048, 4096, 8192, 16384];
            let clamped = bufferSize;
            if (!validPowers.includes(bufferSize)) {
                clamped = validPowers.reduce((best, p) =>
                    Math.abs(p - bufferSize) < Math.abs(best - bufferSize) ? p : best, 4096);
                console.warn(`[Carrion Audio] Clamping bufferSize ${bufferSize} -> ${clamped}`);
            }
            return origCSP.call(this, clamped, inChannels, outChannels);
        };
    }

    window.AudioContext = WrappedAudioContext;
    if (window.webkitAudioContext) {
        window.webkitAudioContext = WrappedAudioContext;
    }
}

function resumeAllAudio() {
    for (const ctx of activeAudioContexts) {
        if (ctx.state === 'suspended') {
            ctx.resume().then(() => {
                console.log("[Carrion Audio] AudioContext resumed successfully!");
            }).catch(err => {
                console.warn("[Carrion Audio] AudioContext resume error:", err);
            });
        }
    }
    const sdl2 = globalThis.Module?.SDL2 || globalThis.SDL2 || window.SDL2;
    if (sdl2?.audioContext && sdl2.audioContext.state === 'suspended') {
        sdl2.audioContext.resume().then(() => {
            console.log("[Carrion Audio] Module.SDL2.audioContext resumed successfully!");
        }).catch(() => {});
    }
    getGameAudioContext();
}

let gameAudioCtx = null;
function getGameAudioContext() {
    if (!gameAudioCtx) {
        const AudioCtor = window.AudioContext || window.webkitAudioContext;
        if (AudioCtor) {
            try {
                gameAudioCtx = new AudioCtor({ sampleRate: 44100 });
                activeAudioContexts.add(gameAudioCtx);
            } catch (e) {
                console.warn("[Carrion Audio] Could not create gameAudioCtx:", e);
            }
        }
    }
    if (gameAudioCtx && gameAudioCtx.state === 'suspended') {
        gameAudioCtx.resume().catch(() => {});
    }
    return gameAudioCtx;
}

const sfxAudioBuffers = new Map();
const lastPlayedTimes = new Map();
let activeSfxCount = 0;
const MAX_CONCURRENT_SFX = 14;

function playSfxFile(filename, volume = 1.0, maxVol = 0.8) {
    if (activeSfxCount >= MAX_CONCURRENT_SFX) return;
    const buf = sfxAudioBuffers.get(filename);
    if (!buf) return;
    const ctx = getGameAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
        return;
    }
    try {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const gain = ctx.createGain();
        const effectiveVol = Math.max(0.0, Math.min(maxVol, volume * maxVol));
        gain.gain.value = effectiveVol;
        src.connect(gain);
        gain.connect(ctx.destination);
        activeSfxCount++;
        src.onended = () => {
            activeSfxCount = Math.max(0, activeSfxCount - 1);
        };
        src.start(0);
    } catch (_) {}
}

const SFX_CATEGORIES = [
    // ── UI (Authentic FMOD samples extracted from Sounds.bank) ─────────────
    {
        key: "ui_select",
        pattern: /interface_sounds\/(menu_select_item|menu_settings_up|menu_settings_down)/i,
        files: ["menu_select.ogg", "menu_hover.ogg"],
        maxVol: 0.5,
        cooldown: 50
    },
    {
        key: "ui_activate",
        pattern: /interface_sounds\/(menu_activate_item)/i,
        files: ["menu_activate.ogg"],
        maxVol: 0.6,
        cooldown: 80
    },
    {
        key: "ui_jaws",
        pattern: /interface_sounds\/(menu_jaws|menu_tongue)/i,
        files: ["menu_jaws.ogg"],
        maxVol: 0.5,
        cooldown: 180
    },
    {
        key: "ui_stinger",
        pattern: /interface_sounds\/(level_stinger)/i,
        files: ["level_stinger.ogg"],
        maxVol: 0.6,
        cooldown: 1000
    },

    // ── Monster Intentional Actions (Roar, Taunt, Eating, Dashing) ─────────
    {
        key: "monster_taunt",
        pattern: /(sounds\/monster\/taunt|sounds\/hive\/taunt)/i,
        files: [
            "monstrer_taunt_01.ogg", "monstrer_taunt_02.ogg", "monstrer_taunt_03.ogg",
            "monstrer_taunt_04.ogg", "monstrer_taunt_05.ogg"
        ],
        maxVol: 0.8,
        cooldown: 250
    },
    {
        key: "monster_roar",
        pattern: /(sounds\/dark_biomass\/db_roar)/i,
        files: [
            "dark_biomas_roar_1.ogg", "dark_biomas_roar_2.ogg", "dark_biomas_roar_3.ogg"
        ],
        maxVol: 0.8,
        cooldown: 250
    },
    {
        key: "monster_eat",
        pattern: /(eating_human)/i,
        files: [
            "eating_human-01.ogg", "eating_human-02.ogg", "eating_human-03.ogg",
            "eating_human-04.ogg", "eating_human-05.ogg"
        ],
        maxVol: 0.7,
        cooldown: 140
    },
    {
        key: "monster_dash",
        pattern: /(sounds\/monster\/dashing|sounds\/dark_biomass\/db_dashing)/i,
        files: [
            "dashing_hit-01.ogg", "dashing_hit-02.ogg", "dashing_hit-03.ogg"
        ],
        maxVol: 0.6,
        cooldown: 200
    },
    {
        key: "monster_tentacle_strike",
        pattern: /(tentacle_vortex|tendril_throw_big)/i,
        files: [
            "tentacle_vortex-01.ogg", "tentacle_vortex-02.ogg", "tentacle_vortex-03.ogg"
        ],
        maxVol: 0.35,
        cooldown: 200
    },
    {
        key: "monster_bounce",
        pattern: /(biomass_bounce)/i,
        files: [
            "biomass_bounce-01.ogg", "biomass_bounce-02.ogg"
        ],
        maxVol: 0.4,
        cooldown: 200
    },

    // ── Environment & Demolition ───────────────────────────────────────────
    {
        key: "vent",
        pattern: /(vent_pound|thru_the_wall_pound|vent_tearoff)/i,
        files: [
            "vent_pound_strong-01.ogg", "vent_pound_weak-01.ogg", "vent_tearoff_strong-01.ogg"
        ],
        maxVol: 0.5,
        cooldown: 180
    },
    {
        key: "glass_crack",
        pattern: /(glass_crack)/i,
        files: ["glass_crack-01.ogg", "glass_crack-02.ogg"],
        maxVol: 0.6,
        cooldown: 100
    },
    {
        key: "glass_break",
        pattern: /(breaking_window)/i,
        files: ["glass_crash_1.ogg", "glass_crash_2.ogg", "glass_crash_9.ogg"],
        maxVol: 0.6,
        cooldown: 120
    },
    {
        key: "jar_crack",
        pattern: /(coming_out_of_jar|jar_explosion)/i,
        files: ["jar_crack-01.ogg", "jar_crack-02.ogg", "jar_crack-03.ogg"],
        maxVol: 0.6,
        cooldown: 120
    },
    {
        key: "door_activate",
        pattern: /(block_door_activate)/i,
        files: ["block_door_activate_MONO-01.ogg", "block_door_activate_MONO-02.ogg"],
        maxVol: 0.5,
        cooldown: 250
    },
    {
        key: "door_deactivate",
        pattern: /(block_door_deactivate)/i,
        files: ["block_door_deactivate_MONO-01.ogg", "block_door_deactivate_MONO-02.ogg"],
        maxVol: 0.5,
        cooldown: 250
    },
    {
        key: "door_shut",
        pattern: /(large_door_close|door_shut)/i,
        files: ["door_shut_steel-01.ogg", "large_door_close_3.ogg"],
        maxVol: 0.5,
        cooldown: 200
    },
    {
        key: "switch",
        pattern: /(sounds\/switches\/switch)/i,
        files: ["switch_1.ogg"],
        maxVol: 0.6,
        cooldown: 100
    },
    {
        key: "water_splash",
        pattern: /(water_splash)/i,
        files: ["water_B_splash-00.ogg", "water_B_splash-01.ogg", "water_B_splash-08.ogg"],
        maxVol: 0.4,
        cooldown: 150
    },

    // ── Weapons & Combat ───────────────────────────────────────────────────
    {
        key: "assault_rifle",
        pattern: /(sounds\/weapons\/assault_rifle)/i,
        files: ["assault_rifle_opt_1.ogg", "assault_rifle_opt_2.ogg", "assault_rifle_opt_3.ogg"],
        maxVol: 0.6,
        cooldown: 60
    },
    {
        key: "pistol",
        pattern: /(sounds\/weapons\/pistol)/i,
        files: ["pistol_k_fire-00.ogg", "pistol_k_fire-01.ogg", "pistol_k_fire-02.ogg"],
        maxVol: 0.6,
        cooldown: 80
    },
    {
        key: "shotgun",
        pattern: /(sounds\/weapons\/shotgun)/i,
        files: ["shotgun_0.ogg", "shotgun_1.ogg", "shotgun_2.ogg"],
        maxVol: 0.7,
        cooldown: 120
    },
    {
        key: "flamethrower",
        pattern: /(sounds\/weapons\/flamethrower|single_flame)/i,
        files: ["flamethrower_B_01.ogg", "flamethrower_B_02.ogg", "single_flame-01.ogg"],
        maxVol: 0.6,
        cooldown: 100
    },
    {
        key: "drone",
        pattern: /(sentry_drone_plasma_gun|vulcan_cannon|turret)/i,
        files: ["sentry_drone_plasma_gun_1.ogg", "sentry_drone_plasma_gun_2.ogg"],
        maxVol: 0.6,
        cooldown: 70
    },
    {
        key: "taser",
        pattern: /(sounds\/weapons\/taser|electric_shock)/i,
        files: ["taser_shot.ogg", "taser_spark.ogg"],
        maxVol: 0.6,
        cooldown: 80
    },

    // ── Humans & Impacts ───────────────────────────────────────────────────
    {
        key: "scream",
        pattern: /(scream)/i,
        files: [
            "mn_scream-08.ogg", "mn_scream-13.ogg", "mn_scream-29.ogg",
            "armor_screams_grb-00.ogg", "armor_screams_grb-26.ogg"
        ],
        maxVol: 0.7,
        cooldown: 150
    },
    {
        key: "blood",
        pattern: /(gushing_blood|spine)/i,
        files: ["gushing_blood_1.ogg", "gushing_blood_2.ogg", "gushing_blood_3.ogg"],
        maxVol: 0.5,
        cooldown: 120
    },
    {
        key: "bullet_impact",
        pattern: /(bullet_impact_)/i,
        files: ["bullet_impact_dirt_1.ogg", "bullet_impact_wood_1c.ogg", "bullet_impact_mechs_B_00.ogg"],
        maxVol: 0.6,
        cooldown: 60
    },
    {
        key: "body_hit",
        pattern: /(body_hit|bullet_impact_monster|bullet_impact_blood)/i,
        files: ["body_hit-01.ogg", "body_hit_armor-01.ogg"],
        maxVol: 0.6,
        cooldown: 100
    },
    {
        key: "footstep",
        pattern: /(steps\/.*_step)/i,
        files: ["wet_step-01.ogg", "wet_step-02.ogg", "dry_wet_walk_1.ogg", "dry_wet_walk_2.ogg"],
        maxVol: 0.2,
        cooldown: 160
    }
];

let isPreloadingSfx = false;
let sfxPreloaded = false;

async function preloadSfxBuffers(FS) {
    if (isPreloadingSfx || sfxPreloaded) return;
    isPreloadingSfx = true;
    const ctx = getGameAudioContext();
    if (!ctx) {
        isPreloadingSfx = false;
        return;
    }
    const uniqueFiles = Array.from(new Set(SFX_CATEGORIES.flatMap(c => c.files)));
    console.log(`[Carrion Audio] Preloading ${uniqueFiles.length} sound effect buffers...`);
    const CHUNK_SIZE = 16;
    for (let i = 0; i < uniqueFiles.length; i += CHUNK_SIZE) {
        const chunk = uniqueFiles.slice(i, i + CHUNK_SIZE);
        await Promise.allSettled(chunk.map(async (file) => {
            try {
                let ab = null;
                const fsInstance = FS || window.FS;
                if (fsInstance && typeof fsInstance.readFile === 'function') {
                    try {
                        const u8 = fsInstance.readFile("/Content/Audio/sfx/" + file);
                        if (u8 && u8.length > 0) {
                            ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
                        }
                    } catch (_) {}
                }
                if (!ab) {
                    const resp = await fetch("Content/Audio/sfx/" + file);
                    if (resp.ok) {
                        ab = await resp.arrayBuffer();
                    }
                }
                if (ab) {
                    const buf = await ctx.decodeAudioData(ab);
                    sfxAudioBuffers.set(file, buf);
                }
            } catch (_) {}
        }));
    }
    sfxPreloaded = true;
    isPreloadingSfx = false;
    console.log(`[Carrion Audio] Preloaded ${sfxAudioBuffers.size}/${uniqueFiles.length} SFX buffers in memory.`);
}

const sfxLookupCache = new Map();

function playGameSound(name, volume = 1.0) {
    if (!name || volume <= 0.001) return;
    const lower = name.toLowerCase().replace(/^event:\//, '');

    // Strict check: ALL music and ambience completely disabled
    if (lower.startsWith('music') || lower.includes('/music') ||
        lower.startsWith('ambient') || lower.includes('/ambient') ||
        lower.includes('soundtrack') || lower.includes('score') ||
        lower.includes('radio')) {
        return;
    }

    let cat = sfxLookupCache.get(lower);
    if (cat === undefined) {
        cat = null;
        for (let i = 0; i < SFX_CATEGORIES.length; i++) {
            if (SFX_CATEGORIES[i].pattern.test(lower)) {
                cat = SFX_CATEGORIES[i];
                break;
            }
        }
        sfxLookupCache.set(lower, cat);
    }
    if (!cat) return;

    const now = performance.now();
    const cooldown = cat.cooldown || 70;
    const last = lastPlayedTimes.get(cat.key) || 0;
    if (now - last < cooldown) return;
    lastPlayedTimes.set(cat.key, now);

    const file = cat.files[Math.floor(Math.random() * cat.files.length)];
    const maxVol = cat.maxVol !== undefined ? cat.maxVol : 0.8;
    playSfxFile(file, volume, maxVol);
}

function stopGameSound(name) {
    // Music is disabled; SFX play as one-shots and terminate on their own
}

const unlockAudio = () => {
    resumeAllAudio();
    if (!sfxPreloaded && !isPreloadingSfx) {
        preloadSfxBuffers().catch(() => {});
    }
};
window._unlockAudio = unlockAudio;
['click', 'keydown', 'mousedown', 'pointerdown', 'touchstart'].forEach(evt => {
    window.addEventListener(evt, unlockAudio, { capture: true, passive: true, once: true });
    document.addEventListener(evt, unlockAudio, { capture: true, passive: true, once: true });
    if (canvas) canvas.addEventListener(evt, unlockAudio, { capture: true, passive: true, once: true });
});

// ---------------------------------------------------------------------------
// 1b. Virtual Mouse Tracking & Pointer Lock Drift Elimination
// ---------------------------------------------------------------------------
let virtualMouseX = 320;
let virtualMouseY = 180;

window.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement) {
        virtualMouseX = Math.max(0, Math.min(640, virtualMouseX + e.movementX));
        virtualMouseY = Math.max(0, Math.min(360, virtualMouseY + e.movementY));
    } else {
        const rect = canvas ? canvas.getBoundingClientRect() : null;
        if (rect && rect.width > 0 && rect.height > 0) {
            virtualMouseX = Math.max(0, Math.min(640, ((e.clientX - rect.left) / rect.width) * 640));
            virtualMouseY = Math.max(0, Math.min(360, ((e.clientY - rect.top) / rect.height) * 360));
        }
    }
}, { passive: true });

if (canvas) {
    canvas.addEventListener('click', () => {
        if (canvas.requestPointerLock && document.pointerLockElement !== canvas) {
            canvas.requestPointerLock();
        }
    });
}

// ---------------------------------------------------------------------------
// 2. Real-time FPS Counter (Timer-based, 60 FPS capped)
// ---------------------------------------------------------------------------
const fpsEl = document.getElementById("fps-counter");
let lastFpsTime = performance.now();
let fpsFrames = 0;

setInterval(() => {
    const now = performance.now();
    const elapsed = now - lastFpsTime;
    if (elapsed >= 500) {
        const currentFps = Math.min(60, Math.round((fpsFrames * 1000) / elapsed));
        if (fpsEl) {
            fpsEl.textContent = `${currentFps} FPS`;
            if (currentFps >= 50) {
                fpsEl.style.color = "#4ade80";
                fpsEl.style.borderColor = "rgba(74, 222, 128, 0.35)";
            } else if (currentFps >= 28) {
                fpsEl.style.color = "#facc15";
                fpsEl.style.borderColor = "rgba(250, 204, 21, 0.35)";
            } else {
                fpsEl.style.color = "#f87171";
                fpsEl.style.borderColor = "rgba(248, 113, 113, 0.35)";
            }
        }
        fpsFrames = 0;
        lastFpsTime = now;
    }
}, 500);

// ---------------------------------------------------------------------------
// 3. Save Directory & IDBFS Persistence
// ---------------------------------------------------------------------------
function ensureDirectoryExists(fs, dirPath) {
    if (!dirPath || dirPath === '/' || dirPath === '.') return;
    const parts = dirPath.split('/').filter(p => p.length > 0);
    let current = '';
    for (const part of parts) {
        current += '/' + part;
        try {
            if (typeof fs.analyzePath === 'function') {
                if (!fs.analyzePath(current).exists) {
                    fs.mkdir(current);
                }
            } else {
                fs.mkdir(current);
            }
        } catch (e) {}
    }
}

async function mountSave(FS) {
    if (!FS) {
        console.warn("[Carrion.Web] Emscripten FS not available, skipping save mount.");
        return;
    }

    ensureDirectoryExists(FS, "/save");
    ensureDirectoryExists(FS, "/save/Phobia");
    ensureDirectoryExists(FS, "/save/Phobia/Carrion");
    ensureDirectoryExists(FS, "/home/web_user/.local/share/Phobia/Carrion");

    if (typeof FS.mount === 'function' && FS.filesystems?.IDBFS) {
        try {
            FS.mount(FS.filesystems.IDBFS, {}, "/save");
            await new Promise((resolve) => {
                FS.syncfs(true, (err) => {
                    if (err) console.warn("[Carrion.Web] IDBFS initial sync failed:", err);
                    resolve();
                });
            });
            console.log("[Carrion.Web] /save successfully mounted to IDBFS");

            let isSyncing = false;
            window.syncSaveData = function() {
                if (isSyncing) return;
                isSyncing = true;
                FS.syncfs(false, (err) => {
                    isSyncing = false;
                    if (err) console.warn("[Carrion.Web] IDBFS sync error:", err);
                    else console.log("[Carrion.Web] IDBFS save synchronized");
                });
            };
            window.addEventListener('beforeunload', () => window.syncSaveData());
        } catch (e) {
            console.warn("[Carrion.Web] IDBFS mount failed:", e);
        }
    }
}

// ---------------------------------------------------------------------------
// 4. Asset Archive Unpacker & Virtual MEMFS Mounting (CPK1 Blob)
// ---------------------------------------------------------------------------
const ASSET_CACHE_NAME = 'carrion-assets-v2';

function getDirname(filePath) {
    const idx = filePath.lastIndexOf('/');
    return idx === -1 ? '' : filePath.substring(0, idx);
}

async function preloadContent(FS) {
    if (!FS) {
        console.warn("[Carrion.Web] Emscripten FS not available, skipping asset loading.");
        return;
    }

    setStatus("Loading game archives...");

    let cache = null;
    try {
        if ('caches' in window) {
            cache = await caches.open(ASSET_CACHE_NAME);
        }
    } catch (_) {}

    // 1. Fetch manifest
    let manifest = null;
    try {
        const resp = await fetch("assets/content.pack.manifest.json", { cache: "no-store" });
        if (resp.ok) {
            manifest = await resp.json();
        }
    } catch (e) {
        console.warn("[Carrion.Web] Failed to fetch assets/content.pack.manifest.json:", e);
    }

    const parts = manifest?.parts || ["content.pack.00"];
    const totalParts = parts.length;
    let downloadedParts = 0;
    setStatus(`Downloading game archives (0/${totalParts})...`);

    // 2. Concurrently download all chunked parts with caching
    const partBuffers = await Promise.all(parts.map(async (partName) => {
        const url = "assets/" + partName;
        let arrayBuf = null;

        if (cache) {
            try {
                const cached = await cache.match(url);
                if (cached) {
                    arrayBuf = await cached.arrayBuffer();
                }
            } catch (_) {}
        }

        if (!arrayBuf) {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${partName}`);
            arrayBuf = await resp.arrayBuffer();
            if (cache) {
                try {
                    const cacheResp = new Response(arrayBuf.slice(0), {
                        headers: { 'Content-Type': 'application/octet-stream' }
                    });
                    await cache.put(url, cacheResp);
                } catch (_) {}
            }
        }

        downloadedParts++;
        setStatus(`Downloading game archives (${downloadedParts}/${totalParts})...`);
        return arrayBuf;
    }));

    setStatus("Unpacking game archives into memory...");
    const combinedBlob = new Blob(partBuffers);
    const fullBuffer = await combinedBlob.arrayBuffer();

    // 3. Parse CPK1 format
    const magic = new TextDecoder().decode(new Uint8Array(fullBuffer, 0, 4));
    if (magic !== 'CPK1') {
        throw new Error("[Carrion.Web] Invalid archive format magic: " + magic);
    }

    const view = new DataView(fullBuffer);
    const entryCount = view.getUint32(4, true);
    console.log(`[Carrion.Web] Extracting ${entryCount} assets from CPK1 archive (${(fullBuffer.byteLength / (1024*1024)).toFixed(2)} MB)...`);

    let offset = 8;
    const entries = [];
    const textDecoder = new TextDecoder('utf-8');

    for (let i = 0; i < entryCount; i++) {
        const pathLen = view.getUint16(offset, true);
        offset += 2;
        const pathBytes = new Uint8Array(fullBuffer, offset, pathLen);
        const relPath = textDecoder.decode(pathBytes);
        offset += pathLen;
        const dataOffset = view.getUint32(offset, true);
        offset += 4;
        const dataLen = view.getUint32(offset, true);
        offset += 4;
        entries.push({ path: relPath, dataOffset, dataLen });
    }

    const payloadStart = offset;

    // 4. Stream write into Emscripten MEMFS
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const fileBytes = new Uint8Array(fullBuffer, payloadStart + entry.dataOffset, entry.dataLen);
        const virtPath = "/Content/" + entry.path;
        const dir = getDirname(virtPath);
        if (dir) ensureDirectoryExists(FS, dir);
        FS.writeFile(virtPath, fileBytes);

        if (i % 25 === 0 || i === entries.length - 1) {
            const pct = Math.round(((i + 1) / entries.length) * 100);
            setStatus(`Extracting game assets (${pct}% — ${i + 1}/${entries.length})...`);
        }
    }

    try {
        ensureDirectoryExists(FS, "/Content");
    } catch (_) {}

    console.log(`[Carrion.Web] All ${entryCount} assets mounted into MEMFS /Content.`);
}

// ---------------------------------------------------------------------------
// 5. Main Bootstrap
// ---------------------------------------------------------------------------
try {
    const runtime = await dotnet
        .withEnvironmentVariable("FNA_PLATFORM_BACKEND", "SDL2")
        .withEnvironmentVariable("XDG_DATA_HOME", "/save")
        .withEnvironmentVariable("FNA_GAMEPAD_NUM_GAMEPADS", "16")
        .withDiagnosticTracing(false)
        .withModuleConfig({
            canvas: canvas
        })
        .create();

    if (runtime.Module && canvas) {
        runtime.Module.canvas = canvas;
    }
    let currentRafId = null;
    let isRunning = false;

    if (typeof runtime.setModuleImports === 'function') {
        runtime.setModuleImports('main.js', {
            setMainLoop: (cb) => {
                if (isRunning) return;
                isRunning = true;
                if (currentRafId !== null) {
                    cancelAnimationFrame(currentRafId);
                }
                const TARGET_FPS = 60;
                const FRAME_INTERVAL = 1000 / TARGET_FPS; // ~16.6667ms
                let lastFrameTime = performance.now();

                function step(now) {
                    currentRafId = requestAnimationFrame(step);
                    const elapsed = now - lastFrameTime;
                    if (elapsed < FRAME_INTERVAL - 1.5) {
                        return; // Throttle to 60 FPS on high-refresh (120/144/240Hz) displays
                    }
                    lastFrameTime = now - (elapsed % FRAME_INTERVAL);
                    try {
                        cb();
                    } catch (err) {
                        console.error("[Carrion JS loop frame error]", err);
                    }
                    fpsFrames++;
                }
                currentRafId = requestAnimationFrame(step);
            },
            notifyGameReady: () => {
                console.log("[Carrion JS] notifyGameReady: First frame rendered by Carrion engine!");
                window._gameReady = true;
                const overlay = document.getElementById("loading-overlay");
                if (overlay) {
                    overlay.classList.add("hidden");
                    overlay.style.display = "none";
                    overlay.style.pointerEvents = "none";
                }
            },
            playAudioEvent: (name, volume) => playGameSound(name, volume),
            stopAudioEvent: (name) => stopGameSound(name),
            triggerSyncSave: () => {
                if (window.syncSaveData) window.syncSaveData();
            },
            getVirtualMouseX: () => Math.round(virtualMouseX),
            getVirtualMouseY: () => Math.round(virtualMouseY)
        });
    }

    const FS = runtime.Module?.FS || runtime.FS || globalThis.Module?.FS;
    window.FS = FS;

    setStatus("Mounting storage filesystem...");
    await mountSave(FS);

    setStatus("Preloading game assets...");
    await preloadContent(FS);

    setStatus("Loading sound effects...");
    await preloadSfxBuffers(FS);

    setStatus("Initializing Carrion engine...");
    await new Promise(r => setTimeout(r, 50));

    await dotnet.run();
} catch (err) {
    console.error("[Carrion.Web Fatal Error]", err);
    if (progressEl) progressEl.textContent = "Fatal Error: " + (err.message || err);
}
