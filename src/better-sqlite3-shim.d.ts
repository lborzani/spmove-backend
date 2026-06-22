declare module 'better-sqlite3' {
  interface Database {
    pragma(source: string): unknown;
    exec(source: string): this;
    close(): this;
  }
  interface DatabaseConstructor {
    new (filename: string, options?: Record<string, unknown>): Database;
    (filename: string, options?: Record<string, unknown>): Database;
  }
  const Database: DatabaseConstructor;
  export = Database;
}
