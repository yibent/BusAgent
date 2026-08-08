import { Injectable } from '@nestjs/common';
import type { LoadedPackage } from '../package/package-loader.js';
import { RegistryService } from '../registry/registry.service.js';

/** Installs loaded packages into the global registry (spec §5). */
@Injectable()
export class PackageInstaller {
  constructor(private readonly registry: RegistryService) {}

  installAll(packages: LoadedPackage[]): void {
    for (const pkg of packages) {
      this.registry.installPackage(pkg);
    }
  }
}
