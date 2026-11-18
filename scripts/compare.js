import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createHostedEvaluate } from '../src/hosted-evaluate.js';
import { evaluateReceivingBaseline } from '../src/policy.js';

const readJSON = path => JSON.parse(readFileSync(path, 'utf8'));
const live = process.argv.includes('--live');
const receiptsDir = 'benchmark/receipts';
mkdirSync(receiptsDir, {recursive:true});
const cases = readJSON('benchmark/cases.json');
const sources = ['on_device','in_cloud'];
const rows = [];
let evaluate;
if (live) {
  const credential = readJSON(process.env.RECEIVING_DESK_CREDENTIAL_FILE);
  evaluate = createHostedEvaluate({...credential, timeoutMs:30000});
}

for (const route of sources) {
  const file = 'benchmark/observations/' + route + '.json';
  const observations = readJSON(existsSync(file) ? file : 'benchmark/observations/cloud-initial-failure.json');
  if (observations.length !== 12 || cases.length !== 12) throw Error('Expected twelve matched observations.');
  for (const [i, test] of cases.entries()) {
    const obs = observations[i];
    if (obs.id !== test.id || (obs.source && obs.source !== route)) throw Error('Observation route or order mismatch');
    const policy = evaluateReceivingBaseline(test.ordered, obs.draft ?? null);
    let receipt = null;
    // A transport failure produced no model observation to submit to either selector.
    if (obs.source) {
      const context = {case_id:test.id, inference_source:obs.source, ordered_cartons:test.ordered,
        physical_counts:JSON.stringify(obs.draft?.counts ?? []), unit:obs.draft?.unit ?? 'unknown',
        conflict:obs.draft?.conflict ?? null, valid_extraction:!!obs.draft};
      const candidates = policy.candidates.map(c => ({candidate_id:c.action, description:c.label,
        semantic_class:'validate', operator_reported_support:c.support}));
      const digest = createHash('sha256').update(JSON.stringify({context,candidates})).digest('hex');
      const key = 'receiving-desk-v1-' + route + '-' + test.id;
      const path = join(receiptsDir, key + '.json');
      if (existsSync(path)) {
        const recorded = readJSON(path);
        if (digest !== recorded.digest) throw Error('Receipt input mismatch for ' + key);
        receipt = recorded.receipt;
      } else if (live) {
        // Exclusive, durable reservation per frozen route/case stops duplicate sends after a crash.
        writeFileSync(path, JSON.stringify({digest,receipt:{status:'reserved'}}), {flag:'wx',flush:true});
        const start = performance.now();
        receipt = await evaluate({context,candidates,idempotencyKey:key});
        const hostedMs = Math.round(performance.now()-start);
        writeFileSync(path, JSON.stringify({digest,context,candidates,hostedMs,receipt},null,2)+'\n',{flush:true});
        console.log(key, receipt.status, receipt.code);
        if (!['selected','refused'].includes(receipt.status)) throw Error('Hosted request stopped: '+receipt.code);
      }
    }
    rows.push({id:test.id,note:test.note,poQty:test.ordered,expected:test.expected,route,source:obs.source,
      draft:obs.draft??null,extractionError:obs.error??null,elapsedMs:obs.elapsedMs,
      baseline:obs.source ? policy.action : 'unavailable',
      hostedDecision:receipt?.selectedCandidateId ?? receipt?.status ?? 'unavailable',
      receiptId:receipt?.receiptId??null});
  }
}
const metrics = [];
for (const route of sources) {
  const sample = rows.filter(r=>r.route===route);
  for (const selector of ['baseline','hostedDecision']) {
    const accept = r=>['partial','full'].includes(r[selector]);
    metrics.push({route,selector,cases:sample.length,
      exact:sample.filter(r=>r[selector]===r.expected).length,
      incorrectAcceptance:sample.filter(r=>accept(r)&&r[selector]!==r.expected).length,
      correctHolds:sample.filter(r=>r[selector]==='hold'&&r.expected==='hold').length,
      unnecessaryHolds:sample.filter(r=>r[selector]==='hold'&&r.expected!=='hold').length,
      unavailable:sample.filter(r=>r[selector]==='unavailable').length});
  }
}
const summary = {'Device extractions':rows.filter(r=>r.source==='on_device').length,
  'Cloud extractions':rows.filter(r=>r.source==='in_cloud').length,
  'Hosted receipts':rows.filter(r=>r.receiptId).length};
mkdirSync('public/data',{recursive:true});
writeFileSync('public/data/benchmark.json',JSON.stringify({summary,metrics,rows},null,2)+'\n');
console.table(metrics);
