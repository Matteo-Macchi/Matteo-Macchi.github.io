import fs from 'node:fs';
import vm from 'node:vm';

globalThis.window=globalThis;
vm.runInThisContext(fs.readFileSync(new URL('./tax-engine.js',import.meta.url),'utf8'));
const data=JSON.parse(fs.readFileSync(new URL('../data/portfolio.json',import.meta.url),'utf8'));
const t=data.taxCrossBorder;
const engine=globalThis.VirtualWealthTaxEngine;
const result=engine.calculate(t);
const close=(a,b,tolerance=.02)=>Math.abs(Number(a)-Number(b))<=tolerance;
const assert=(condition,message)=>{if(!condition) throw new Error(message);};

const balanceTotal=Object.values(t.clientTaxProfile.balanceSheet).reduce((sum,value)=>sum+value,0);
assert(balanceTotal===20000000,'Rossi balance sheet must total €20m.');
assert(t.clientTaxProfile.balanceSheet.publicMarketsOriginalCapital===5000000,'Public Markets original capital must remain €5m.');
assert(t.clientTaxProfile.balanceSheet.alternativesReserve===5000000,'Alternatives reserve must remain €5m.');
assert(t.incomeSources.find(row=>row.id==='alternatives-income').amount===0,'Alternatives income must remain zero/TBD.');
assert(t.incomeSources.find(row=>row.id==='future-trust-income').amount===0,'Future trust income must remain excluded.');
assert(t.clientTaxProfile.properties.london.mortgage===0,'London mortgage must be zero.');
assert(t.clientTaxProfile.properties.sardinia.mortgage===389000,'€389k mortgage must belong to Sardinia.');
assert(t.incomeSources.find(row=>row.id==='isa-realised').amount===0,'ISA realised gain must remain zero.');
assert(t.realisedTaxEvents.find(row=>row.id==='bitcoin-2026').amount===0,'Bitcoin realised gain must remain zero.');
assert(t.unrealisedItems.every(row=>row.status==='excluded'),'Unrealised performance must be excluded from annual taxable income.');

for(const [id,expected] of Object.entries(t.taxResults.recurring)) assert(close(result.recurring[id].total,expected),`Recurring tax mismatch: ${id}.`);
for(const [id,expected] of Object.entries(t.taxResults.current2026)) assert(close(result.current2026[id].total,expected),`2026 tax mismatch: ${id}.`);
assert(t.taxResults.selectedRegime==='impatriati-y1-5','Selected regime must be Impatriati Y1–5.');

const brent=t.realisedTaxEvents.find(row=>row.id==='brent-2026');
const brentTax=brent.amount*brent.modelTaxRate;
assert(close(result.current2026['impatriati-y1-5'].total-result.recurring['impatriati-y1-5'].total,brentTax),'Brent gain must appear once in 2026.');
assert(close(result.tenYear.find(row=>row.id==='impatriati').total,824618.75),'Brent must not enter the recurring 10-year path.');

console.log(JSON.stringify({
  balanceSheetTotal:balanceTotal,
  selectedRegime:t.taxResults.selectedRegime,
  recurringTax:result.recurring['impatriati-y1-5'].total,
  current2026Tax:result.current2026['impatriati-y1-5'].total,
  brentTax,
  tenYearImpatriati:result.tenYear.find(row=>row.id==='impatriati').total
},null,2));
