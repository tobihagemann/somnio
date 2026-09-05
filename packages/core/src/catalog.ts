import catalogJSON from '../data/catalog.json' with { type: 'json' };
import { readCatalog } from './i18n/catalog.ts';
import type { CatalogTables } from './i18n/catalog.ts';

export * from './i18n/catalog.ts';

/** The core catalog: the character class and gender names and the inventory item labels. */
export const coreCatalog: CatalogTables = readCatalog(catalogJSON);
