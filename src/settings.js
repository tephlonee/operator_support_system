// settings.js
// Station settings, saved in this browser. Each unloading station has its own screen,
// so each station keeps its own settings: its station ID, how the sheet is turned/mirrored,
// the pick order, and whether the view zooms in on small parts.
// These (and the language) are the only things the browser keeps for itself when the app runs
// with the pipeline service; jobs and progress live on the server.

import { PICK_ORDERS } from './picking.js';

const STORAGE_KEY = 'operator-picking.station';
export const DEFAULTS = Object.freeze({ rotation: 0, mirror: false, order: 'pallet', zoomSmall: true, stationId: '' });

// Station ID: the name of this unloading station, e.g. "L95". Letters, digits, space, _ . - (max 20).
export const cleanStationId = v => (typeof v === 'string' && /^[\w .-]{0,20}$/.test(v.trim()) ? v.trim() : '');

// Only known values get through; anything else falls back to the default.
export function sanitize(s) {
  const v = s && typeof s === 'object' ? s : {};
  return {
    rotation: [0, 90, 180, 270].includes(v.rotation) ? v.rotation : DEFAULTS.rotation,
    mirror: typeof v.mirror === 'boolean' ? v.mirror : DEFAULTS.mirror,
    order: PICK_ORDERS.includes(v.order) ? v.order : DEFAULTS.order,
    zoomSmall: typeof v.zoomSmall === 'boolean' ? v.zoomSmall : DEFAULTS.zoomSmall,
    stationId: cleanStationId(v.stationId),
  };
}

export function loadSettings() {
  try { return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY))); }
  catch { return { ...DEFAULTS }; }
}

// Returns false if the browser would not save (e.g. private window); the settings still apply until reload.
export function saveSettings(settings) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitize(settings))); return true; }
  catch { return false; }
}
