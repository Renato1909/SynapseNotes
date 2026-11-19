// Fixture de testes: D1 em memoria via node:sqlite, aplicando as migrations
// reais do projeto (mesma abordagem da LensClick).

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const TEST_ORIGIN = 'https://synapsenotes.test';

export class MockD1Statement {
  private readonly statement: ReturnType<DatabaseSync['prepare']>;
  private values: unknown[] = [];

  constructor(database: DatabaseSync, sql: string) {
    this.statement = database.prepare(sql);
  }

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  first<T = Record<string, unknown>>(column?: string): T | null {
    const row = (this.statement.get(...(this.values as never[])) as Record<string, unknown> | undefined) ?? null;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }

  run(): { success: boolean; meta: { changes: number; last_row_id: number } } {
    const result = this.statement.run(...(this.values as never[]));
    return {
      success: true,
      meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) }
    };
  }

  all<T = Record<string, unknown>>(): { success: boolean; results: T[] } {
    const results = this.statement.all(...(this.values as never[])) as T[];
    return { success: true, results };
  }
}

export class MockD1 {
  readonly database: DatabaseSync;
  readonly appliedMigrations: string[];

  constructor({ migrationsDirectory = resolve(import.meta.dirname, '../migrations') } = {}) {
    this.database = new DatabaseSync(':memory:');
    const migrations = readdirSync(migrationsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^\d+.*\.sql$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, 'en'));

    if (!migrations.length) throw new Error('Nenhuma migration SQL foi encontrada para os testes.');
    for (const migration of migrations) {
      this.database.exec(readFileSync(resolve(migrationsDirectory, migration), 'utf8'));
    }
    this.database.exec('PRAGMA foreign_keys = ON');
    this.appliedMigrations = migrations;
  }

  prepare(sql: string): MockD1Statement {
    return new MockD1Statement(this.database, sql);
  }

  batch(statements: MockD1Statement[]) {
    this.database.exec('BEGIN');
    try {
      const results = statements.map((statement) => statement.run());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}
