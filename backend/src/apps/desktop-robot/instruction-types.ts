export type RobotIntentName =
  | 'pick_place'
  | 'pick'
  | 'find'
  | 'track'
  | 'status_query'
  | 'cancel'
  | 'motion'
  | 'capabilities'
  | 'unsupported'
  | 'chat';

export interface TargetSpec {
  category: string | null;
  attributes: Record<string, string>;
  spatial_ref: string | null;
  ordinal: number | null;
  quantity: number;
}

export interface BinCellDestination {
  type: 'bin_cell';
  bin_id: string;
  cell_index: number;
}
export type DestinationSpec =
  | BinCellDestination
  | { type: 'named_region'; label: string };

/** Structured language-understanding output described in report section 6.1. */
export interface ParsedInstruction {
  intent: RobotIntentName;
  target: TargetSpec;
  destination: DestinationSpec | null;
  constraints: {
    order: string | null;
    avoid: string[];
  };
  needs_clarification: boolean;
  clarification_question: string | null;
  source_text: string;
  observation_scope?: 'scene' | 'target';
  motion?: { skill: string; params: Record<string, unknown> };
  object_goal?: { offset_m: [number, number, number] };
  retry_last_grasp?: boolean;
  prepare_last_grasp?: boolean;
  grasp_preparation_id?: string;
  observation?: { message: string; [key: string]: unknown };
  manipulation?: {
    mode: 'auto' | 'basic' | 'enhanced';
    unfamiliar?: boolean;
    cluttered?: boolean;
    precise?: boolean;
  };
}

export interface SkillStep {
  id: number;
  skill: string;
  params: Record<string, unknown>;
  why?: string;
  verify?: string;
  on_fail?: string;
}

export interface RobotPlan {
  instruction_id: string;
  task_version: number;
  intent: ParsedInstruction;
  steps: SkillStep[];
}
