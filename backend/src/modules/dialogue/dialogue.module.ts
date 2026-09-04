import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module.js';
import { ConversationModule } from '../conversation/conversation.module.js';
import { TtsModule } from '../tts/tts.module.js';
import { DialogueAgent } from './dialogue-agent.js';

/** Reusable text-dialogue module. An App imports it and wires routes in JSON. */
@Module({
  imports: [ConfigModule, ConversationModule, TtsModule],
  providers: [DialogueAgent],
  exports: [DialogueAgent],
})
export class DialogueModule {}
