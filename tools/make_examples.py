"""
make_examples.py
Generates the INVENTED example data for the mock-up:
  - data/parts/examples/EX-*.GEO   example parts in the TRUMPF .GEO format
  - data/jobs/example-sheet.json  an example nest: where each part sits on the sheet and which order it belongs to

None of this is real Brålanda data. The job also places the two real parts 1045572 and 1045574:
their geometry is real, but their position and order are invented.

Run from the project folder:  python tools/make_examples.py
Only the Python standard library is used.
"""
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PARTS_DIR = ROOT / 'data' / 'parts'
EX_DIR = PARTS_DIR / 'examples'
JOB_FILE = ROOT / 'data' / 'jobs' / 'example-sheet.json'
DATE = '05.10.2026'
TEXT_HEIGHT = 3.0  # same as the marked text on the real parts

# ---------- geometry ----------
# A contour is a list of elements, in running order:
#   ('LIN', start, end)
#   ('ARC', center, start, end, dir)   dir 1 = counter-clockwise, -1 = clockwise
#   ('CIR', center, radius)
# Outer contours run counter-clockwise, holes clockwise (CIR has no direction).

def rounded_rect(w, h, r):
    return [
        ('LIN', (r, 0), (w - r, 0)),
        ('ARC', (w - r, r), (w - r, 0), (w, r), 1),
        ('LIN', (w, r), (w, h - r)),
        ('ARC', (w - r, h - r), (w, h - r), (w - r, h), 1),
        ('LIN', (w - r, h), (r, h)),
        ('ARC', (r, h - r), (r, h), (0, h - r), 1),
        ('LIN', (0, h - r), (0, r)),
        ('ARC', (r, r), (0, r), (r, 0), 1),
    ]

def stadium(w, h):
    r = h / 2
    return [
        ('LIN', (r, 0), (w - r, 0)),
        ('ARC', (w - r, r), (w - r, 0), (w - r, h), 1),
        ('LIN', (w - r, h), (r, h)),
        ('ARC', (r, r), (r, h), (r, 0), 1),
    ]

def slot_hole(cx, cy, length, width):
    # Horizontal slot with round ends, clockwise like the slots in 1045572.
    r, a = width / 2, length / 2 - width / 2
    return [
        ('LIN', (cx - a, cy + r), (cx + a, cy + r)),
        ('ARC', (cx + a, cy), (cx + a, cy + r), (cx + a, cy - r), -1),
        ('LIN', (cx + a, cy - r), (cx - a, cy - r)),
        ('ARC', (cx - a, cy), (cx - a, cy - r), (cx - a, cy + r), -1),
    ]

def circle(cx, cy, r):
    return [('CIR', (cx, cy), r)]

def l_bracket(w, h, leg, fillet):
    # L shape: a horizontal leg along the bottom, a vertical leg on the left, a rounded inside corner.
    f = fillet
    return [
        ('LIN', (0, 0), (w, 0)),
        ('LIN', (w, 0), (w, leg)),
        ('LIN', (w, leg), (leg + f, leg)),
        ('ARC', (leg + f, leg + f), (leg + f, leg), (leg, leg + f), -1),
        ('LIN', (leg, leg + f), (leg, h)),
        ('LIN', (leg, h), (0, h)),
        ('LIN', (0, h), (0, 0)),
    ]

def mirror_x(contour, w):
    # Mirror about the vertical line x = w/2. Mirroring flips the running direction,
    # so the chain is reversed to keep outer contours counter-clockwise.
    m = lambda p: (w - p[0], p[1])
    out = []
    for el in reversed(contour):
        if el[0] == 'LIN':
            out.append(('LIN', m(el[2]), m(el[1])))
        elif el[0] == 'ARC':
            out.append(('ARC', m(el[1]), m(el[3]), m(el[2]), el[4]))
        else:
            out.append(('CIR', m(el[1]), el[2]))
    return out

def arc_sweep(c, s, e, d):
    a0 = math.atan2(s[1] - c[1], s[0] - c[0])
    a1 = math.atan2(e[1] - c[1], e[0] - c[0])
    sweep = a1 - a0
    if d > 0:
        while sweep <= 1e-12: sweep += 2 * math.pi
    else:
        while sweep >= -1e-12: sweep -= 2 * math.pi
    return a0, sweep

def contour_area(contour, is_hole):
    # Same method as the parser: chord polygon plus the circular segment of each arc.
    area2, seg = 0.0, 0.0
    for el in contour:
        if el[0] == 'LIN':
            a, b = el[1], el[2]
            area2 += a[0] * b[1] - b[0] * a[1]
        elif el[0] == 'ARC':
            c, s, e, d = el[1:]
            r = math.dist(s, c)
            _, sweep = arc_sweep(c, s, e, d)
            area2 += s[0] * e[1] - e[0] * s[1]
            seg += 0.5 * r * r * (sweep - math.sin(sweep))
        else:
            seg += math.pi * el[2] ** 2
    area = area2 / 2 + seg
    if all(el[0] == 'CIR' for el in contour):
        return -abs(area) if is_hole else abs(area)
    if (area > 0) == is_hole:
        raise ValueError('contour runs the wrong way: outer contours must be counter-clockwise, holes clockwise')
    return area

def contour_points(contour):
    # Polyline through the contour, sampled like the parser does. Used for bounding boxes and the centroid.
    pts = []
    for el in contour:
        if el[0] == 'LIN':
            pts += [el[1], el[2]]
        else:
            if el[0] == 'ARC':
                c, s, e, d = el[1:]
                r = math.dist(s, c)
            else:
                c, r, d = el[1], el[2], 1
                s = e = (c[0] + r, c[1])
            a0, sweep = arc_sweep(c, s, e, d)
            n = max(6, math.ceil(abs(sweep) / (math.pi / 64)))
            pts += [(c[0] + r * math.cos(a0 + sweep * k / n), c[1] + r * math.sin(a0 + sweep * k / n)) for k in range(n + 1)]
    return pts

def bbox(points):
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    return min(xs), min(ys), max(xs), max(ys)

def centroid(contours):
    sx = sy = sa = 0.0
    for c in contours:
        p = contour_points(c)
        for (x0, y0), (x1, y1) in zip(p, p[1:] + p[:1]):
            cr = x0 * y1 - x1 * y0
            sa += cr; sx += (x0 + x1) * cr; sy += (y0 + y1) * cr
    return sx / (3 * sa), sy / (3 * sa)

# ---------- .GEO writer ----------

def num(v):
    v = 0.0 if abs(v) < 5e-10 else v
    return f'{v:.9f}'

def xyz(p):
    return f'{num(p[0])} {num(p[1])} {num(0)}'

def write_geo(path, part_no, name, outer, holes, text_at, text_angle, quantity):
    contours = [outer] + holes
    areas = [contour_area(outer, False)] + [contour_area(h, True) for h in holes]
    net_area = sum(areas)
    pbox = bbox(contour_points(outer))
    cx, cy = centroid(contours)

    # Shared point list, numbered in x-then-y order like the real files.
    keys = set()
    for c in contours:
        for el in c:
            for p in el[1:]:
                if isinstance(p, tuple): keys.add((round(p[0], 9), round(p[1], 9)))
    keys.add((round(text_at[0], 9), round(text_at[1], 9)))
    ids = {p: i + 1 for i, p in enumerate(sorted(keys))}
    pid = lambda p: ids[(round(p[0], 9), round(p[1], 9))]

    L = ['#~1', '1.03', '2', DATE, xyz(pbox[:2]), xyz(pbox[2:]), num(net_area), '1', '0.001000000', '0', '1', '##~~']
    L += ['#~11', 'Plåt 8mm', name, '', '', 'EXAMPLE', 'st37-80', num(8), '', '', '',
          '0', '0', '0', '0', '1', '0', '0', '0', '0', '', '##~~', '#~END']
    L += ['#~3', name, 'LASER', '', '0.000000000 0.000000000 1.000000000',
          '1.000000000 0.000000000 0.000000000 0.000000000', '0.000000000 1.000000000 0.000000000 0.000000000',
          '0.000000000 0.000000000 1.000000000 0.000000000', '0.000000000 0.000000000 0.000000000 1.000000000',
          xyz(pbox[:2]), xyz(pbox[2:]), xyz((cx, cy)), num(net_area), str(len(contours)), '0', '0', '0', '0', '##~~']
    attrs = {
        'ANSI_CODEPAGE': '1252', 'AUFTR': 'EXAMPLE', 'BEZCH': name, 'DREHINKR': '90', 'EXAMPLE': '1',
        'IDENT': 'Plåt 8mm', 'MAT': 'st37-80', 'ROTALLOWED': '1',
        'SOURCE_FILE_NAME': 'invented example (tools/make_examples.py)',
        'TEILANZAHL': str(quantity), 'WERKSTOFF': '1.0038',
    }
    L += ['#~30'] + [f'{k}@{v}' for k, v in attrs.items()] + ['#~TTINFO_END']
    L += ['#~31']
    for p, i in sorted(ids.items(), key=lambda kv: kv[1]):
        L += ['P', str(i), xyz(p), '|~']
    L += ['##~~', '#~36', 'ATT', '1', '7', '|~', '#~ATTRIBUTE_END']
    L += ['#~32', 'TXT', '3 1', str(pid(text_at)), '10.000000000 1.000000000 0.000000000',
          f'{num(TEXT_HEIGHT)} {num(text_angle)}', '18 1 1', part_no, '1', '1', '|~', '##~~']
    for k, (c, area) in enumerate(zip(contours, areas)):
        is_hole = k > 0
        cb = bbox(contour_points(c))
        only_circle = all(el[0] == 'CIR' for el in c)
        normal = -1 if is_hole and not only_circle else 1  # as in the real files
        L += ['#~33', '', f'{k + 1} 24 {int(is_hole)}', '0' if is_hole else str(len(holes)),
              f'{num(0)} {num(0)} {num(normal)}', xyz(cb[:2]), xyz(cb[2:]),
              xyz(((cb[0] + cb[2]) / 2, (cb[1] + cb[3]) / 2)), num(abs(area)), str(int(is_hole)), '##~~', '#~331']
        for el in c:
            if el[0] == 'LIN':
                L += ['LIN', '1 0', f'{pid(el[1])} {pid(el[2])}', '|~']
            elif el[0] == 'ARC':
                L += ['ARC', '1 0', f'{pid(el[1])} {pid(el[2])} {pid(el[3])}', str(el[4]), '|~']
            else:
                L += ['CIR', '1 0', str(pid(el[1])), num(el[2]), '|~']
        L += ['##~~', '#~KONT_END']
    L += ['#~END', '#~EOF']
    path.write_bytes(('\r\n'.join(L) + '\r\n').encode('cp1252'))
    return {'partNo': part_no, 'file': path.name, 'size': (pbox[2], pbox[3]), 'holes': len(holes), 'area': net_area}

# ---------- the invented example parts ----------

def make_parts():
    EX_DIR.mkdir(parents=True, exist_ok=True)
    made = []

    def plate(part_no, n_holes):
        corners = [(30, 30), (370, 30), (30, 220), (370, 220)][:n_holes]
        holes = [circle(x, y, 9) for x, y in corners] + [slot_hole(200, 125, 80, 20)]
        made.append(write_geo(EX_DIR / f'{part_no}.GEO', part_no, f'EXAMPLE plate 400x250, {n_holes} holes + slot',
                              rounded_rect(400, 250, 15), holes, (170, 60), 0, 3))

    def flange(part_no, n_bolts):
        holes = [circle(180, 180, 70)]
        holes += [circle(180 + 140 * math.cos(2 * math.pi * k / n_bolts), 180 + 140 * math.sin(2 * math.pi * k / n_bolts), 11)
                  for k in range(n_bolts)]
        made.append(write_geo(EX_DIR / f'{part_no}.GEO', part_no, f'EXAMPLE flange D360, {n_bolts} bolt holes',
                              circle(180, 180, 180), holes, (160, 75), 0, 2))

    plate('EX-2001', 4)
    plate('EX-2002', 3)   # near-duplicate of EX-2001: one corner hole fewer
    flange('EX-2003', 6)
    flange('EX-2004', 8)  # near-duplicate of EX-2003: 8 bolt holes instead of 6

    l_outer = l_bracket(300, 200, 80, 10)
    l_holes = [circle(260, 40, 8), circle(40, 160, 8), circle(40, 40, 8)]
    made.append(write_geo(EX_DIR / 'EX-2005.GEO', 'EX-2005', 'EXAMPLE L-bracket 300x200, right hand',
                          l_outer, l_holes, (120, 35), 0, 2))
    # Near-duplicate: the mirror image (left-hand version) of EX-2005, a separate part number.
    made.append(write_geo(EX_DIR / 'EX-2006.GEO', 'EX-2006', 'EXAMPLE L-bracket 300x200, left hand',
                          mirror_x(l_outer, 300), [mirror_x(h, 300) for h in l_holes], (167, 35), 0, 2))

    made.append(write_geo(EX_DIR / 'EX-2007.GEO', 'EX-2007', 'EXAMPLE tab 80x40, 1 hole',
                          stadium(80, 40), [circle(60, 20, 6)], (22, 18), 0, 4))
    made.append(write_geo(EX_DIR / 'EX-2008.GEO', 'EX-2008', 'EXAMPLE tab 80x40, 2 holes',
                          stadium(80, 40), [circle(20, 20, 6), circle(60, 20, 6)], (32, 18), 0, 3))
    return made

# ---------- the invented example job (nest + orders) ----------

SHEET = (3000, 1500)
MARGIN, GAP = 10, 10

# Each part instance belongs to an (invented) order. Which pallet it goes on is decided by the operator
# in the app at the start of the job, so the job file has no pallets.
ORDER_OF = {'P1': 'EX-AO-01', 'P2': 'EX-AO-02', 'P3': 'EX-AO-03', 'P4': 'EX-AO-04'}

# (part number, lower-left corner of the part's box on the sheet, rotation, order group P1–P4)
# Near-duplicates sit next to each other but belong to different orders: the mix-up the system must prevent.
PLACEMENTS = [
    ('1045574', (15, 15), 0, 'P1'),
    ('1045574', (15, 165), 0, 'P2'),
    ('EX-2001', (15, 315), 0, 'P1'),
    ('EX-2002', (430, 315), 0, 'P3'),
    ('EX-2001', (15, 580), 0, 'P2'),
    ('EX-2002', (430, 580), 0, 'P3'),
    ('EX-2005', (15, 845), 0, 'P1'),
    ('EX-2006', (330, 845), 0, 'P4'),
    ('EX-2007', (645, 845), 0, 'P1'),
    ('EX-2008', (740, 845), 0, 'P2'),
    ('EX-2007', (645, 900), 0, 'P3'),
    ('EX-2008', (740, 900), 0, 'P4'),
    ('EX-2007', (645, 955), 0, 'P1'),
    ('EX-2008', (740, 955), 0, 'P4'),
    ('1045572', (15, 1060), 0, 'P1'),
    ('1045572', (195, 1060), 0, 'P1'),
    ('1045572', (375, 1060), 0, 'P2'),
    ('1045572', (555, 1060), 0, 'P2'),
    ('EX-2005', (15, 1165), 180, 'P4'),
    ('EX-2006', (330, 1165), 180, 'P1'),
    ('EX-2003', (863, 15), 0, 'P2'),
    ('EX-2003', (863, 390), 0, 'P3'),
    ('EX-2004', (863, 765), 0, 'P4'),
    ('EX-2001', (1238, 15), 90, 'P3'),
    ('EX-2002', (1238, 430), 90, 'P4'),
    ('EX-2007', (1238, 845), 90, 'P2'),
]

def read_real_bbox(file_name):
    lines = (PARTS_DIR / file_name).read_text(encoding='cp1252').splitlines()
    i = lines.index('#~1')
    lo = [float(v) for v in lines[i + 4].split()]
    hi = [float(v) for v in lines[i + 5].split()]
    return lo[0], lo[1], hi[0], hi[1]

def placed_box(part_box, rot, mirror=False):
    # Box of the part after mirror (about its Y axis) and rotation (counter-clockwise, about its origin).
    x0, y0, x1, y1 = part_box
    pts = []
    for x, y in [(x0, y0), (x1, y0), (x0, y1), (x1, y1)]:
        if mirror: x = -x
        a = math.radians(rot)
        pts.append((x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a)))
    return bbox(pts)

def make_job(made):
    boxes = {m['partNo']: (0, 0, m['size'][0], m['size'][1]) for m in made}
    geo = {m['partNo']: 'examples/' + m['file'] for m in made}
    for real in ('1045572', '1045574'):
        boxes[real] = read_real_bbox(real + '.GEO')
        geo[real] = real + '.GEO'

    parts, placed = [], []
    for n, (part_no, (bx, by), rot, pallet) in enumerate(PLACEMENTS, 1):
        b = placed_box(boxes[part_no], rot)
        x, y = bx - b[0], by - b[1]  # where the part's own origin lands on the sheet
        box = (bx, by, bx + b[2] - b[0], by + b[3] - b[1])
        uid = f'EX-S001-{n:02d}'
        if box[0] < MARGIN or box[1] < MARGIN or box[2] > SHEET[0] - MARGIN or box[3] > SHEET[1] - MARGIN:
            raise ValueError(f'{uid} ({part_no}) sticks out of the sheet: {box}')
        for other_uid, ob in placed:
            if box[0] < ob[2] + GAP and ob[0] < box[2] + GAP and box[1] < ob[3] + GAP and ob[1] < box[3] + GAP:
                raise ValueError(f'{uid} ({part_no}) is closer than {GAP} mm to {other_uid}')
        placed.append((uid, box))
        parts.append({'uid': uid, 'partNo': part_no, 'geo': geo[part_no], 'x': round(x, 3), 'y': round(y, 3),
                      'rot': rot, 'mirror': False, 'order': ORDER_OF[pallet]})

    head = {
        'sheet': 'EX-S001',
        'size': list(SHEET),
        'thickness': 8,
        'material': 'S235JR',
        'example': True,
        'note': 'Invented example job for the mock-up. The layout and orders are NOT real Brålanda data. '
                'Parts 1045572 and 1045574 use real Brålanda part geometry; all EX- parts are invented.',
    }
    # One part per line, so the file is easy to read and edit by hand.
    out = ['{']
    out += [f'  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)},' for k, v in head.items()]
    out += ['  "parts": [', ',\n'.join('    ' + json.dumps(p) for p in parts), '  ]', '}']
    JOB_FILE.parent.mkdir(parents=True, exist_ok=True)
    JOB_FILE.write_text('\n'.join(out) + '\n', encoding='utf-8')
    return parts

if __name__ == '__main__':
    made = make_parts()
    for m in made:
        print(f"  {m['file']:<12} {m['size'][0]:.0f} x {m['size'][1]:.0f} mm, {m['holes']} holes, net area {m['area']:.2f} mm2")
    parts = make_job(made)
    per_order = {o: sum(1 for q in parts if q['order'] == o) for o in ORDER_OF.values()}
    print(f'  {JOB_FILE.relative_to(ROOT)}: {len(parts)} parts on the sheet, per order {per_order}')
    print('Done. All parts fit on the sheet without overlapping.')
