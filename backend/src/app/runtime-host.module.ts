import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { RegistryModule } from '../registry/registry.module.js';
import { RuntimeModule } from './runtime.module.js';
import { BusModule } from '../bus/bus.module.js';
import { AdaptersModule } from '../adapters/adapters.module.js';
import { AppValidator } from './app-validator.js';
import { ConfigSchemaValidator } from './config-schema-validator.js';
import { StartupSnapshotBuilder } from './startup-snapshot-builder.js';
import { SnapshotsWriter } from './snapshots-writer.js';
import { HostRuntimeService } from './host-runtime.service.js';

@Module({
  imports: [
    ConfigModule,
    PersistenceModule,
    RegistryModule,
    RuntimeModule,
    BusModule,
    AdaptersModule,
  ],
  providers: [
    ConfigSchemaValidator,
    AppValidator,
    StartupSnapshotBuilder,
    SnapshotsWriter,
    HostRuntimeService,
  ],
  exports: [HostRuntimeService],
})
export class RuntimeHostModule {}
