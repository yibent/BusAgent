import { PersistenceModule } from '../../persistence/persistence.module.js';
import { QueueStore } from './intelligence/queue-store.js';
import { ModelConfigModule } from './intelligence/model-config.module.js';
import { TaskEngine } from './intelligence/task-engine.js';
import { PlanningAgent, SupervisionAgent } from './intelligence/inference-agents.js';
import {
  MemoryAgent,
  ContextCompressionAgent,
} from '../../modules/conversation/memory-agents.js';
import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module.js';
import { RuntimeModule } from '../../app/runtime.module.js';
import { BusModule } from '../../bus/bus.module.js';
import { SttModule } from '../../modules/stt/stt.module.js';
import { DialogueModule } from '../../modules/dialogue/dialogue.module.js';
import { TtsModule } from '../../modules/tts/tts.module.js';
import { RobotAdapterNode } from './executor-agent.js';
import { InstructionUnderstandingNode } from './instruction-agent.js';
import { TaskPlannerNode } from './planner-agent.js';
import { ExecutionCoordinatorNode } from './execution-coordinator-agent.js';
import { PlanValidatorNode } from './plan-validator-node.js';
import { InterruptMonitorNode } from './interrupt-monitor-node.js';
import { GroundingClarificationNode } from './grounding-clarification-node.js';
import { LoopRouterNode } from './loop-router-node.js';
import { VisionNode } from './vision-node.js';
import { RobotControlProxy } from './robot-control-proxy.js';

/**
 * Desktop-robot App: a same-process composition of independent modules.
 * Speech-to-text, text dialogue and speech synthesis live in their own
 * modules; this App only wires them together with robot-specific agents
 * (executor) and JSON routes.
 */
@Module({
  imports: [
    ConfigModule,
    ModelConfigModule,
    PersistenceModule,
    RuntimeModule,
    forwardRef(() => BusModule),
    SttModule,
    DialogueModule,
    TtsModule,
  ],
  providers: [
    QueueStore,
    TaskEngine,
    PlanningAgent,
    SupervisionAgent,
    MemoryAgent,
    ContextCompressionAgent,
    InterruptMonitorNode,
    InstructionUnderstandingNode,
    GroundingClarificationNode,
    TaskPlannerNode,
    PlanValidatorNode,
    LoopRouterNode,
    ExecutionCoordinatorNode,
    RobotAdapterNode,
    RobotControlProxy,
    VisionNode,
  ],
  exports: [
    TaskEngine,
    ModelConfigModule,
    SttModule,
    DialogueModule,
    TtsModule,
    RobotControlProxy,
  ],
})
export class DesktopRobotModule {}
