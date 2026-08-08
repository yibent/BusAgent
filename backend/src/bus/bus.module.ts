import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { RegistryModule } from '../registry/registry.module.js';
import { RuntimeModule } from '../app/runtime.module.js';
import { AdaptersModule } from '../adapters/adapters.module.js';
import { RedisConnection } from './queue/redis-connection.service.js';
import { QueueManager } from './queue/queue-manager.service.js';
import { Router } from './routing/router.service.js';
import { PermissionPolicy } from './routing/permission-policy.service.js';
import { TaskBudgetTracker } from './routing/task-budget-tracker.service.js';
import { DeliveryScheduler } from './delivery/delivery-scheduler.service.js';
import { DeliveryService } from './delivery/delivery.service.js';
import { EventBus } from './event-bus.service.js';
import { EventIngressService } from './event-ingress.service.js';
import { TaskService } from './tasks/task.service.js';
import { IdempotencyService } from './idempotency/idempotency.service.js';
import { PhysicalActionState } from './physical/physical-action-state.service.js';

@Module({
  imports: [
    ConfigModule,
    PersistenceModule,
    RegistryModule,
    RuntimeModule,
    forwardRef(() => AdaptersModule),
  ],
  providers: [
    RedisConnection,
    QueueManager,
    Router,
    PermissionPolicy,
    TaskBudgetTracker,
    TaskService,
    IdempotencyService,
    PhysicalActionState,
    DeliveryScheduler,
    DeliveryService,
    EventBus,
    EventIngressService,
  ],
  exports: [
    EventBus,
    EventIngressService,
    DeliveryService,
    RedisConnection,
    QueueManager,
  ],
})
export class BusModule {}
