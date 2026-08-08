import { Module } from '@nestjs/common';
import { RuntimeState } from './runtime-state.service.js';

/** Leaf module holding the single active AppSnapshot. */
@Module({
  providers: [RuntimeState],
  exports: [RuntimeState],
})
export class RuntimeModule {}
