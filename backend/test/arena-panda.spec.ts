import { describe, expect, it, vi } from 'vitest';
import { parseInstruction, routeHeldPlacement } from '../src/apps/desktop-robot/instruction-agent.js';
import { semanticFrame } from '../src/apps/desktop-robot/semantic-understanding.js';
import { buildPlan } from '../src/apps/desktop-robot/planner-agent.js';
import { validatePlan } from '../src/apps/desktop-robot/plan-validator-node.js';
import { summarizeCapabilities } from '../src/apps/desktop-robot/interaction-snapshot.js';

describe('Arena Panda task decisions', () => {
  it.each(['放下', '把它放到蓝色托盘', '在桌子上随便找个地方放下'])('plans an independent placement: %s', (text) => {
    vi.stubEnv('BUSAGENT_ROBOT', 'franka_panda');
    try {
      const plan = buildPlan(parseInstruction(text), 'place')!;
      expect(validatePlan(plan)).toEqual([]);
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0]?.skill).toBe('place_held');
      expect(plan.steps[0]?.params).not.toHaveProperty('target');
    } finally { vi.unstubAllEnvs(); }
  });
  it('lets perception choose a free table patch without language coordinates', () => {
    const plan = buildPlan(semanticFrame({intent:'place_held', destination:'table', placement_selection:'free_space'}, '在桌子上随便找个地方放下'), 'free')!;
    expect(plan.steps[0]?.params.destination).toEqual({type:'named_region',label:'table',selection:'free_space'});
    expect(validatePlan(plan)).toEqual([]);
  });
  it('uses measured holding to resume a named object without another grasp', () => {
    const parsed = semanticFrame({intent:'pick_place',category:'gear',destination:'blue tray'}, '把齿轮放到蓝色托盘');
    const held = {holding:{verified:true,label:'gear'}};
    expect(buildPlan(routeHeldPlacement(parsed,held),'resume')?.steps[0]?.skill).toBe('place_held');
    expect(routeHeldPlacement(parsed,{holding:{verified:false,label:'gear'}}).intent).toBe('pick_place');
    expect(routeHeldPlacement(parsed,{holding:{verified:true,label:'bolt'}}).intent).toBe('pick_place');
    const other = semanticFrame({intent:'pick_place',category:'block',color:'red',destination:'blue tray'}, '把红方块放到托盘');
    expect(routeHeldPlacement(other,{holding:{verified:true,label:'green block'}}).intent).toBe('pick_place');
  });
  it('keeps another object as the support target without a blue-pad whitelist', () => {
    const plan = buildPlan(
      semanticFrame(
        {
          intent: 'pick_place',
          category: 'block',
          color: 'red',
          destination: 'yellow cylinder',
          mode: 'auto',
        },
        '把红色方块放到黄色柱子上',
      ),
      'stack',
    )!;
    expect(validatePlan(plan)).toEqual([]);
    expect(plan.steps[0]?.params).toMatchObject({
      destination: { label: 'yellow cylinder' },
      mode: 'auto',
    });
  });
  it('removes the support-relation suffix from an offline placement label', () => {
    vi.stubEnv('BUSAGENT_ROBOT', 'franka_panda');
    try {
      expect(parseInstruction('把红色方块放到黄色圆柱的上面').destination?.label).toBe(
        '黄色圆柱',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('sends one complete semantic transaction with model routing hints', () => {
    const instruction = semanticFrame(
      {
        intent: 'pick_place',
        category: 'block',
        color: 'red',
        destination: 'blue pad',
        mode: 'enhanced',
        precise: true,
      },
      '精确把红色方块放到蓝色区域',
    );
    const plan = buildPlan(instruction, 'task1')!;
    expect(validatePlan(plan)).toEqual([]);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.skill).toBe('pick_place');
    expect(plan.steps[0]?.params).toMatchObject({
      mode: 'enhanced',
      precise: true,
      destination: { label: 'blue pad' },
    });
    expect(plan.steps[0]?.params).not.toHaveProperty('xyz_m');
  });
  it('keeps model routing and destination when the language service is unavailable', () => {
    vi.stubEnv('BUSAGENT_ROBOT', 'franka_panda');
    try {
      const parsed = parseInstruction('使用增强模型精确把黄色圆柱放到蓝色平台');
      const plan = buildPlan(parsed, 'offline')!;
      expect(parsed.needs_clarification).toBe(false);
      expect(plan.steps[0]?.params).toMatchObject({
        target: { category: 'cylinder', attributes: { color: 'yellow' } },
        destination: { label: '蓝色平台' },
        mode: 'enhanced',
        precise: true,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('does not execute a partial pick when the destination is missing', () => {
    const instruction = semanticFrame(
      { intent: 'pick_place', category: 'block' },
      '把方块放过去',
    );
    expect(instruction.needs_clarification).toBe(true);
    expect(buildPlan(instruction, 'task2')).toBeNull();
  });
  it('reports the live composite placement capability', () => {
    expect(summarizeCapabilities({ skills: ['grasp', 'pick_place'] })).not.toContain(
      '放置未实现',
    );
  });
});
