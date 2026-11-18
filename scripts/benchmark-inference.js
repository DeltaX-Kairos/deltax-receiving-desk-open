import cases from '../benchmark/cases.json';
import { extractReceipt } from '../src/firebase.js';

const run = document.querySelector('#run');
const progress = document.querySelector('#progress');
const records = document.querySelector('#records');
const storageKey = 'receiving-desk-frozen-inference-v1';
const output = JSON.parse(localStorage.getItem(storageKey) || '[]');
function render() {
  records.textContent = JSON.stringify(output, null, 2);
  run.disabled = output.length === cases.length;
  progress.textContent = run.disabled ? 'Completed 12 cases' : 'Ready · ' + output.length + ' saved';
}
render();
run.addEventListener('click', async () => {
  run.disabled = true;
  for (const {id, note} of cases.slice(output.length)) {
    progress.textContent = 'Extracting ' + id;
    const start = performance.now();
    let record;
    try {
      record = {id, ...await extractReceipt(note, 'prefer_on_device')};
    } catch (error) {
      record = {id, source:error.source ?? null, error:String(error.code ?? error.name), raw:error.raw ?? null};
    }
    output.push({...record, elapsedMs:Math.round(performance.now() - start)});
    localStorage.setItem(storageKey, JSON.stringify(output));
    records.textContent = JSON.stringify(output, null, 2);
  }
  render();
});
