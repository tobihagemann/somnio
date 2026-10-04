import catalogJSON from '../data/catalog.json' with { type: 'json' };
import { readCatalog } from './i18n/catalog.ts';
import type { CatalogTables } from './i18n/catalog.ts';

export * from './i18n/catalog.ts';

/** The core catalog: the names of the peoples and the inventory item labels. */
export const coreCatalog: CatalogTables = readCatalog(catalogJSON);
