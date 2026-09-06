import { describe, expect, it, vi } from 'vitest';
import { VisionNode } from '../src/apps/desktop-robot/vision-node.js';
import type { InProcessEventContext } from '../src/adapters/in-process/agent-classes.js';
import { readFileSync } from 'node:fs';

describe('nominal vision node', () => {
  it('publishes observation metadata with task lineage and drops image fields', async () => {
    const publish = vi.fn();
    await new VisionNode().handle({
      event: {
        eventId: 'observation-event',
        correlationId: 'conversation',
        taskId: 'task',
        taskVersion: 2,
        payload: {
          command_id: 'move',
          observation: {
            request_id: 'ref',
            label: 'part',
            ok: true,
            loop: 'slow',
            fallback_reasons: ['low_confidence'],
            semantic_status: 'detected',
            views: [{ camera: 'scene', stages: [{ model: 'lk' }] }],
            result_ref: 'ref',
            image: 'image-bytes',
            mask: [1, 0],
          },
        },
      },
      publish,
    } as unknown as InProcessEventContext);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'perception.reported',
        correlation_id: 'conversation',
        causation_id: 'observation-event',
        task_id: 'task',
        task_version: 2,
      }),
    );
    const emitted = publish.mock.calls[0][0];
    expect(emitted.payload).not.toHaveProperty('image');
    expect(emitted.payload).not.toHaveProperty('mask');
    expect(emitted.payload.result_ref).toBe('ref');
    expect(emitted.payload).toMatchObject({
      loop: 'slow',
      fallback_reasons: ['low_confidence'],
      semantic_status: 'detected',
    });
  });
  it('never routes observations into either language-model agent', () => {
    const app = JSON.parse(
      readFileSync('backend-config/apps/desktop-robot.app.json', 'utf8'),
    );
    const routes = app.routes.filter((r: { event: string }) =>
      r.event.startsWith('perception.'),
    );
    expect(routes).toEqual([
      expect.objectContaining({ event: 'perception.observed', to: ['robot.vision'] }),
    ]);
  });
});
