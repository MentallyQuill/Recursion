// The full selected catalog is serialized once alongside this scope. Keep all
// scope decisions and authored instructions; remove only duplicated catalogs.
export function compactArbiterScope(scope = {}) {
  const { availableCatalog, allowedCatalog, ...decisions } = scope;
  return decisions;
}
