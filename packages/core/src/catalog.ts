import catalogJSON from '../data/catalog.json' with { type: 'json' };
import { readCatalog } from './i18n/catalog.ts';
import type { CatalogTables } from './i18n/catalog.ts';

export * from './i18n/catalog.ts';

/** The core catalog: every name and line core's rules define, from the peoples, roles, and items to the quests and the sets. */
export const coreCatalog: CatalogTables = readCatalog(catalogJSON);
