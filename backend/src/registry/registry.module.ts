import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { PackageInstaller } from '../package/package-installer.js';
import { RegistryService } from './registry.service.js';
import { RegistrationService } from './registration.service.js';
import { LeaseManager } from '../leases/lease-manager.service.js';

@Module({
  imports: [ConfigModule, PersistenceModule],
  providers: [RegistryService, PackageInstaller, LeaseManager, RegistrationService],
  exports: [RegistryService, PackageInstaller, LeaseManager, RegistrationService],
})
export class RegistryModule {}
