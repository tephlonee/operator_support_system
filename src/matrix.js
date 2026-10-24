// matrix.js
// Small 2D transform helpers (move, rotate, mirror), in the same form SVG uses:
//   x' = a·x + c·y + e
//   y' = b·x + d·y + f

export const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
export const MIRROR_X = { a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 }; // mirror about the Y axis: x → −x
export const FLIP_Y = { a: 1, b: 0, c: 0, d: -1, e: 0, f: 0 };   // y → −y

export const translation = (x, y) => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });

// Counter-clockwise rotation in degrees. Multiples of 90° are made exact (no 6e-17 leftovers).
export function rotation(deg) {
  const r = deg * Math.PI / 180;
  let cos = Math.cos(r), sin = Math.sin(r);
  if (deg % 90 === 0) { cos = Math.round(cos); sin = Math.round(sin); }
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

// multiply(m, n): first apply n, then m.
export function multiply(m, n) {
  return {
    a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f,
  };
}

export const apply = (m, p) => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });

export const toSVG = m => `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`;

export const boxCorners = b => [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }];

export function bounds(points) {
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}
