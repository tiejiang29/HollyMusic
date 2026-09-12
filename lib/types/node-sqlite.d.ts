/**
 * node:sqlite 最小类型声明（Node ≥22.5 内置 SQLite；@types/node@20 尚未收录）
 */
declare module 'node:sqlite' {
  export interface DatabaseSyncOptions {
    open?: boolean
    readOnly?: boolean
    enableForeignKeyConstraints?: boolean
    enableDoubleQuotedStringLiterals?: boolean
    allowExtension?: boolean
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Row = Record<string, any>
  export interface StatementSync {
    get(...params: unknown[]): Row | undefined
    all(...params: unknown[]): Row[]
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  }
  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions)
    prepare(sql: string): StatementSync
    exec(sql: string): void
    close(): void
  }
}
