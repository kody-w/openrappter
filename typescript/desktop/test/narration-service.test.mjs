import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  NARRATION_MODEL_ID,
  NARRATION_MODEL_REVISION,
  NarrationService,
} from '../dist/narration.js';

function result(text) {
  return {
    text,
    chunks: [{ timestamp: [0, 0.5], text }],
  };
}

function serviceWith(pipelineFactory, overrides = {}) {
  let cached = overrides.cached ?? true;
  const statuses = [];
  const service = new NarrationService(
    (status) => statuses.push(status),
    {
      cacheReady: () => cached,
      markCacheReady: () => { cached = true; },
      pipelineFactory,
      maxQueued: overrides.maxQueued ?? 3,
      maxResidentSamples: overrides.maxResidentSamples,
      idleUnloadMs: 0,
    },
  );
  return { service, statuses, cached: () => cached };
}

test('Skills Recorder and voice share one pipeline and serialize concurrent STT', async () => {
  let builds = 0;
  let active = 0;
  let maximum = 0;
  const { service } = serviceWith(async () => {
    builds += 1;
    return async (_samples, options) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return result(String(options.request_id));
    };
  });
  service.acquire('skills-recorder');
  service.acquire('voice-conversation');
  const recorder = service.transcribe(new Float32Array([0.1]), 'en', {
    owner: 'skills-recorder',
    requestId: 'recorder-1',
  });
  const voice = service.transcribe(new Float32Array([0.2]), 'en', {
    owner: 'voice-conversation',
    requestId: 'voice-1',
  });
  const [recorderResult, voiceResult] = await Promise.all([recorder, voice]);
  assert.equal(recorderResult.text, 'recorder-1');
  assert.equal(voiceResult.text, 'voice-1');
  assert.equal(builds, 1);
  assert.equal(maximum, 1);
  assert.deepEqual(service.status().owners, {
    'skills-recorder': 1,
    'voice-conversation': 1,
  });
});

test('bounded queue rejects a cost storm', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const { service } = serviceWith(async () => async () => {
    await blocked;
    return result('done');
  }, { maxQueued: 1 });
  service.acquire('voice-conversation');
  const first = service.transcribe(new Float32Array([0.1]), 'en', {
    owner: 'voice-conversation',
    requestId: 'one',
  });

  const second = service.transcribe(new Float32Array([0.2]), 'en', {
    owner: 'voice-conversation',
    requestId: 'two',
  });
  await assert.rejects(
    service.transcribe(new Float32Array([0.3]), 'en', {
      owner: 'voice-conversation',
      requestId: 'three',
    }),
    (error) => error.code === 'queue_full',
  );
  release();
  await Promise.all([first, second]);
});

test('resident PCM bytes are bounded even below the queue-count limit', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const { service } = serviceWith(async () => async () => {
    await blocked;
    return result('done');
  }, { maxQueued: 5, maxResidentSamples: 3 });
  service.acquire('voice-conversation');
  const active = service.transcribe(new Float32Array([0.1, 0.2]), 'en', {
    owner: 'voice-conversation',
    requestId: 'resident-active',
  });
  await assert.rejects(
    service.transcribe(new Float32Array([0.3, 0.4]), 'en', {
      owner: 'voice-conversation',
      requestId: 'resident-overflow',
    }),
    (error) => error.code === 'queue_full',
  );
  release();
  await active;
});

test('pending cancellation removes work without invoking Whisper', async () => {
  let release;
  let calls = 0;
  const blocked = new Promise((resolve) => { release = resolve; });
  const { service } = serviceWith(async () => async () => {
    calls += 1;
    await blocked;
    return result('done');
  });
  service.acquire('voice-conversation');
  const first = service.transcribe(new Float32Array([0.1]), 'en', {
    owner: 'voice-conversation',
    requestId: 'active',
  });
  const pending = service.transcribe(new Float32Array([0.2]), 'en', {
    owner: 'voice-conversation',
    requestId: 'cancel-me',
  });
  assert.equal(service.cancel('cancel-me'), true);
  await assert.rejects(pending, (error) => error.code === 'cancelled');
  release();
  await first;
  assert.equal(calls, 1);
});

test('active cancellation discards its eventual transcript and advances the queue', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let call = 0;
  const { service } = serviceWith(async () => async () => {
    call += 1;
    if (call === 1) await blocked;
    return result(`result-${call}`);
  });
  service.acquire('voice-conversation');
  const active = service.transcribe(new Float32Array([0.1]), 'en', {
    owner: 'voice-conversation',
    requestId: 'active',
  });
  const next = service.transcribe(new Float32Array([0.2]), 'en', {
    owner: 'voice-conversation',
    requestId: 'next',
  });
  assert.equal(service.cancel('active'), true);
  release();
  await assert.rejects(active, (error) => error.code === 'cancelled');
  assert.equal((await next).text, 'result-2');
});

test('model missing remains offline until one shared download completes', async () => {
  let builds = 0;
  const { service, cached } = serviceWith(async ({ allowDownload, progress }) => {
    builds += 1;
    assert.equal(allowDownload, true);
    progress({ progress: 50, loaded: 5, total: 10 });
    return async () => result('downloaded');
  }, { cached: false });
  await assert.rejects(
    service.transcribe(new Float32Array([0.1]), 'en', {
      owner: 'voice-conversation',
      requestId: 'before-download',
    }),
    /not been downloaded/i,
  );
  const downloaded = await service.download('skills-recorder');
  assert.equal(downloaded.model, 'ready');
  assert.equal(downloaded.progress, 100);
  assert.equal(cached(), true);
  assert.equal(builds, 1);
});

test('voice waits on an in-flight recorder download instead of starting another model', async () => {
  let finishBuild;
  const building = new Promise((resolve) => { finishBuild = resolve; });
  let builds = 0;
  const { service } = serviceWith(async () => {
    builds += 1;
    await building;
    return async () => result('shared after download');
  }, { cached: false });
  service.acquire('skills-recorder');
  service.acquire('voice-conversation');
  const download = service.download('skills-recorder');
  await Promise.resolve();
  const voice = service.transcribe(new Float32Array([0.1]), 'en', {
    owner: 'voice-conversation',
    requestId: 'wait-for-download',
  });
  finishBuild();
  await download;
  assert.equal((await voice).text, 'shared after download');
  assert.equal(builds, 1);
});

test('download reports offline health without changing the package pin', async () => {
  const { service, statuses } = serviceWith(async ({ model, revision }) => {
    assert.equal(model, 'Xenova/whisper-small');
    assert.equal(revision, '2d67713f236afa48a18992566e7647f6ca848e13');
    throw Object.assign(new Error('network offline'), { code: 'offline' });
  }, { cached: false });
  await assert.rejects(service.download('voice-conversation'), /offline/i);
  assert.equal(service.status().health, 'offline');
  assert.ok(statuses.some((status) => status.health === 'downloading'));
  assert.equal(NARRATION_MODEL_ID, 'Xenova/whisper-small');
  assert.equal(
    NARRATION_MODEL_REVISION,
    '2d67713f236afa48a18992566e7647f6ca848e13',
  );
});

test('pipeline crash reloads the same cached revision once and recovers', async () => {
  let builds = 0;
  const { service } = serviceWith(async ({ model, revision }) => {
    builds += 1;
    assert.equal(model, NARRATION_MODEL_ID);
    assert.equal(revision, NARRATION_MODEL_REVISION);
    if (builds === 1) {
      return async () => {
        throw Object.assign(new Error('worker crashed'), { code: 'server_crash' });
      };
    }
    return async () => result('recovered transcript');
  });
  service.acquire('voice-conversation');
  const transcript = await service.transcribe(new Float32Array([0.1]), 'en', {
    owner: 'voice-conversation',
    requestId: 'recover',
  });
  assert.equal(transcript.text, 'recovered transcript');
  assert.equal(builds, 2);
  assert.equal(service.status().restartCount, 1);
});

test('reference release and shutdown cancel work and unload one authority', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const { service } = serviceWith(async () => async () => {
    await blocked;
    return result('late');
  });

  service.acquire('skills-recorder');
  service.acquire('voice-conversation');
  service.release('skills-recorder');
  assert.equal(service.status().references, 1);
  const active = service.transcribe(new Float32Array([0.1]), 'en', {
    owner: 'voice-conversation',
    requestId: 'shutdown-active',
  });
  const pending = service.transcribe(new Float32Array([0.2]), 'en', {
    owner: 'voice-conversation',
    requestId: 'shutdown-pending',
  });
  service.shutdown();
  release();
  await assert.rejects(active, (error) => error.code === 'cancelled');
  await assert.rejects(pending, (error) => error.code === 'cancelled');
  assert.equal(service.status().health, 'stopped');
  await assert.rejects(
    service.transcribe(new Float32Array([0.3]), 'en', {
      owner: 'voice-conversation',
      requestId: 'after-shutdown',
    }),
    /stopped/i,
  );
});

test('last owner release unloads the shared pipeline without deleting the cache', async () => {
  const { service, cached } = serviceWith(async () => async () => result('warm'));
  service.acquire('skills-recorder');
  await service.transcribe(new Float32Array([0.1]), 'en', {
    owner: 'skills-recorder',
    requestId: 'warm-up',
  });
  assert.equal(service.status().loaded, true);
  service.release('skills-recorder');
  await Promise.resolve();
  assert.equal(service.status().references, 0);
  assert.equal(service.status().loaded, false);
  assert.equal(service.status().health, 'ready');
  assert.equal(cached(), true);
});

test('exact meaningful Whisper segments become the only transcript handoff', async () => {
  const { service } = serviceWith(async () => async () => ({
    text: 'ignored aggregate',
    chunks: [
      { timestamp: [0, 0.2], text: 'thank you' },
      { timestamp: [0.2, 0.8], text: ' turn on the kitchen lights ' },
      { timestamp: [0.8, 1.0], text: 'bye' },
    ],
  }));
  service.acquire('voice-conversation');
  const transcript = await service.transcribe(
    new Float32Array(16_000),
    'en',
    { owner: 'voice-conversation', requestId: 'exact' },
  );
  assert.equal(transcript.text, 'turn on the kitchen lights');
  assert.deepEqual(transcript.segments, [{
    atMs: 200,
    endMs: 800,
    text: 'turn on the kitchen lights',
  }]);
});
