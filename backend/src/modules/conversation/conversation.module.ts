import { Module } from '@nestjs/common';
import { ConversationHub } from './conversation-hub.js';
import { SpeechGate } from './speech-gate.js';

@Module({
  providers: [ConversationHub, SpeechGate],
  exports: [ConversationHub, SpeechGate],
})
export class ConversationModule {}
