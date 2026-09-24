import assert from 'node:assert/strict';
import { normalizeCardSelectionSettings, cooldownExclusions, selectCardCandidates } from '../../src/card-selection.mjs';
assert.deepEqual(normalizeCardSelectionSettings(), { variety: 'low', cooldownTurns: 0 });
assert.deepEqual(normalizeCardSelectionSettings({variety:'bad',cooldownTurns:99}), {variety:'low',cooldownTurns:10});
assert.deepEqual(normalizeCardSelectionSettings({variety:'off',cooldownTurns:-1}), {variety:'off',cooldownTurns:0});
const history=[{deckId:'d',cards:[{cardId:'a'}]}, {deckId:'other',cards:[{cardId:'b'}]}, {deckId:'d',cards:[{cardId:'c'}]}];
assert.deepEqual(cooldownExclusions(history,'d',1),[{cardId:'c',turnsRemaining:1,reason:'cooldown'}]);
assert.deepEqual(cooldownExclusions(history,'d',2),[{cardId:'c',turnsRemaining:2,reason:'cooldown'}]);
assert.deepEqual(cooldownExclusions(history,'d',3),[{cardId:'c',turnsRemaining:3,reason:'cooldown'},{cardId:'a',turnsRemaining:1,reason:'cooldown'}]);
assert.deepEqual(cooldownExclusions(history,'d',0),[]);
const candidates=['a','b','c','d','e'].map(key=>({key,coverageKey:key,reason:key}));
const chosen=(options)=>selectCardCandidates(candidates,{slots:3,...options});
assert.deepEqual(chosen({variety:'off',seed:'s'}).selected.map(x=>x.key),['a','b','c']);
let changed=0;
for(let seed=0;seed<200;seed++){
 const options={variety:'low',seed:String(seed)};
 const result=chosen(options);
 assert.deepEqual(result,chosen(options));
 assert.deepEqual(result.selected.slice(0,2).map(x=>x.key),['a','b']);
 if(result.selected[2].key!=='c') changed++;
}
assert(changed>20&&changed<90,`Low changes a minority of fixed turns: ${changed}`);
assert.equal(selectCardCandidates(candidates.slice(0,2),{slots:3,variety:'high',seed:'s'}).selected.length,2);
assert.equal(selectCardCandidates(candidates,{slots:0,variety:'high',seed:'s'}).selected.length,0);
const duplicate=selectCardCandidates([{key:'a',coverageKey:'same'},{key:'b',coverageKey:'same'},{key:'c',coverageKey:'different'}],{slots:3,variety:'off'});
assert.deepEqual(duplicate.selected.map(x=>x.key),['a','c']);
assert.equal(duplicate.omitted[0].reason,'overlapping-coverage');
console.log('[pass] card selection policy');
