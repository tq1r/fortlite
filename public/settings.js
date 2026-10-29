// ============================================================
//  Settings: saved in this browser (localStorage 'fl_settings').
//  Loaded before game.js, which reads FL_SET for resolution, frame limit, quality and sound.
// ============================================================
const FL_SET_DEFAULTS = {
  windowMode: 'Windowed',   // 'Fullscreen' | 'Windowed'
  renderScale: 100,         // 50 | 75 | 100 (Native)
  frameLimit: 60,           // 0 = unlimited, else 30 | 60 | 120 (reference default: 60 FPS)
  renderMode: 'Quality',    // 'Performance' (fewer effects, smaller canvas) | 'Quality'
  brightness: 100,          // 50..150 (percent)
  uiContrast: 100,          // 80..140 (percent)
  sfxVolume: 100,           // 0..100
  showFps: false,
  autoPick: false,          // pick up loot as you walk over it (off: press E)
};
function loadSettings() {
  try { return { ...FL_SET_DEFAULTS, ...JSON.parse(localStorage.getItem('fl_settings') || '{}') }; }
  catch (_) { return { ...FL_SET_DEFAULTS }; }
}
let FL_SET = loadSettings();
function saveSettings() { localStorage.setItem('fl_settings', JSON.stringify(FL_SET)); }
// Pushes the current settings into the page: brightness and contrast are CSS, the rest is read by game.js.
function applySettings() {
  if (typeof send === 'function') send({ t: 'set', autoPick: !!FL_SET.autoPick });
  const root = document.documentElement.style;
  root.setProperty('--bright', String(FL_SET.brightness / 100));
  root.setProperty('--uic', String(FL_SET.uiContrast / 100));
  const fps = document.getElementById('fpsBox');
  if (fps) fps.classList.toggle('hidden', !FL_SET.showFps);
  if (typeof onSettingsChanged === 'function') onSettingsChanged();
}
// Fullscreen needs a click, so this runs from the Apply button.
function applyWindowMode() {
  const fs = document.fullscreenElement;
  if (FL_SET.windowMode === 'Fullscreen') {
    if (!fs && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  } else if (fs && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
}
