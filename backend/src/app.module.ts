import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { PersistenceModule } from './persistence/persistence.module.js';
import { RegistryModule } from './registry/registry.module.js';
import { RuntimeModule } from './app/runtime.module.js';
import { AdaptersModule } from './adapters/adapters.module.js';
import { BusModule } from './bus/bus.module.js';
import { RuntimeHostModule } from './app/runtime-host.module.js';

@Module({
  imports: [
    ConfigModule,
    PersistenceModule,
    RegistryModule,
    RuntimeModule,
    AdaptersModule,
    BusModule,
    RuntimeHostModule,
  ],
})
export class AppModule {}
