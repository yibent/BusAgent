import { Injectable } from '@nestjs/common';
import { sha256Hex } from '../common/sha.js';
import { stableStringify } from '../common/json.js';
import type { LoadedPackage } from '../package/package-loader.js';
import type { AppSnapshot, SerializableSnapshot } from './startup-snapshot.js';
import { toSerializableSnapshot } from './startup-snapshot.js';
import { SnapshotsRepository } from '../persistence/repositories/snapshots.repository.js';
import type { ResolvedApp } from './app-loader.js';

/** Persists the startup Package/App snapshots to MySQL (spec §4, §10). */
@Injectable()
export class SnapshotsWriter {
  constructor(private readonly snapshotsRepo: SnapshotsRepository) {}

  async writePackages(packages: LoadedPackage[]): Promise<void> {
    for (const pkg of packages) {
      const payload = {
        packageId: pkg.packageId,
        packageVersion: pkg.packageVersion,
        agents: pkg.agents,
      };
      await this.snapshotsRepo.save(
        'package',
        pkg.packageId,
        pkg.packageVersion,
        sha256Hex(stableStringify(payload)),
        payload,
      );
    }
  }

  async writeApp(snapshot: AppSnapshot, resolved: ResolvedApp): Promise<void> {
    const prompts = new Map<string, { relativePath: string; promptSha256: string }>();
    for (const [agentId, files] of resolved.resolvedFiles) {
      prompts.set(agentId, {
        relativePath: files.relativePath,
        promptSha256: files.promptSha256,
      });
    }
    const serializable: SerializableSnapshot = toSerializableSnapshot(
      snapshot,
      prompts,
    );
    await this.snapshotsRepo.save(
      'app',
      snapshot.appId,
      snapshot.appVersion,
      snapshot.snapshotSha256,
      serializable,
    );
  }
}
