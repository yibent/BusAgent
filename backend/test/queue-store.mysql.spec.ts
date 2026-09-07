import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { QueueStore } from '../src/apps/desktop-robot/intelligence/queue-store.js';
import type { DatabaseConnection } from '../src/persistence/db/client.js';

// Opt-in integration regression against an isolated, disposable database.
// No application tables or credentials are read or changed.
describe.skipIf(!process.env.BUSAGENT_TEST_MYSQL_SOCKET)(
  'concurrent MySQL queue writes',
  () => {
    const database = `mastra_queue_test_${process.pid}_${Date.now()}`;
    let admin: Pool;
    let pool: Pool;
    beforeAll(async () => {
      const options = {
        socketPath: process.env.BUSAGENT_TEST_MYSQL_SOCKET!,
        user: process.env.BUSAGENT_TEST_MYSQL_USER ?? 'root',
        ...(process.env.BUSAGENT_TEST_MYSQL_PASSWORD
          ? { password: process.env.BUSAGENT_TEST_MYSQL_PASSWORD }
          : {}),
      };
      admin = mysql.createPool(options);
      await admin.query(`CREATE DATABASE ${database}`);
      pool = mysql.createPool({ ...options, database, connectionLimit: 8 });
      await pool.query(
        'CREATE TABLE busagent_goal_queue (id VARCHAR(32) PRIMARY KEY, payload LONGTEXT NOT NULL) ENGINE=InnoDB',
      );
      await pool.query(
        'CREATE TABLE busagent_goal_outbox (sequence_id BIGINT AUTO_INCREMENT UNIQUE, id VARCHAR(128) PRIMARY KEY, payload LONGTEXT NOT NULL, sent BOOLEAN DEFAULT 0) ENGINE=InnoDB',
      );
    });
    afterAll(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS ${database}`);
        await admin.end();
      }
    });
    it('commits each concurrent mutation and its outbox entry exactly once', async () => {
      const store = new QueueStore({ pool } as DatabaseConnection);
      for (let batch = 0; batch < 10; batch++)
        await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            store.change((_, emit) =>
              emit({
                key: `event-${batch}-${i}`,
                event: { event_type: 'test.updated', payload: { batch, i } },
              }),
            ),
          ),
        );
      expect((await store.read()).revision).toBe(80);
      const [[row]] = await pool.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS count FROM busagent_goal_outbox',
      );
      expect(row!.count).toBe(80);
    });
  },
);
