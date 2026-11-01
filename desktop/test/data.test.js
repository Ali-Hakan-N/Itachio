const test = require('node:test');
const assert = require('node:assert/strict');
const { DataStore, metaSrcHealth } = require('../src/main/data');

function storeWith(auth) {
  return new DataStore({ client: { auth } });
}

test('MetaSRC health becomes stale after three days without a valid non-empty run', () => {
  const now = Date.parse('2026-11-01T12:00:00.000Z');
  const runs = [
    { status: 'error', started_at: '2026-11-01T04:00:00.000Z', stats: { metaRows: 0 } },
    { status: 'ok', finished_at: '2026-10-28T11:59:59.000Z', stats: { meta: { written: 420 } } },
  ];

  assert.deepEqual(metaSrcHealth(runs, now), { stale: true, lastSuccessAt: '2026-10-28T11:59:59.000Z' });
  assert.deepEqual(metaSrcHealth([{ status: 'ok', finished_at: '2026-11-01T04:00:00.000Z', stats: { meta: { written: 420 } } }], now), {
    stale: false,
    lastSuccessAt: '2026-11-01T04:00:00.000Z',
  });
});

test('a previous-patch model starts with zero active-patch matches and the new patch clock', async () => {
  const model = { patch: '16.20', patchMatches: 12000 };
  const client = {
    from: (table) => {
      const query = {
        select: () => query,
        order: () => query,
        limit: () => query,
        eq: () => query,
        maybeSingle: async () => table === 'model_snapshots'
          ? { data: { id: 8, data: model }, error: null }
          : { data: { value: '16.21', updated_at: '2026-11-01T00:00:00.000Z' }, error: null },
      };
      return query;
    },
  };
  const loaded = await new DataStore({ client }).loadModel();

  assert.equal(loaded.patch, '16.20');
  assert.equal(loaded.activePatch, '16.21');
  assert.equal(loaded.patchMatches, 0);
  assert.equal(loaded.patchStartedAt, '2026-11-01T00:00:00.000Z');
});

test('password reset email uses the app recovery callback', async () => {
  let call;
  const store = storeWith({
    resetPasswordForEmail: async (...args) => {
      call = args;
      return { data: {}, error: null };
    },
  });

  await store.requestPasswordReset('player@example.com', 'itachio://auth/callback');

  assert.deepEqual(call, ['player@example.com', { redirectTo: 'itachio://auth/callback' }]);
});

test('password recovery exchanges a PKCE callback code', async () => {
  let exchanged;
  const store = storeWith({
    exchangeCodeForSession: async (code) => {
      exchanged = code;
      return { data: {}, error: null };
    },
  });

  await store.completePasswordRecovery('itachio://auth/callback?code=one-time-code');

  assert.equal(exchanged, 'one-time-code');
});

test('password recovery accepts a recovery token callback', async () => {
  let session;
  const store = storeWith({
    setSession: async (value) => {
      session = value;
      return { data: {}, error: null };
    },
  });

  await store.completePasswordRecovery('itachio://auth/callback#access_token=access&refresh_token=refresh&type=recovery');

  assert.deepEqual(session, { access_token: 'access', refresh_token: 'refresh' });
});

test('password recovery rejects unrelated callback URLs', async () => {
  const store = storeWith({});

  await assert.rejects(store.completePasswordRecovery('https://example.com/callback'), /Invalid password recovery link/);
});

test('password update delegates to Supabase auth', async () => {
  let update;
  const store = storeWith({
    updateUser: async (value) => {
      update = value;
      return { data: {}, error: null };
    },
  });

  await store.updatePassword('new-password');

  assert.deepEqual(update, { password: 'new-password' });
});