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
  const f = fixture();
  const denied = f.adapter.notify(notice);
  f.emit({ kind: 'failed', identifier: notice.identifier, code: 'NOTIFICATION_PERMISSION_DENIED' });
  await assert.rejects(denied, /NATIVE_NOTIFICATION_UNAVAILABLE/);
  const pending = f.adapter.notify(notice);
  f.child.emit('exit', 1);
  await assert.rejects(pending, /NATIVE_ADAPTER_UNAVAILABLE/);
  await assert.rejects(f.adapter.notify(notice), /NATIVE_ADAPTER_UNAVAILABLE/);
  f.adapter.close();
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
