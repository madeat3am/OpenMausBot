import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { createMacAdapter } from './adapter.mjs';

function fixture(options = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = () => child.emit('exit', 0);
  const writes = [];
  child.stdin.on('data', bytes => writes.push(JSON.parse(bytes.toString())));
  let invocation;
  const adapter = createMacAdapter({
    helperPath: '/fixture/PoppyReceiver.app/Contents/MacOS/PoppyReceiver',
    onActivate: () => {}, openTopic: () => {}, ...options,
    spawnImpl(...args) { invocation = args; return child; },
  });
  return { child, adapter, writes, invocation,
    emit(value) { child.stdout.write(JSON.stringify(value) + '\n'); } };
}

const notice = { identifier: 'poppy-' + 'a'.repeat(32), itemAlias: 'opaque_1', revision: 2 };

test('native adapter sends only opaque identity and awaits OS acceptance', async () => {
  const f = fixture();
  try {
    const submitted = f.adapter.notify({ ...notice, title: 'private fixture text', body: 'private fixture text' });
    assert.deepEqual(f.writes, [notice]);
    assert.deepEqual(f.invocation[1], []);
    f.emit({ kind: 'submitted', identifier: notice.identifier });
    await submitted;
  } finally { f.adapter.close(); }
});

test('permission denial leaves delivery retryable and helper exit rejects pending work', async () => {
  let failures = 0;
  const f = fixture({ onFatal() { failures++; } });
  const denied = f.adapter.notify(notice);
  f.emit({ kind: 'failed', identifier: notice.identifier, code: 'NOTIFICATION_PERMISSION_DENIED' });
  await assert.rejects(denied, /NATIVE_NOTIFICATION_UNAVAILABLE/);
  const pending = f.adapter.notify(notice);
  f.child.emit('exit', 1);
  await assert.rejects(pending, /NATIVE_ADAPTER_UNAVAILABLE/);
  await assert.rejects(f.adapter.notify(notice), /NATIVE_ADAPTER_UNAVAILABLE/);
  f.child.emit('error', new Error('late private failure'));
  assert.equal(failures, 1);
  f.adapter.close();
});

test('a hung native acknowledgement rejects in-flight work and escalates the existing supervisor once', async () => {
  let failures = 0;
  const f = fixture({ notificationTimeoutMs: 5, onFatal() { failures++; } });
  const first = f.adapter.notify(notice);
  const second = f.adapter.notify({ ...notice, identifier: 'poppy-' + 'b'.repeat(32) });
  await assert.rejects(first, /NATIVE_NOTIFICATION_TIMEOUT/);
  await assert.rejects(second, /NATIVE_ADAPTER_UNAVAILABLE/);
  assert.equal(failures, 1);
  await assert.rejects(f.adapter.notify(notice), /NATIVE_ADAPTER_UNAVAILABLE/);
});

test('intentional close and late helper callbacks do not fail or activate a replacement receiver', async () => {
  let failures = 0;
  const activations = [];
  const f = fixture({
    onFatal() { failures++; },
    onActivate: (...args) => activations.push(args),
  });
  f.emit({ kind: 'activate', itemAlias: 'queued_before_close', revision: 2 });
  f.adapter.close();
  f.emit({ kind: 'activate', itemAlias: 'opaque_1', revision: 2 });
  f.child.emit('error', new Error('late private failure'));
  await setImmediate();
  assert.equal(failures, 0);
  assert.deepEqual(activations, []);
});

test('retained taps resolve opaque identity again and malformed taps stay inert', async () => {
  const calls = [];
  const f = fixture({ onActivate: (...args) => calls.push(args) });
  try {
    f.emit({ kind: 'activate', itemAlias: '../private', revision: 2 });
    f.emit({ kind: 'activate', itemAlias: undefined, revision: 2 });
    f.emit({ kind: 'activate', itemAlias: 'opaque_1', revision: 2 });
    await setImmediate();
    assert.deepEqual(calls, [['opaque_1', 2]]);
  } finally { f.adapter.close(); }
});

test('synchronous activation failures become generic unavailable results', async () => {
  let unavailable = 0;
  const f = fixture({ onActivate() { throw new Error('private fixture'); }, showUnavailable() { unavailable++; } });
  try {
    f.emit({ kind: 'activate', itemAlias: 'opaque_1', revision: 2 });
    await setImmediate();
    assert.equal(unavailable, 1);
  } finally { f.adapter.close(); }
});
