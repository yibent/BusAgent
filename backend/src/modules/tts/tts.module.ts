import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module.js';
import { RuntimeModule } from '../../app/runtime.module.js';
import { ConversationModule } from '../conversation/conversation.module.js';
import { TtsAgent, TTS_STREAM_FACTORY } from './tts-agent.js';
import { defaultTtsStreamFactory } from './qwen-tts-stream.js';

/** Reusable text-to-speech module. An App imports it; audio stays off the bus. */
@Module({
  imports: [ConfigModule, RuntimeModule, ConversationModule],
  providers: [
    { provide: TTS_STREAM_FACTORY, useValue: defaultTtsStreamFactory },
    TtsAgent,
  ],
  exports: [TtsAgent],
})
export class TtsModule {}
