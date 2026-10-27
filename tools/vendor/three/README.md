# three.js (vendored)

Used only by `tools/projector-3d.html` (the laser projector concept visualisation), so it runs offline.

- Version: **three 0.186.1**, copied unchanged from the official npm package (`npm pack three@0.186.1`).
- Licence: MIT, see `LICENSE` in this folder (from the same package).
- Files and their SHA-256:
  - `three.module.js` (package `build/three.module.js`): `9052042d676cb0fdc1ddfefe193053f34b7ac0513a616fdac4535d49987812ea`
  - `three.core.js` (package `build/three.core.js`, imported by `three.module.js`): `9edde002b066a9a05676a6127f67735b62baf399bdea529f2f7e31657da769e6`
  - `addons/controls/OrbitControls.js` (package `examples/jsm/controls/OrbitControls.js`): `3d79d07ecb686b4e5d93232eedab255331c1beef711e13164eaa1f68655a5f2b`

The page maps `three` and `three/addons/` to this folder with an import map. To update, replace the three files from a newer package and update this note.
