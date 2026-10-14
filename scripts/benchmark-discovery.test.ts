import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eligiblePairs, parseGenericSelection, reusedRanking, shuffleCards, reviewPacket, verifiedRecording, trialDefinitions, budgets } from './benchmark-discovery.js';
import { RankingEvidenceSchema } from '@tastecase/contracts';

test('the pilot pins one calibration and two new combinations with hard ceilings', () => {
  assert.deepEqual(trialDefinitions.map(t => t.phase), ['calibration', 'new_pair', 'new_pair']);
  assert.deepEqual(budgets, { qloo: 4, selection: 6, target: 6 });
});

test('generic selection can choose only a listed pair or null', () => {
  const pairs = eligiblePairs([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  assert.deepEqual(pairs.map(p => p.entryIds), [['a', 'b'], ['a', 'c'], ['b', 'c']]);
  assert.equal(parseGenericSelection({ selectedPairId: pairs[2]!.id }, pairs.map(p => p.id)), 'pair-3');
  assert.equal(parseGenericSelection({ selectedPairId: null }, pairs.map(p => p.id)), null);
  assert.throws(() => parseGenericSelection({ selectedPairId: 'outside' }, pairs.map(p => p.id)));
  assert.throws(() => parseGenericSelection({ selectedPairId: 'pair-1', reason: 'invented evidence' }, pairs.map(p => p.id)));
});

test('the same verified provider result can be reused as a new profile without changing coverage', () => {
  const rank = RankingEvidenceSchema.parse({ kind: 'rank', providerStatus: 'partial', profileId: 'a', scope: 'full',
    requestedEntryIds: ['a', 'b'], orderedEntryIds: ['a'], missingEntryIds: ['b'], unmappedEntryIds: [],
    mappingConfirmationIds: [
      '16e6581e-195c-4321-a507-90bc89f2f3e5', '276c5bf5-8115-4fd0-8056-3542c114720c',
    ], anchorConfirmationIds: ['3b1dd6c3-dbb9-4e53-934c-4b5bc916b42f'],
  });
  const reused = reusedRanking(rank, 'b');
  assert.equal(reused.profileId, 'b');
  assert.deepEqual(reused.missingEntryIds, rank.missingEntryIds);
  assert.deepEqual(reused.orderedEntryIds, rank.orderedEntryIds);
});

test('recorded provider evidence must match precisely the pinned query and remains unavailable if wrong', () => {
  const request = { profileId: 'a' as const, scope: 'full' as const,
    options: [{ entryId: 'a', entityId: '16e6581e-195c-4321-a507-90bc89f2f3e5', confirmationId: '276c5bf5-8115-4fd0-8056-3542c114720c' }],
    anchors: [{ entityId: '3b1dd6c3-dbb9-4e53-934c-4b5bc916b42f', confirmationId: '4bba6ab9-366f-4e9b-af54-2756c148004b' }], unmappedEntryIds: [] };
  const record = { input: { options: [request.options[0]!.entityId], option_type: 'place', signals: [request.anchors[0]!.entityId] },
    envelope: { schema_version: '1.0-preview.1', operation: 'rank', status: 'ok', results: [{ entity_id: request.options[0]!.entityId, name: 'Fixture A' }], result_count: 1,
      execution: { transport: 'mcp', transport_name: 'fixture', correlation_id: 'fictional', duration_ms: 1 } } };
  assert.deepEqual(verifiedRecording(record, request).orderedEntryIds, ['a']);
  assert.throws(() => verifiedRecording(record, { ...request, anchors: [{ ...request.anchors[0]!, entityId: request.options[0]!.entityId }] }));
});

test('source-blind shuffle is stable for one seed and does not mutate input', () => {
  const cards = [{ id: 'one' }, { id: 'two' }, { id: 'three' }];
  const first = shuffleCards(cards, 'private run');
  assert.deepEqual(first, shuffleCards(cards, 'private run'));
  assert.deepEqual(cards.map(c => c.id), ['one', 'two', 'three']);
  assert.deepEqual(new Set(first.map(c => c.id)), new Set(cards.map(c => c.id)));
});

test('review cards preserve the correct trial and hide arm identity, while source keys are separate', () => {
  const comparisons = trialDefinitions.flatMap((_, trial) => (['guided', 'generic'] as const).map(method => ({
    trial, method, pair: ['a', 'b'] as [string, string],
  })));
  const packet = reviewPacket(comparisons, 'private-run', [{ id: 'a', name: 'Fixture A' }, { id: 'b', name: 'Fixture B' }],
    [{ name: 'Music A' }, { name: 'Music B' }, { name: 'Film C' }],
    trialDefinitions.map((_, trial) => ({ rankings: [{ providerStatus: 'ok', orderedEntryIds: [`trial-${trial}`], missingEntryIds: [] }], supportedReversals: [] })),
    [{ profile: 'Music A' }, { profile: 'Music B' }, { profile: 'Film C' }]);
  assert.equal(packet.cards.length, 6);
  assert.ok(!JSON.stringify(packet.cards).includes('guided'));
  assert.ok(!JSON.stringify(packet.cards).includes('generic'));
  assert.ok(!JSON.stringify(packet.cards).includes('private-run'));
  for (const source of packet.sourceByCard) {
    const card = packet.cards.find(c => c.card === source.card)!;
    assert.equal(card.evidence.rankings[0]!.orderedEntryIds[0], `trial-${source.trial - 1}`);
    assert.deepEqual(card.profiles, trialDefinitions[source.trial - 1]!.anchors.map(a => ['Music A', 'Music B', 'Film C'][a]));
    assert.equal(card.targetOutputs.length, 2);
  }
});
