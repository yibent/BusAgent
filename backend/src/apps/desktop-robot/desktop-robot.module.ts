import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module.js';
import { RuntimeModule } from '../../app/runtime.module.js';
import { BusModule } from '../../bus/bus.module.js';
import { SttModule } from '../../modules/stt/stt.module.js';
import { DialogueModule } from '../../modules/dialogue/dialogue.module.js';
import { TtsModule } from '../../modules/tts/tts.module.js';
import { ExecutorAgent } from './executor-agent.js';

/**
 * Desktop-robot App: a same-process composition of independent modules.
 * Speech-to-text, text dialogue and speech synthesis live in their own
 * modules; this App only wires them together with robot-specific agents
 * (executor) and JSON routes.
 */
@Module({
  imports: [
    ConfigModule,
    RuntimeModule,
    forwardRef(() => BusModule),
    SttModule,
    DialogueModule,
    TtsModule,
  ],
  providers: [ExecutorAgent],
  exports: [SttModule, DialogueModule, TtsModule],
})
export class DesktopRobotModule {}
