export type ChampionKitType = 'burst' | 'dps' | 'tank';

export interface ItemCandidate {
  id: number;
  name: string;
  cost: number;
  attackDamage: number;
  abilityPower: number;
  armorPenetration: number;
  magicPenetration: number;
  armor: number;
  magicResist: number;
  health: number;
  attackSpeed: number;
  abilityHaste: number;
  healing: number;
  earlyPower: number;
  latePower: number;
}

export interface ItemContext {
  currentGold: number;
  gameTime: number;
  enemyArmorSum: number;
  enemyMRSum: number;
  championKitType: ChampionKitType;
}

export const ITEM_FEATURE_NAMES = [
  'cost_fraction', 'gold_remaining', 'attack_damage', 'ability_power', 'armor_penetration',
  'magic_penetration', 'armor', 'magic_resist', 'health', 'attack_speed', 'ability_haste',
  'healing', 'physical_effective_power', 'magic_effective_power', 'burst_kit_fit', 'dps_kit_fit',
  'tank_kit_fit', 'early_power', 'late_power', 'time_scaled_power',
] as const;

export const ITEM_FEATURE_COUNT = 20;

if (ITEM_FEATURE_NAMES.length !== ITEM_FEATURE_COUNT) throw new Error('Item feature schema size mismatch');

const clamp = (value: number, min = 0, max = 1): number => Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
const sigmoid = (value: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));

export function itemFeatures(item: ItemCandidate, context: ItemContext): number[] {
  const cost = Math.max(1, item.cost);
  const armorReduction = Math.max(0, context.enemyArmorSum) / (100 + Math.max(0, context.enemyArmorSum));
  const mrReduction = Math.max(0, context.enemyMRSum) / (100 + Math.max(0, context.enemyMRSum));
  const early = context.gameTime < 900 ? 1 : context.gameTime < 1800 ? 0.5 : 0;
  const late = context.gameTime >= 1800 ? 1 : context.gameTime >= 900 ? 0.5 : 0;
  const kit = context.championKitType;
  const physicalPower = (item.attackDamage + item.armorPenetration) / 100;
  const magicPower = (item.abilityPower + item.magicPenetration) / 100;
  const durability = (item.armor + item.magicResist + item.health / 10) / 300;
  const power = item.earlyPower * early + item.latePower * late;
  return [
    cost / Math.max(1, context.currentGold + cost),
    Math.max(0, context.currentGold - cost) / Math.max(1, context.currentGold),
    item.attackDamage / 100,
    item.abilityPower / 100,
    item.armorPenetration / 50,
    item.magicPenetration / 50,
    item.armor / 100,
    item.magicResist / 100,
    item.health / 1000,
    item.attackSpeed,
    item.abilityHaste / 100,
    item.healing,
    physicalPower * (1 - armorReduction),
    magicPower * (1 - mrReduction),
    kit === 'burst' ? magicPower + physicalPower : 0,
    kit === 'dps' ? item.attackDamage / 100 + item.attackSpeed : 0,
    kit === 'tank' ? durability : 0,
    item.earlyPower,
    item.latePower,
    power,
  ].map((value) => clamp(value, -2, 2));
}

export interface ItemPreference {
  context: ItemContext;
  preferred: ItemCandidate;
  rejected: ItemCandidate;
}

export interface PairwiseItemModel {
  version: 1;
  featureNames: readonly string[];
  weights: number[];
  bias: number;
  comparisons: number;
  trainedAt: string;
}

export function trainPairwiseItemModel(
  comparisons: readonly ItemPreference[],
  options: { epochs?: number; learningRate?: number; l2?: number } = {},
): PairwiseItemModel {
  if (!comparisons.length) throw new Error('At least one observed item preference is required to train the ranker');
  const weights = new Array<number>(ITEM_FEATURE_COUNT).fill(0);
  let bias = 0;
  const epochs = options.epochs ?? 80;
  const rate = options.learningRate ?? 0.05;
  const l2 = options.l2 ?? 0.01;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradient = new Array<number>(ITEM_FEATURE_COUNT).fill(0);
    let biasGradient = 0;
    for (const comparison of comparisons) {
      const preferred = itemFeatures(comparison.preferred, comparison.context);
      const rejected = itemFeatures(comparison.rejected, comparison.context);
      const difference = preferred.map((value, index) => value - rejected[index]!);
      const margin = bias + difference.reduce((sum, value, index) => sum + value * weights[index]!, 0);
      const error = sigmoid(margin) - 1;
      biasGradient += error;
      for (let index = 0; index < ITEM_FEATURE_COUNT; index++) gradient[index] = gradient[index]! + error * difference[index]!;
    }
    const step = rate / comparisons.length;
    bias -= step * biasGradient;
    for (let index = 0; index < ITEM_FEATURE_COUNT; index++) weights[index] = weights[index]! - step * (gradient[index]! + l2 * weights[index]!);
  }
  return { version: 1, featureNames: ITEM_FEATURE_NAMES, weights, bias, comparisons: comparisons.length, trainedAt: new Date().toISOString() };
}

export class ItemRanker {
  constructor(private readonly model: PairwiseItemModel, private readonly catalog: readonly ItemCandidate[]) {
    if (model.weights.length !== ITEM_FEATURE_COUNT) throw new Error(`Item rank model needs ${ITEM_FEATURE_COUNT} weights`);
  }

  score(item: ItemCandidate, context: ItemContext): number {
    const features = itemFeatures(item, context);
    return this.model.bias + features.reduce((sum, value, index) => sum + value * this.model.weights[index]!, 0);
  }

  rank(currentGold: number, gameTime: number, enemyArmorSum: number, enemyMRSum: number, championKitType: ChampionKitType) {
    const context: ItemContext = { currentGold, gameTime, enemyArmorSum, enemyMRSum, championKitType };
    return this.catalog.filter((item) => item.cost <= currentGold)
      .map((item) => ({ item, utility: this.score(item, context) }))
      .sort((a, b) => b.utility - a.utility || a.item.cost - b.item.cost);
  }
}