// run-tests.js
// Runs every test module and shows the results on test/index.html.

import { check, renderResults } from './harness.js';
import { testGeoParser, renderGallery } from './geo-parser.test.js';
import { testNestLoader } from './nest-loader.test.js';
import { testPicking } from './picking.test.js';
import { testSettings } from './settings.test.js';
import { testLog } from './log.test.js';
import { testPlan } from './plan.test.js';
import { testLookAlike } from './lookalike.test.js';

try {
  const parts = await testGeoParser();
  await testNestLoader();
  await testPicking();
  await testSettings();
  await testLog();
  await testPlan();
  await testLookAlike();
  renderGallery(parts);
} catch (e) {
  check('Test run finished without crashing', false, e.message);
}
renderResults();
