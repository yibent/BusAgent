import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { RowDataPacket } from 'mysql2';
import { DatabaseConnection } from '../../persistence/db/client.js';
import { compactContext } from './context-format.js';
import { InferenceWindow } from '../../apps/desktop-robot/intelligence/context-window.js';

/** Owns context construction for conversation views and each model tool loop.
 * No LLM is called for housekeeping; archived facts remain retrievable. */
@Injectable()
export class ContextCompression {
  constructor(private readonly db: DatabaseConnection) {}

  createWindow(...args: ConstructorParameters<typeof InferenceWindow>) {
    return new InferenceWindow(...args);
  }

  async conversation(
    conversation: string,
    entries: Record<string, unknown>[],
    working: unknown,
    budget: number,
  ) {
    const version = createHash('sha256')
      .update(JSON.stringify({ entries, working, budget }))
      .digest('hex');
    const [rows] = await this.db.pool.query<RowDataPacket[]>(
      'SELECT version, payload FROM busagent_context_views WHERE conversation_id = ? AND budget = ?',
      [conversation, budget],
    );
    if (rows[0]?.version === version) {
      const cached =
        typeof rows[0].payload === 'string'
          ? (JSON.parse(rows[0].payload) as ReturnType<typeof compactContext>)
          : (rows[0].payload as ReturnType<typeof compactContext>);
      return {
        ...cached,
        context_version: version,
        context_source: 'compression_cache',
      };
    }
    const view = compactContext(entries, working, budget);
    await this.db.pool.query(
      'INSERT INTO busagent_context_views (conversation_id, budget, version, payload) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE version = VALUES(version), payload = VALUES(payload), updated_at = CURRENT_TIMESTAMP(3)',
      [conversation, budget, version, JSON.stringify(view)],
    );
    return {
      ...view,
      context_version: version,
      context_source: 'structured_compression',
    };
  }
}
