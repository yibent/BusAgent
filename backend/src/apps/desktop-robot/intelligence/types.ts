import { z } from 'zod';

export const intelligenceEnabled = () =>
  process.env.BUSAGENT_ROBOT === 'franka_panda' &&
  process.env.BUSAGENT_INTELLIGENCE !== '0';
export type Role = 'planner' | 'supervisor';
export type StepState =
  | 'pending'
  | 'dispatching'
  | 'running'
  | 'completed'
  | 'failed'
  | 'unknown'
  | 'cancelled'
  | 'superseded';
export type GoalState =
  | 'queued'
  | 'planning'
  | 'running'
  | 'review'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'cancelled';
export const actionSchema = z.object({
  title: z.string().min(1),
  skill: z.string().min(1),
  params: z.record(z.unknown()).default({}),
  review_after: z.boolean().default(false),
});
export type Action = z.infer<typeof actionSchema>;
export const decisionSchema = z.object({
  mode: z.enum(['simple', 'complex']).default('complex'),
  summary: z.string().default(''),
  completion: z.string().default(''),
  actions: z.array(actionSchema).default([]),
  outcome: z
    .enum(['continue', 'complete', 'blocked', 'clarify', 'chat'])
    .default('continue'),
  message: z.string().default(''),
});
export type Decision = z.infer<typeof decisionSchema>;
export interface QueueStep extends Action {
  runtime_id?: string;
  id: string;
  state: StepState;
  attempt: number;
  task_id: string;
  command_id: string;
  result?: Record<string, unknown>;
  started_at?: string;
  finished_at?: string;
  delivery_attempts?: number;
  last_dispatched_at?: string;
  cancel_requested?: boolean;
}
export interface Goal {
  planning_ahead?: string;
  proposal?: Action[];
  interaction?: boolean;
  id: string;
  conversation_id: string;
  input_event_id: string;
  source: string;
  state: GoalState;
  mode: 'simple' | 'complex';
  summary: string;
  completion: string;
  steps: QueueStep[];
  message: string;
  review_reason: string;
  recovery_count: number;
  created_at: string;
  updated_at: string;
  model_calls: number;
  revision: number;
}
export interface SceneState {
  runtime_id?: string;
  observed_at?: string;
  observation?: Record<string, unknown>;
  holding?: Record<string, unknown>;
  available?: boolean;
  observations?: Record<string, unknown>[];
}
export interface QueueState {
  revision: number;
  paused: boolean;
  goals: Goal[];
  scene: SceneState;
  receipts: string[];
}
export const emptyQueue = (): QueueState => ({
  revision: 0,
  paused: false,
  goals: [],
  scene: {},
  receipts: [],
});
export const ended = (goal: Goal) => ['completed', 'cancelled'].includes(goal.state);
export const inFlight = (step: QueueStep) =>
  ['dispatching', 'running', 'unknown'].includes(step.state);

/** Model/bus context contains semantic evidence, never raw tensors or image bytes. */
export function semanticEvidence(value: unknown, depth = 0): unknown {
  if (depth > 9) return undefined;
  if (typeof value === 'string')
    return value.startsWith('data:') ? undefined : value.slice(0, 12000);
  if (value === null || typeof value === 'number' || typeof value === 'boolean')
    return value;
  if (Array.isArray(value))
    return value.slice(0, 160).map((v) => semanticEvidence(v, depth + 1));
  if (typeof value !== 'object') return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key]) =>
          !/^(rgb|depth|image|image_url|base64|mask|masks|points|point_cloud|cloud|joint_positions|pose_world|object_pose|tcp_pose_world|tcp_to_object_at_grasp|camera_world|intrinsics|bounds_world|final_position_world_m|witness_votes|instance_id|events|api_key|apiKey|authorization)$/i.test(
            key,
          ),
      )
      .map(([k, v]) => [k, semanticEvidence(v, depth + 1)])
      .filter(([, v]) => v !== undefined),
  );
}
