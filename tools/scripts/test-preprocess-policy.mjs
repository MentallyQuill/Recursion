import { compactArbiterScope } from '../../src/runtime/preprocess-policy.mjs';
import { CARD_SCOPE_CATALOG } from '../../src/card-scope.mjs';
import { assertDeepEqual, assertEqual } from '../../tests/helpers/assert.mjs';
const decisions = { selectedFamilies: ['Scene Frame'], forcedFamilies: ['Scene Constraints'],
  selectedSubItems: ['location'], authoredInstructions: ['Keep the locked door closed.'] };
const scope = { ...decisions, availableCatalog: CARD_SCOPE_CATALOG, allowedCatalog: CARD_SCOPE_CATALOG };
assertDeepEqual(compactArbiterScope(scope), decisions, 'all selection and authored decisions survive');
assertEqual(Object.hasOwn(scope, 'availableCatalog'), true, 'projection leaves original scope untouched');
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
console.log(`Planner scope fixture: ${bytes(scope)} -> ${bytes(compactArbiterScope(scope))} bytes (catalog still supplied once separately).`);
