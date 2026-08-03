/**
 * getDatabaseStats() must survive a SQLite build without the `dbstat` virtual
 * table.
 *
 * `dbstat` is compile-time optional (ENABLE_DBSTAT_VTAB) and is absent from
 * sql.js/WASM builds. Before the fix, the unguarded per-table `SELECT SUM(pgsize)
 * FROM dbstat` threw, which propagated out of getDatabaseStats() and made
 * GET/PATCH /api/settings/database return HTTP 500 — the whole database settings
 * page became unusable on those runtimes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { getDatabaseStats } from "@/lib/db/stats";
import type { PreparedStatement, SqliteAdapter } from "@/lib/db/adapters/types";

type FakeOptions = {
  /** Error message thrown by any statement touching `dbstat`. */
  dbstatError?: string;
};

/**
 * Minimal in-memory SqliteAdapter double. Only the surface getDatabaseStats()
 * actually touches is implemented; everything else throws so an accidental new
 * dependency shows up loudly instead of silently passing.
 */
function createFakeDb({ dbstatError }: FakeOptions = {}): SqliteAdapter {
  const tables = ["alpha", "beta"];

  const prepare = (sql: string): PreparedStatement => {
    const touchesDbstat = /\bdbstat\b/i.test(sql);

    return {
      run() {
        throw new Error(`unexpected run(): ${sql}`);
      },
      get(...params: unknown[]) {
        if (touchesDbstat) {
          if (dbstatError) throw new Error(dbstatError);
          // 4 KiB per table when dbstat is available.
          return { size: params[0] === "sqlite_master" ? 0 : 4096 };
        }
        if (/COUNT\(\*\)/i.test(sql)) return { count: 7 };
        throw new Error(`unexpected get(): ${sql}`);
      },
      all() {
        if (/type='table'/i.test(sql)) return tables.map((name) => ({ name }));
        if (/type='index'/i.test(sql)) return [{ name: "idx_alpha", tableName: "alpha" }];
        throw new Error(`unexpected all(): ${sql}`);
      },
    };
  };

  return {
    driver: "sql.js",
    open: true,
    name: ":memory:",
    prepare,
    exec() {},
    pragma(pragmaStr: string) {
      if (pragmaStr === "page_size") return 4096;
      if (pragmaStr === "page_count") return 100;
      if (pragmaStr === "cache_size") return -65536;
      throw new Error(`unexpected pragma: ${pragmaStr}`);
    },
    transaction<T>(fn: (...args: unknown[]) => T) {
      return fn;
    },
    immediate(fn: () => void) {
      fn();
    },
    async backup() {},
    checkpoint() {},
    close() {},
    raw: null,
  } satisfies SqliteAdapter;
}

test("getDatabaseStats reports per-table sizes when dbstat is available", () => {
  const stats = getDatabaseStats(createFakeDb());

  assert.equal(stats.totalSize, 4096 * 100);
  assert.deepEqual(
    stats.tables.map((t) => [t.name, t.rowCount, t.size]),
    [
      ["alpha", 7, 4096],
      ["beta", 7, 4096],
    ]
  );
});

test("getDatabaseStats degrades to size 0 when dbstat module is missing", () => {
  const stats = getDatabaseStats(createFakeDb({ dbstatError: "no such module: dbstat" }));

  // The call must succeed; only per-table byte sizes are lost.
  assert.deepEqual(
    stats.tables.map((t) => [t.name, t.rowCount, t.size]),
    [
      ["alpha", 7, 0],
      ["beta", 7, 0],
    ]
  );
  // Database-level numbers come from pragmas and stay accurate.
  assert.equal(stats.totalSize, 4096 * 100);
  assert.equal(stats.pageCount, 100);
  assert.equal(stats.cacheSize, -65536);
  assert.equal(stats.indexes.length, 1);
});

test("getDatabaseStats degrades when the driver reports dbstat as a missing table", () => {
  // better-sqlite3 surfaces this variant instead of "no such module".
  const stats = getDatabaseStats(createFakeDb({ dbstatError: "no such table: dbstat" }));

  assert.deepEqual(
    stats.tables.map((t) => t.size),
    [0, 0]
  );
});

test("getDatabaseStats still propagates unrelated dbstat failures", () => {
  // A genuine fault (disk I/O, corruption) must not be silently swallowed.
  assert.throws(
    () => getDatabaseStats(createFakeDb({ dbstatError: "database disk image is malformed" })),
    /database disk image is malformed/
  );
});
