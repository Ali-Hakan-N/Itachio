const test = require('node:test');
const assert = require('node:assert/strict');
const { DataStore } = require('../src/main/data');

function storeWith(auth) {
  return new DataStore({ client: { auth } });
}

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