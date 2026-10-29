// The UI's only door to the main process. Only the listed calls are exposed.
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  init: call('app:init'),
  getState: call('state:get'),
  loadData: call('data:load'),
  signIn: call('auth:signIn'),
  signUp: call('auth:signUp'),
  signOut: call('auth:signOut'),
  saveProfile: call('profile:save'),
  createTeam: call('team:create'),
  joinTeam: call('team:join'),
  leaveTeam: call('team:leave'),
  kickMember: call('team:kick'),
  resetChampionStats: call('stats:reset'),
  upsertPool: call('pool:upsert'),
  removePool: call('pool:remove'),
  listHistory: call('history:list'),
  hoverChampion: call('draft:hover'),
  getUpdate: call('update:get'),
  installUpdate: call('update:install'),
  onUpdate: (cb) => ipcRenderer.on('update', (_e, state) => cb(state)),
  onState: (cb) => ipcRenderer.on('state', (_e, partial) => cb(partial)),
  onSaved: (cb) => ipcRenderer.on('saved', (_e, info) => cb(info)),
});
