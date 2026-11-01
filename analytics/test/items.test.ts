import assert from 'node:assert/strict';
import test from 'node:test';
import { ItemRanker, trainPairwiseItemModel, type ItemCandidate, type ItemContext } from '../src/items.js';

const context: ItemContext = { currentGold: 3000, gameTime: 1200, enemyArmorSum: 500, enemyMRSum: 150, championKitType: 'dps' };
const physical: ItemCandidate = { id: 1, name: 'Physical Edge', cost: 3000, attackDamage: 60, abilityPower: 0, armorPenetration: 20, magicPenetration: 0, armor: 0, magicResist: 0, health: 0, attackSpeed: 0.25, abilityHaste: 0, healing: 0, earlyPower: 0.8, latePower: 0.5 };
const magic: ItemCandidate = { id: 2, name: 'Arcane Focus', cost: 2800, attackDamage: 0, abilityPower: 80, armorPenetration: 0, magicPenetration: 15, armor: 0, magicResist: 0, health: 0, attackSpeed: 0, abilityHaste: 20, healing: 0, earlyPower: 0.7, latePower: 0.7 };

test('pairwise ranker learns observed preferences and scores legal items by context', () => {
  const comparisons = Array.from({ length: 60 }, () => ({ context, preferred: physical, rejected: magic }));
  const model = trainPairwiseItemModel(comparisons);
  const ranker = new ItemRanker(model, [magic, physical, { ...physical, id: 3, name: 'Too Expensive', cost: 4000 }]);
  const ranked = ranker.rank(3000, 1200, 500, 150, 'dps');
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0]!.item.id, physical.id);
});

test('item utility adapts to champion kit and enemy defenses', () => {
  const comparisons = [
    ...Array.from({ length: 40 }, () => ({ context: { ...context, championKitType: 'burst' as const, enemyMRSum: 500 }, preferred: magic, rejected: physical })),
    ...Array.from({ length: 40 }, () => ({ context: { ...context, championKitType: 'dps' as const, enemyArmorSum: 500 }, preferred: physical, rejected: magic })),
  ];
  const model = trainPairwiseItemModel(comparisons);
  const ranker = new ItemRanker(model, [magic, physical]);
  assert.equal(ranker.rank(3000, 1200, 50, 500, 'burst')[0]!.item.id, magic.id);
  assert.equal(ranker.rank(3000, 1200, 500, 50, 'dps')[0]!.item.id, physical.id);
});