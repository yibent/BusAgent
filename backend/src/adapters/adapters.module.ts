import { ConversationModule } from '../modules/conversation/conversation.module.js';
import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { BusModule } from '../bus/bus.module.js';
import { AgentAdapterFactory } from './agent-adapter-factory.js';
import { InProcessAgentAdapter } from './in-process/in-process-agent-adapter.js';

@Module({
  imports: [ConversationModule, ConfigModule, forwardRef(() => BusModule)],
  providers: [InProcessAgentAdapter, AgentAdapterFactory],
  exports: [InProcessAgentAdapter, AgentAdapterFactory],
})
export class AdaptersModule {}
