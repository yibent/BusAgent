import { Module } from '@nestjs/common';
import { ConfigModule } from '../../../config/config.module.js';
import { ModelConfig } from './model-config.js';

@Module({ imports: [ConfigModule], providers: [ModelConfig], exports: [ModelConfig] })
export class ModelConfigModule {}
