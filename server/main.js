// main.js
// Starts the pipeline service: opens the database, polls Z:\ every few seconds, serves the app and the
// API to the monitors, and once a day makes a backup and tidies up old log lines and raw copies.
//
//   node server/main.js                      settings from server/config.json (if it exists)
//   node server/main.js --config my.json     settings from another file
//   node server/main.js --z ./demo-z --data ./.pipeline-data --port 8080
//
// Needs Node.js 22.13 or later (for the built-in SQLite, node:sqlite). Nothing to npm install.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { Pipeline } from './pipeline.js';
import { createServer } from './api.js';
import { localDate } from './catalog.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');

export const DEFAULTS = {
  zRoot: process.platform === 'win32' ? 'Z:\\' : path.join(APP_ROOT, 'demo-z'),
  dataDir: process.platform === 'win32' ? 'C:\\OperatorPicking' : path.join(APP_ROOT, '.pipeline-data'),
  host: '0.0.0.0',          // every monitor on the LAN can connect
  port: 8080,
  pollSeconds: 15,
  geoWaitMinutes: 5,        // how long a missing GEO is "waiting" before the job is listed as incomplete
  recentDays: 7,            // never-sorted jobs stay on the default list this long after they appeared
  geoFolders: [],           // extra folders under Z:\ where GEO files may be, e.g. ["GEO"]
  maxDepth: 4,              // how deep to look for LST files under Z:\
  backupHour: 2,            // the daily backup runs after this hour
  keepBackups: 14,
  scanLogDays: 30,
  rawRetentionDays: 90,     // raw copies of jobs that left Z:\ are kept this long after their last run
};

export function loadConfig(argv = process.argv.slice(2)) {
  const arg = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const file = arg('config') || path.join(HERE, 'config.json');
  let fromFile = {};
  if (fs.existsSync(file)) fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = { ...DEFAULTS, ...fromFile };
  if (arg('z')) cfg.zRoot = arg('z');
  if (arg('data')) cfg.dataDir = arg('data');
  if (arg('port')) cfg.port = +arg('port');
  if (arg('poll')) cfg.pollSeconds = +arg('poll');
  for (const k of ['zRoot', 'dataDir']) cfg[k] = path.resolve(APP_ROOT, cfg[k]);
  return cfg;
}

// Daily: a consistent backup copy of the database, old scan-log lines removed, raw copies of jobs that
// have left Z:\ and have not been worked on for a long time removed (their runs and events stay).
export function housekeeping(store, cfg, now = new Date()) {
  const out = { backup: store.backup(path.join(cfg.dataDir, 'backup'), localDate(now.toISOString()), cfg.keepBackups) };
  out.logLinesRemoved = Number(store.run('DELETE FROM scan_log WHERE at < ?', new Date(now - cfg.scanLogDays * 864e5).toISOString()).changes);
  const cutoff = new Date(now - cfg.rawRetentionDays * 864e5).toISOString();
  out.rawRemoved = 0;
  for (const name of fs.readdirSync(store.rawDir)) {
    if (!/^[0-9a-f]{64}$/.test(name)) continue;
    const onZ = store.get(`SELECT 1 FROM files WHERE sha256 = ? AND status != 'gone'`, name);
    const recent = store.get(`SELECT 1 FROM sorting_runs WHERE sha256 = ? AND (phase IN ('setup', 'sort') OR updated >= ?)`, name, cutoff);
    const job = store.job(name);
    if (onZ || recent || (job && job.first_seen >= cutoff)) continue;
    fs.rmSync(path.join(store.rawDir, name), { recursive: true, force: true });
    out.rawRemoved++;
  }
  store.log(now.toISOString(), 'info', null, `Housekeeping: backup ${path.basename(out.backup)}, ${out.logLinesRemoved} old log lines, ${out.rawRemoved} old raw copies removed`);
  return out;
}

function addresses(port) {
  return Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => `http://${a.address}:${port}/`);
}

async function main() {
  const cfg = loadConfig();
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const store = new Store(cfg.dataDir);
  const pipeline = new Pipeline(store, cfg);
  const tick = () => { try { pipeline.poll(); } catch (e) { console.error('Poll failed:', e); } };
  tick();
  setInterval(tick, cfg.pollSeconds * 1000);

  let lastHousekeeping = '';
  const daily = () => {
    const now = new Date();
    const today = localDate(now.toISOString());
    if (today === lastHousekeeping || now.getHours() < cfg.backupHour) return;
    if (fs.existsSync(path.join(cfg.dataDir, 'backup', `picking-${today}.db`))) { lastHousekeeping = today; return; }
    try { housekeeping(store, cfg, now); lastHousekeeping = today; } catch (e) { console.error('Housekeeping failed:', e); }
  };
  daily();
  setInterval(daily, 10 * 60e3);

  const server = createServer({ store, pipeline, appRoot: APP_ROOT, config: cfg });
  server.listen(cfg.port, cfg.host, () => {
    console.log(`Picking support pipeline service`);
    console.log(`  Z:\\ folder : ${cfg.zRoot}`);
    console.log(`  Data      : ${cfg.dataDir} (picking.db, raw\\, backup\\)`);
    console.log(`  Polling   : every ${cfg.pollSeconds} s`);
    console.log(`  Open on the monitors: ${[`http://localhost:${cfg.port}/`, ...addresses(cfg.port)].join('  ')}`);
  });
  const stop = () => { server.close(); store.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
