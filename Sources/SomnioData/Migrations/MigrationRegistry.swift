import Foundation

/// In-process registry of schema migrations applied at server boot.
///
/// Each entry is a single ordered list of SQL statements; PostgresNIO's extended-query
/// protocol forbids more than one statement per `Parse` message, so multi-statement
/// migrations are split here. The runner wraps the entire list in one transaction.
///
/// `schema_migrations` is created lazily by the runner before reading applied versions, so
/// no migration manages the bookkeeping table.
public enum MigrationRegistry {
    public static let all: [Migration] = [
        Migration(
            version: 1,
            name: "create_accounts",
            statements: [
                // `name_normalized` is the UNIQUE-enforced column so case- and Unicode-confusable
                // collisions ("Admin" vs "admin" vs "АDMIN" with Cyrillic А) cannot coexist
                // and impersonate each other once names surface to other clients. The raw
                // `name` is preserved verbatim for display.
                """
                CREATE TABLE accounts (
                    id UUID PRIMARY KEY,
                    name TEXT NOT NULL,
                    name_normalized TEXT NOT NULL UNIQUE \
                        GENERATED ALWAYS AS (LOWER(NORMALIZE(name, NFKC))) STORED,
                    password_hash TEXT NOT NULL,
                    email TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            ]
        ),
        Migration(
            version: 2,
            name: "create_characters",
            statements: [
                """
                CREATE TABLE characters (
                    id UUID PRIMARY KEY,
                    account_id UUID NOT NULL REFERENCES accounts ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    name_normalized TEXT NOT NULL UNIQUE \
                        GENERATED ALWAYS AS (LOWER(NORMALIZE(name, NFKC))) STORED,
                    figure SMALLINT NOT NULL,
                    gender SMALLINT NOT NULL,
                    current_sector TEXT NOT NULL,
                    position_x SMALLINT NOT NULL,
                    position_y SMALLINT NOT NULL,
                    facing SMALLINT NOT NULL,
                    tempo SMALLINT NOT NULL,
                    hp_current SMALLINT NOT NULL,
                    hp_max SMALLINT NOT NULL,
                    balance_current SMALLINT NOT NULL,
                    balance_max SMALLINT NOT NULL,
                    mana_current SMALLINT NOT NULL,
                    mana_max SMALLINT NOT NULL,
                    last_seen TIMESTAMPTZ NOT NULL,
                    CHECK (hp_current <= hp_max),
                    CHECK (balance_current <= balance_max),
                    CHECK (mana_current <= mana_max)
                )
                """
            ]
        ),
        Migration(
            version: 3,
            name: "create_inventory_rows",
            statements: [
                """
                CREATE TABLE inventory_rows (
                    character_id UUID NOT NULL REFERENCES characters ON DELETE CASCADE,
                    slot SMALLINT NOT NULL,
                    category SMALLINT NOT NULL,
                    item_id SMALLINT NOT NULL,
                    extras JSONB NOT NULL DEFAULT '[]'::jsonb,
                    equipped_hand SMALLINT,
                    PRIMARY KEY (character_id, slot),
                    CHECK (equipped_hand IS NULL OR equipped_hand IN (0, 1))
                )
                """,
                """
                COMMENT ON COLUMN inventory_rows.extras IS \
                'Ordered JSONB array of {"key": String, "value": Int16}; \
                the array form preserves [InventoryExtra] ordering -- DO NOT simplify to a JSON object map.'
                """,
                """
                COMMENT ON COLUMN inventory_rows.equipped_hand IS \
                'Hand.rawValue: 0=left, 1=right; NULL when not equipped.'
                """
            ]
        ),
        Migration(
            version: 4,
            name: "create_world_clock",
            statements: [
                """
                CREATE TABLE world_clock (
                    id BOOLEAN PRIMARY KEY DEFAULT TRUE,
                    second SMALLINT NOT NULL,
                    minute SMALLINT NOT NULL,
                    hour SMALLINT NOT NULL,
                    day SMALLINT NOT NULL,
                    month SMALLINT NOT NULL,
                    year SMALLINT NOT NULL,
                    CHECK (id = TRUE)
                )
                """,
                """
                COMMENT ON TABLE world_clock IS \
                'Single-row table; PK BOOLEAN + CHECK forbids a second row. \
                Seeded by the server on first boot from WorldClock.bootDefault.'
                """
            ]
        ),
        Migration(
            version: 5,
            name: "create_npc_dialog_states",
            statements: [
                """
                CREATE TABLE npc_dialog_states (
                    sector_name TEXT NOT NULL,
                    npc_index SMALLINT NOT NULL,
                    script_step SMALLINT NOT NULL,
                    PRIMARY KEY (sector_name, npc_index)
                )
                """
            ]
        )
    ]
}
