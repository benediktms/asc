# ADR-008: SQLite stores events and materialized snapshots

Status: accepted

Task events are append-only while the current A2A Task snapshot is updated in the same short transaction for efficient reads.
