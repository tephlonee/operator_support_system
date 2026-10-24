// make-demo-z.mjs
// Builds a stand-in for Brålanda's Z:\ share, for running the pipeline service on a laptop:
//
//   demo-z/L95/J14/J14_1.LST        the real J14 job (+ 1045572.GEO, 1045574.GEO; 1045575.GEO is
//                                   really missing, so the job shows as "incomplete")
//   demo-z/L96/EX-S001/EX-S001.LST  the INVENTED example sheet, written as an LST file so it goes
//                                   through the same pipeline (+ its invented GEO files)
//
// Run from the project folder:  node tools/make-demo-z.mjs [target folder]   (default: demo-z)
// Then copy more job folders into it by hand (copy and paste, as the programmer does) and watch them
// appear on the screens.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGEO } from '../src/geo-parser.js';
import { placementMatrix } from '../src/nest-loader.js';
import * as M from '../src/matrix.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.resolve(ROOT, process.argv[2] || 'demo-z');
const geoText = file => new TextDecoder('windows-1252').decode(fs.readFileSync(file));

export function makeDemoZ(dir) {
  // 1. The real job, as the programmer would paste it.
  const j14 = path.join(dir, 'L95', 'J14');
  fs.mkdirSync(j14, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'data/jobs/J14.LST'), path.join(j14, 'J14_1.LST'));
  for (const g of ['1045572.GEO', '1045574.GEO']) fs.copyFileSync(path.join(ROOT, 'data/parts', g), path.join(j14, g));

  // 2. The invented example sheet, converted to the LST format.
  const ex = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/jobs/example-sheet.json'), 'utf8'));
  const exDir = path.join(dir, 'L96', ex.sheet);
  fs.mkdirSync(exDir, { recursive: true });
  fs.writeFileSync(path.join(exDir, `${ex.sheet}.LST`), Buffer.from(exampleLST(ex, exDir), 'latin1'));
  return dir;
}

// A minimal LST with the tables the app and the pipeline read. Positions are the lower-left corner of
// each piece's box on the sheet, as TruTops writes them.
function exampleLST(ex, exDir) {
  const palletOrder = new Map((ex.pallets || []).map(p => [p.id, p.order]));
  const geos = new Map();
  for (const p of ex.parts) {
    if (geos.has(p.partNo)) continue;
    const src = path.join(ROOT, 'data/parts', p.geo);        // e.g. examples/EX-2001.GEO
    const name = path.basename(p.geo);
    fs.copyFileSync(src, path.join(exDir, name));
    geos.set(p.partNo, { file: name, geo: parseGEO(geoText(src), name), count: 0 });
  }
  for (const p of ex.parts) geos.get(p.partNo).count++;
  const q = s => `'${s}'`;
  const table = (name, cols, rows) => [
    `BEGIN_${name}`, `ZA,MM,${cols.length}`,
    ...cols.map(([no, title]) => `MM,AT,1, ${String(no).padStart(3)},1,1,,'${title}',,'',T`),
    `ZA,DA,${rows.length}`, ...rows.map(r => `DA,${r.join(',')}`), `ENDE_${name}`, 'C',
  ];
  const f2 = n => (+n).toFixed(2);
  const pos = ex.parts.map((p, i) => {
    const g = geos.get(p.partNo).geo;
    const b = M.bounds(M.boxCorners(g.bbox).map(c => M.apply(placementMatrix(p.x, p.y, p.rot || 0, !!p.mirror), c)));
    return { n: i + 1, partNo: p.partNo, x: b.minX, y: b.minY, rot: p.rot || 0, mirror: p.mirror ? 1 : 0, order: p.order ?? palletOrder.get(p.pallet) };
  });
  return [
    'C INVENTED EXAMPLE: not real Brålanda data. Written by tools/make-demo-z.mjs',
    ...table('FERTIGUNG_AUFTRAG_TMP', [[10, 'Jobname'], [20, 'FertAuftrBez'], [30, 'FertStatus'], [40, 'Programmname'], [50, 'SollAnzahl']],
      [[q(ex.sheet), q(ex.sheet), q('0'), q(ex.sheet), 1]]),
    ...table('EINRICHTEPLAN_INFO', [[10, 'Maschine'], [80, 'Datum'], [280, 'viewer name machine']], [[q('L96'), q('01.10.2026'), q('Example machine (L96)')]]),
    ...table('ANALYTICS_DATA', [[10, 'AnalyticsKey'], [20, 'AnalyticsValue']], [[q('NcProgramGuid'), q('00000000-example-0000-0000-000000000001')]]),
    ...table('SHEET_TECH', [[20, 'Blechmass X'], [30, 'Blechmass Y'], [40, 'Blechmass Z'], [240, 'Materialkennung']],
      [[ex.size[0], ex.size[1], ex.thickness, q(ex.material)]]),
    ...table('PARTS_IN_PROGRAM', [[30, 'Teil-Identnummer'], [50, 'Geometriefilename'], [60, 'Anzahl'], [90, 'Flaeche'], [130, 'Abmessung X'], [140, 'Abmessung Y']],
      [...geos].map(([no, g]) => [q(no), q(g.file), g.count, f2(g.geo.netArea), f2(g.geo.bbox.maxX - g.geo.bbox.minX), f2(g.geo.bbox.maxY - g.geo.bbox.minY)])),
    ...table('PARTS_IN_PROGRAM_POS', [[10, 'laufende Nummer'], [30, 'Teil-Identnummer'], [60, 'Position X'], [70, 'Position Y'], [100, 'Winkellage'], [330, 'Mirrored At Y']],
      pos.map(p => [p.n, q(p.partNo), f2(p.x), f2(p.y), f2(p.rot), p.mirror])),
    ...table('PARTORDER_IN_PRODORDER', [[10, 'laufende Nummer'], [30, 'Teil-Identnummer'], [40, 'Auftrag']],
      pos.map(p => [p.n, q(p.partNo), q(p.order)])),
    'ED', 'C', '',
  ].join('\r\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  makeDemoZ(target);
  console.log(`Demo Z:\\ folder written to ${target}`);
}
