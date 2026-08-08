import { Module } from '@nestjs/common';
import { Clock, SystemClock } from '../common/clock.js';
import { HostConfig } from './host-config.js';

@Module({
  providers: [
    { provide: HostConfig, useFactory: () => HostConfig.fromEnv() },
    { provide: Clock, useClass: SystemClock },
  ],
  exports: [HostConfig, Clock],
})
export class ConfigModule {}
