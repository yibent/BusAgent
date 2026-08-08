import { createPool, type Pool } from 'mysql2/promise';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import { parseMysqlUrl } from './mysql-url.js';
import * as schema from './schema.js';

/** Owning MySQL connection. Drizzle is the data access layer (spec §1). */
export class DatabaseConnection {
  readonly pool: Pool;
  readonly db: MySql2Database<typeof schema>;

  constructor(connectionString: string) {
    const opts = parseMysqlUrl(connectionString);
    this.pool = createPool({
      host: opts.host,
      port: opts.port,
      user: opts.user,
      password: opts.password,
      database: opts.database,
      connectionLimit: 10,
      dateStrings: true,
      supportBigNumbers: true,
    });
    this.db = drizzle(this.pool, { schema, mode: 'default' });
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
