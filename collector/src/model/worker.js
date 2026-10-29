// Trains the model in a worker thread, so collecting matches never pauses and a
// training can be stopped at once when a game starts.

const { parentPort, workerData } = require('node:worker_threads');
const { train } = require('./train');

const { matches, share, tags } = workerData;
const shareMap = new Map(share);
const tagMap = new Map(tags);
const model = train(matches, { share: shareMap, tagOf: (id) => tagMap.get(id) || 'None' }, {
  log: (line) => parentPort.postMessage({ log: line }),
});
parentPort.postMessage({ done: { keys: model.keys, w: model.w, bias: model.bias, lambdas: model.lambdas, metrics: model.metrics } }, [
  model.w.buffer,
]);
