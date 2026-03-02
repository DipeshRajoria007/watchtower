declare module 'better-sqlite3' {
  namespace Database {
    interface Statement {
      run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
      get(...params: unknown[]): unknown;
    }

    interface Database {
      pragma(statement: string): unknown;
      exec(sql: string): unknown;
      prepare(sql: string): Statement;
      close(): void;
    }
  }

  interface DatabaseConstructor {
    new (path: string): Database.Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
}
