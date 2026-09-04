import { Module } from '@nestjs/common';
import { ConversationHub } from './conversation-hub.js';
import { ConversationInterruptions } from './conversation-interruptions.js';
import { SpeechGate } from './speech-gate.js';

@Module({
  providers: [ConversationHub, ConversationInterruptions, SpeechGate],
  exports: [ConversationHub, ConversationInterruptions, SpeechGate],
})
export class ConversationModule {}
