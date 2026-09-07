import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module.js';
import { ConversationModule } from '../conversation/conversation.module.js';
import { TtsModule } from '../tts/tts.module.js';
import { DialogueAgent } from './dialogue-agent.js';
import { IntelligentDialogue } from './intelligent-dialogue.js';
import { PersistenceModule } from '../../persistence/persistence.module.js';
import { ModelConfigModule } from '../../apps/desktop-robot/intelligence/model-config.module.js';

/** Reusable text-dialogue module. An App imports it and wires routes in JSON. */
@Module({
  imports: [
    ConfigModule,
    ConversationModule,
    TtsModule,
    PersistenceModule,
    ModelConfigModule,
  ],
  providers: [DialogueAgent, IntelligentDialogue],
  exports: [DialogueAgent],
})
export class DialogueModule {}
