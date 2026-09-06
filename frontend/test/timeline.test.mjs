import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, linkColor } from '../src/lib/timeline.ts';
const event = (id, eventType, createdAt, extra = {}) => ({ id, eventType, createdAt, sourceAgentId: 'robot.executor', payload: {}, ...extra });
const node = (id, state, time, spanId, agent, payload = {}) => event(id, `node.${state}`, time, { sourceAgentId: agent, payload: { span_id: spanId, started_at_ms: 1000, ...payload } });
test('results from old hosts remain instants rather than invented model durations', () => {
  const [clip] = buildTimeline([event('a', 'perception.reported', 5000)]);
  assert.equal(clip.start, 5000); assert.equal(clip.end, 5000); assert.equal(clip.precise, false);
});
test('running spans grow until an actual terminal event and remain independent during overlap', () => {
  const clips = buildTimeline([node('a', 'started', 1000, 'A', 'robot.vision'), node('b', 'started', 1500, 'B', 'robot.vision', { started_at_ms: 1500 }), node('c', 'completed', 1800, 'A', 'robot.vision')]);
  assert.equal(clips[0].end, 1800); assert.equal(clips[1].end, undefined); assert.notEqual(clips[0].lane, clips[1].lane);
});
test('connects through explicit source spans, not the order of arrival', () => {
  const clips = buildTimeline([node('a', 'started', 1000, 'A', 'robot.instruction'), event('result', 'instruction.parsed', 1100, { sourceSpanId: 'A' }), node('b', 'started', 1120, 'B', 'robot.planner', { trigger_event_id: 'result', started_at_ms: 1120 })]);
  assert.equal(clips[1].parentId, 'A'); assert.equal(linkColor(clips[1].parentId), linkColor(clips[0].id));
});
test('preserves genuine time gaps between tasks and de-duplicates wire events', () => {
  const a = event('a', 'intent.created', 1000);
  const clips = buildTimeline([event('b', 'intent.created', 61000), a, a]);
  assert.equal(clips.length, 2); assert.equal(clips[1].start - clips[0].start, 60000);
});
test('pairs explicit execution start and terminal states within each task', () => {
  const clips = buildTimeline([event('a', 'execution.started', 1000, { taskId: 'a' }), event('b', 'execution.started', 2000, { taskId: 'b' }), event('c', 'execution.failed', 3000, { taskId: 'b' }), event('d', 'execution.completed', 5000, { taskId: 'a' })]);
  assert.equal(clips.length, 2); assert.equal(clips[0].end, 5000); assert.equal(clips[1].end, 3000); assert.equal(clips[1].state, 'failed');
});
test('loop colors are driven by event metadata', () => {
  const clips = buildTimeline([event('a', 'perception.reported', 1000, { payload: { loop: 'fast' } }), event('b', 'perception.reported', 2000, { payload: { loop: 'slow' } })]);
  assert.deepEqual(clips.map(c => c.loop), ['fast', 'slow']);
});
test('connection loss closes an unfinished recording as unknown, never success', () => {
  const clips = buildTimeline([event('a', 'execution.started', 1000), event('lost', 'connection.lost', 8000)]);
  assert.equal(clips[0].end, 8000); assert.equal(clips[0].state, 'unknown');
});
test('loop annotations update running cards without ending the span', () => {
  const [clip] = buildTimeline([node('a', 'started', 1000, 'A', 'robot.instruction'), node('b', 'updated', 1500, 'A', 'robot.instruction', { loop: 'slow' })]);
  assert.equal(clip.loop, 'slow'); assert.equal(clip.end, undefined);
});

test('sequence layout gives instant events readable cards without changing timestamps', async () => {
  const { layoutTimeline } = await import('../src/lib/timeline.ts');
  const clips = buildTimeline(Array.from({ length: 124 }, (_, i) => event(`e${i}`, 'perception.reported', 1000 + i * 2)));
  const display = layoutTimeline(clips, 2000);
  assert.equal(display.items.length, 124);
  for (const [i, item] of display.items.entries()) {
    assert.ok(item.width >= 140);
    assert.equal(item.clip.start, 1000 + i * 2);
    assert.equal(item.clip.end, item.clip.start);
    assert.equal(item.clip.lane, 0);
    if (i) assert.ok(item.x >= display.items[i - 1].x + display.items[i - 1].width);
  }
});
test('running cards grow gently and freeze on completion', async () => {
  const { layoutTimeline } = await import('../src/lib/timeline.ts');
  const clips = buildTimeline([event('running', 'execution.started', 1000)]);
  const start = layoutTimeline(clips, 1000).items[0].width;
  const tenSeconds = layoutTimeline(clips, 11000).items[0].width;
  const minute = layoutTimeline(clips, 61000).items[0].width;
  assert.ok(start >= 140 && tenSeconds > start && minute > tenSeconds);
  assert.ok(tenSeconds - start < 25);
  assert.ok(minute - start < 45);
  const done = buildTimeline([event('running', 'execution.started', 1000), event('done', 'execution.completed', 11000)]);
  assert.equal(layoutTimeline(done, 11000).items[0].width, layoutTimeline(done, 900000).items[0].width);
});
test('the non-linear axis retains overlap and aligns a shared start across tracks', async () => {
  const { layoutTimeline } = await import('../src/lib/timeline.ts');
  const clips = buildTimeline([
    node('1', 'started', 1000, 'A', 'robot.instruction'),
    node('2', 'started', 1000, 'B', 'robot.vision'),
    node('3', 'completed', 8000, 'A', 'robot.instruction'),
    node('4', 'completed', 12000, 'B', 'robot.vision'),
  ]);
  const [a,b] = layoutTimeline(clips, 20000).items;
  assert.equal(a.x, b.x);
  assert.ok(b.width >= a.width);
});
