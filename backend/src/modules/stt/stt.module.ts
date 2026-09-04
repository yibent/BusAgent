import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module.js';
import { RuntimeModule } from '../../app/runtime.module.js';
import { RuntimeHostModule } from '../../app/runtime-host.module.js';
import { BusModule } from '../../bus/bus.module.js';
import { ConversationModule } from '../conversation/conversation.module.js';
import { AudioGateway } from './audio-gateway.js';
import { SttAgent, STT_STREAM_FACTORY } from './stt-agent.js';
import { defaultSttStreamFactory } from './qwen-stt-stream.js';

/** Reusable speech-to-text module. An App imports it; it does not own routing. */
@Module({
  imports: [
    ConfigModule,
    RuntimeModule,
    RuntimeHostModule,
    ConversationModule,
    forwardRef(() => BusModule),
  ],
  providers: [
    { provide: STT_STREAM_FACTORY, useValue: defaultSttStreamFactory },
    SttAgent,
    AudioGateway,
  ],
  exports: [AudioGateway, SttAgent],
})
export class SttModule {}
