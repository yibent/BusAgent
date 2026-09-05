import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const source = await readFile(new URL('../src/components/GraspPanel.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext,
} }).outputText.replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')));
const { GraspPanel } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const status = {
  capabilities: { grasp: { dual_camera_default: true } },
  grasp: { state: 'failed', retry_available: true, message: '未抓稳，等待对话。',
    grasp: { attempt: 1, max_attempts: 2 }, result: { metrics: {} } },
};
const render = (connected = true) => renderToStaticMarkup(createElement(GraspPanel, { status, connected }));
const html = render();
assert.match(html, /双相机默认启用/);
assert.match(html, /等待对话指令/);
assert.match(html, /再试一次/);
assert.doesNotMatch(html, /<(select|button|form|input)\b/);
assert.doesNotMatch(render(false), /等待对话指令/);
status.grasp.retry_available = false;
status.grasp.result.metrics.recovery_stop_reason = 'payload_uncertain_do_not_open';
assert.match(render(), /持物状态不确定/);
assert.doesNotMatch(render(), /等待对话指令/);
console.log('GraspPanel read-only rendering checks passed');
