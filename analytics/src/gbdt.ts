import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const { onnx } = createRequire(import.meta.url)('onnx-proto') as { onnx: typeof import('onnx-proto').onnx };

// Histogram gradient boosting for logloss, the method behind LightGBM and XGBoost's "hist",
// written in TypeScript so the package needs no native build or Python. Features are cut
// into quantile bins, every tree is grown depth-first on per-bin gradient sums, and training
// stops when the held-out logloss stops improving. Exports to a standard ONNX
// TreeEnsembleRegressor, so the runtime is the same onnxruntime session as before.

export interface GbdtOptions {
  trees?: number;
  learningRate?: number;
  maxDepth?: number;
  /** Least sum of hessians in a leaf; about rows × 0.25 near p = 0.5 */
  minChildHessian?: number;
  l2?: number;
  maxBins?: number;
  featureFraction?: number;
  rowFraction?: number;
  earlyStoppingRounds?: number;
  seed?: number;
  /** Column indexes the trees may not use */
  excluded?: ReadonlySet<number>;
}

export interface GbdtTree {
  feature: number[];
  threshold: number[];
  left: number[];
  right: number[];
  /** Leaf output, in log-odds with the learning rate applied; 0 on inner nodes */
  value: number[];
}

export interface GbdtModel {
  kind: 'gbdt';
  featureCount: number;
  bias: number;
  trees: GbdtTree[];
  validationLogLoss: number;
  /** Total split gain per column */
  gain: number[];
}

const LEAF = -1;
const sigmoid = (value: number): number => 1 / (1 + Math.exp(-value));
const logLoss = (label: number, logit: number): number => {
  const probability = Math.min(1 - 1e-7, Math.max(1e-7, sigmoid(logit)));
  return -(label * Math.log(probability) + (1 - label) * Math.log(1 - probability));
};

function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

/** Upper edges of the quantile bins of one column */
function binEdges(X: Float32Array, featureCount: number, feature: number, rows: Int32Array, maxBins: number): Float32Array {
  const stride = Math.max(1, Math.floor(rows.length / 20_000));
  const sample: number[] = [];
  for (let i = 0; i < rows.length; i += stride) sample.push(X[rows[i]! * featureCount + feature]!);
  sample.sort((a, b) => a - b);
  const edges: number[] = [];
  for (let bin = 1; bin < maxBins; bin++) {
    const edge = sample[Math.floor((bin / maxBins) * sample.length)]!;
    if (edges.at(-1) !== edge) edges.push(edge);
  }
  if (edges.at(-1) === sample.at(-1)) edges.pop();
  return Float32Array.from(edges);
}

function binOf(edges: Float32Array, value: number): number {
  let low = 0;
  let high = edges.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (value <= edges[middle]!) high = middle;
    else low = middle + 1;
  }
  return low;
}

interface Split { feature: number; bin: number; gain: number }

/**
 * X: rows × featureCount, flat. trainRows and validRows hold row indexes; keep the rows of one
 * match on one side, the labels of a match's rows are the same result.
 */
export function trainGbdt(X: Float32Array, y: ArrayLike<number>, featureCount: number, trainRows: Int32Array, validRows: Int32Array, options: GbdtOptions = {}): GbdtModel {
  const treeCount = options.trees ?? 300;
  const learningRate = options.learningRate ?? 0.05;
  const maxDepth = options.maxDepth ?? 4;
  const minChildHessian = options.minChildHessian ?? 200;
  const l2 = options.l2 ?? 20;
  const maxBins = Math.min(255, options.maxBins ?? 64);
  const featureFraction = options.featureFraction ?? 0.6;
  const rowFraction = options.rowFraction ?? 0.6;
  const patience = options.earlyStoppingRounds ?? 25;
  const random = seeded(options.seed ?? 7);
  const usable = Array.from({ length: featureCount }, (_, feature) => feature).filter((feature) => !options.excluded?.has(feature));

  const rowCount = y.length;
  const edges = Array.from({ length: featureCount }, (_, feature) => binEdges(X, featureCount, feature, trainRows, maxBins));
  const bins = new Uint8Array(rowCount * featureCount);
  for (const rows of [trainRows, validRows]) {
    for (const row of rows) for (let feature = 0; feature < featureCount; feature++) bins[row * featureCount + feature] = binOf(edges[feature]!, X[row * featureCount + feature]!);
  }

  let positives = 0;
  for (const row of trainRows) positives += y[row]!;
  const rate = Math.min(1 - 1e-6, Math.max(1e-6, positives / trainRows.length));
  const bias = Math.log(rate / (1 - rate));
  const scores = new Float64Array(rowCount).fill(bias);
  const gradient = new Float64Array(rowCount);
  const hessian = new Float64Array(rowCount);
  const histogram = new Float64Array(featureCount * (maxBins + 1) * 2);
  const gain = new Array<number>(featureCount).fill(0);
  const pool = new Int32Array(trainRows.length);

  const trees: GbdtTree[] = [];
  let best = { loss: Infinity, trees: 0 };

  for (let round = 0; round < treeCount && trees.length - best.trees < patience; round++) {
    for (const row of trainRows) {
      const probability = sigmoid(scores[row]!);
      gradient[row] = probability - y[row]!;
      hessian[row] = Math.max(probability * (1 - probability), 1e-6);
    }
    let sampled = 0;
    for (const row of trainRows) if (random() < rowFraction) pool[sampled++] = row;
    const features = usable.filter(() => random() < featureFraction);
    const tree: GbdtTree = { feature: [], threshold: [], left: [], right: [], value: [] };
    // Inner nodes keep their bin cut to send the validation and out-of-sample rows down the tree
    const cuts: number[] = [];

    const grow = (start: number, end: number, depth: number): number => {
      const node = tree.feature.length;
      tree.feature.push(LEAF);
      tree.threshold.push(0);
      tree.left.push(LEAF);
      tree.right.push(LEAF);
      tree.value.push(0);
      cuts.push(0);
      let sumG = 0;
      let sumH = 0;
      for (let i = start; i < end; i++) {
        sumG += gradient[pool[i]!]!;
        sumH += hessian[pool[i]!]!;
      }
      let split: Split | null = null;
      if (depth < maxDepth && sumH >= 2 * minChildHessian) {
        const parent = (sumG * sumG) / (sumH + l2);
        const width = (maxBins + 1) * 2;
        for (const feature of features) {
          const base = feature * width;
          const cells = (edges[feature]!.length + 1) * 2;
          histogram.fill(0, base, base + cells);
          for (let i = start; i < end; i++) {
            const row = pool[i]!;
            const at = base + bins[row * featureCount + feature]! * 2;
            histogram[at] = histogram[at]! + gradient[row]!;
            histogram[at + 1] = histogram[at + 1]! + hessian[row]!;
          }
          let leftG = 0;
          let leftH = 0;
          for (let bin = 0; bin < edges[feature]!.length; bin++) {
            leftG += histogram[base + bin * 2]!;
            leftH += histogram[base + bin * 2 + 1]!;
            const rightH = sumH - leftH;
            if (leftH < minChildHessian || rightH < minChildHessian) continue;
            const rightG = sumG - leftG;
            const candidate = (leftG * leftG) / (leftH + l2) + (rightG * rightG) / (rightH + l2) - parent;
            if (candidate > 0 && (!split || candidate > split.gain)) split = { feature, bin, gain: candidate };
          }
        }
      }
      if (!split) {
        tree.value[node] = learningRate * (-sumG / (sumH + l2));
        return node;
      }
      // Partition this node's rows in place
      let low = start;
      let high = end - 1;
      while (low <= high) {
        if (bins[pool[low]! * featureCount + split.feature]! <= split.bin) low++;
        else {
          const swap = pool[low]!;
          pool[low] = pool[high]!;
          pool[high--] = swap;
        }
      }
      tree.feature[node] = split.feature;
      tree.threshold[node] = edges[split.feature]![split.bin]!;
      cuts[node] = split.bin;
      gain[split.feature] = gain[split.feature]! + split.gain;
      tree.left[node] = grow(start, low, depth + 1);
      tree.right[node] = grow(low, end, depth + 1);
      return node;
    };
    grow(0, sampled, 0);

    const add = (rows: Int32Array) => {
      for (const row of rows) {
        let node = 0;
        while (tree.feature[node] !== LEAF) node = bins[row * featureCount + tree.feature[node]!]! <= cuts[node]! ? tree.left[node]! : tree.right[node]!;
        scores[row] = scores[row]! + tree.value[node]!;
      }
    };
    add(trainRows);
    add(validRows);
    trees.push(tree);

    let loss = 0;
    for (const row of validRows) loss += logLoss(y[row]!, scores[row]!);
    loss /= validRows.length || 1;
    if (loss < best.loss - 1e-7) best = { loss, trees: trees.length };
  }
  return { kind: 'gbdt', featureCount, bias, trees: trees.slice(0, Math.max(1, best.trees)), validationLogLoss: best.loss, gain };
}

/** Log-odds of one row, read from the flat matrix */
export function gbdtLogit(model: GbdtModel, X: ArrayLike<number>, row = 0): number {
  let total = model.bias;
  const offset = row * model.featureCount;
  for (const tree of model.trees) {
    let node = 0;
    while (tree.feature[node] !== LEAF) node = X[offset + tree.feature[node]!]! <= tree.threshold[node]! ? tree.left[node]! : tree.right[node]!;
    total += tree.value[node]!;
  }
  return total;
}

function tensorValueInfo(name: string, dimensions: Array<{ dimValue?: number; dimParam?: string }>) {
  return onnx.ValueInfoProto.create({
    name,
    type: onnx.TypeProto.create({
      tensorType: onnx.TypeProto.Tensor.create({
        elemType: onnx.TensorProto.DataType.FLOAT,
        shape: onnx.TensorShapeProto.create({ dim: dimensions }),
      }),
    }),
  });
}

/** features -> TreeEnsembleRegressor -> Sigmoid -> win_probability */
export async function exportGbdtOnnx(model: GbdtModel, outputPath: string): Promise<void> {
  const { INT, INTS, FLOATS, STRING, STRINGS } = onnx.AttributeProto.AttributeType;
  const ints = (name: string, values: number[]) => onnx.AttributeProto.create({ name, type: INTS, ints: values });
  const floats = (name: string, values: number[]) => onnx.AttributeProto.create({ name, type: FLOATS, floats: values });
  const treeIds: number[] = [], nodeIds: number[] = [], features: number[] = [], thresholds: number[] = [];
  const modes: Uint8Array[] = [], lefts: number[] = [], rights: number[] = [];
  const targetTrees: number[] = [], targetNodes: number[] = [], targetWeights: number[] = [];
  model.trees.forEach((tree, treeId) => {
    tree.feature.forEach((feature, node) => {
      const leaf = feature === LEAF;
      treeIds.push(treeId);
      nodeIds.push(node);
      features.push(leaf ? 0 : feature);
      thresholds.push(tree.threshold[node]!);
      modes.push(new TextEncoder().encode(leaf ? 'LEAF' : 'BRANCH_LEQ'));
      lefts.push(leaf ? 0 : tree.left[node]!);
      rights.push(leaf ? 0 : tree.right[node]!);
      if (leaf) {
        targetTrees.push(treeId);
        targetNodes.push(node);
        targetWeights.push(tree.value[node]!);
      }
    });
  });
  const proto = onnx.ModelProto.create({
    irVersion: 8,
    producerName: 'Itachio analytics',
    producerVersion: '2.0.0',
    graph: onnx.GraphProto.create({
      name: 'itachio_draft_gbdt',
      input: [tensorValueInfo('features', [{ dimParam: 'batch' }, { dimValue: model.featureCount }])],
      output: [tensorValueInfo('win_probability', [{ dimParam: 'batch' }, { dimValue: 1 }])],
      node: [
        onnx.NodeProto.create({
          name: 'trees',
          opType: 'TreeEnsembleRegressor',
          domain: 'ai.onnx.ml',
          input: ['features'],
          output: ['logits'],
          attribute: [
            ints('nodes_treeids', treeIds),
            ints('nodes_nodeids', nodeIds),
            ints('nodes_featureids', features),
            floats('nodes_values', thresholds),
            onnx.AttributeProto.create({ name: 'nodes_modes', type: STRINGS, strings: modes }),
            ints('nodes_truenodeids', lefts),
            ints('nodes_falsenodeids', rights),
            ints('target_treeids', targetTrees),
            ints('target_nodeids', targetNodes),
            ints('target_ids', targetTrees.map(() => 0)),
            floats('target_weights', targetWeights),
            onnx.AttributeProto.create({ name: 'n_targets', type: INT, i: 1 }),
            floats('base_values', [model.bias]),
            onnx.AttributeProto.create({ name: 'aggregate_function', type: STRING, s: new TextEncoder().encode('SUM') }),
            onnx.AttributeProto.create({ name: 'post_transform', type: STRING, s: new TextEncoder().encode('NONE') }),
          ],
        }),
        onnx.NodeProto.create({ name: 'probability', opType: 'Sigmoid', input: ['logits'], output: ['win_probability'] }),
      ],
    }),
    opsetImport: [
      onnx.OperatorSetIdProto.create({ domain: '', version: 13 }),
      onnx.OperatorSetIdProto.create({ domain: 'ai.onnx.ml', version: 3 }),
    ],
  });
  const invalid = onnx.ModelProto.verify(proto);
  if (invalid) throw new Error(`Invalid ONNX model: ${invalid}`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(onnx.ModelProto.encode(proto).finish()));
}
