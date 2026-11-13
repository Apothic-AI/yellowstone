/**
 * CatalogError: the one loud error shape for definition-read and definition
 * validation failures.
 *
 * It lives in its own module so the pure composition surface can throw the
 * same error type without importing the catalog that calls it. `profile-catalog`
 * re-exports it, so every existing importer keeps its import path.
 */

export class CatalogError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CatalogError";
	}
}
