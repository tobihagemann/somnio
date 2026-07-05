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
                // `name_normalized` is the UNIQUE-enforced column so case- and NFKC-confusable
                // collisions ("Admin" vs "admin" vs full-width "ａｄｍｉｎ") cannot coexist and
                // impersonate each other once names surface to other clients. The raw `name` is
                // preserved verbatim for display. NFKC does NOT fold cross-script lookalikes
                // ("АDMIN" with Cyrillic А vs Latin "ADMIN"); migration v6's `name_skeleton`
                // column closes that gap.
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
        ),
        // The TR39 confusable skeleton (Swift-computed, so not a generated column) closes the
        // cross-script lookalike gap NFKC leaves open. Nullable + a partial UNIQUE index so the
        // column rolls out ahead of the server-startup backfill: legacy NULL-skeleton rows don't
        // block, while every new insert is deduplicated immediately. `name_skeleton_version`
        // records `NamePolicy.skeletonAlgorithmVersion` so the backfill can recompute stale rows
        // after a Unicode/algorithm bump. The defense-in-depth presence CHECK is deliberately
        // deferred to a later release (after one boot has run the backfill) so a VALIDATE pass
        // never fails boot on a populated table.
        Migration(
            version: 6,
            name: "add_name_skeleton",
            statements: [
                "ALTER TABLE accounts ADD COLUMN name_skeleton TEXT, ADD COLUMN name_skeleton_version INTEGER",
                """
                CREATE UNIQUE INDEX accounts_name_skeleton_key ON accounts (name_skeleton) \
                WHERE name_skeleton IS NOT NULL
                """,
                "ALTER TABLE characters ADD COLUMN name_skeleton TEXT, ADD COLUMN name_skeleton_version INTEGER",
                """
                CREATE UNIQUE INDEX characters_name_skeleton_key ON characters (name_skeleton) \
                WHERE name_skeleton IS NOT NULL
                """
            ]
        ),
        // Facing becomes a continuous heading in degrees (0 = south, 90 = east, 180 = north,
        // 270 = west). The USING cast maps existing rows' Direction.rawValue (N=0/E=1/S=2/W=3)
        // to the heading convention so pre-migration characters keep facing the same way.
        Migration(
            version: 7,
            name: "migrate_facing_to_heading",
            statements: [
                """
                ALTER TABLE characters ALTER COLUMN facing TYPE REAL \
                USING (CASE facing WHEN 0 THEN 180 WHEN 1 THEN 90 WHEN 2 THEN 0 WHEN 3 THEN 270 ELSE 0 END)
                """
            ]
        )
    ]
}
