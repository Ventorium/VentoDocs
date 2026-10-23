// 探针：headless 下 FRange.merge() 是否生效（临时脚本，验证后删除）
import { readFileSync } from 'node:fs';
import { createUniver } from '@univerjs/presets';
import { UniverSheetsNodeCorePreset } from '@univerjs/preset-sheets-node-core';

const sample = JSON.parse(readFileSync(new URL('../samples/univer/sheet-sample.json', import.meta.url), 'utf-8'));
const { univer, univerAPI } = createUniver({ presets: [UniverSheetsNodeCorePreset()] });
univerAPI.loadLocales('zhCN', {});
const wb = univerAPI.createWorkbook(sample);
const ws = wb.getSheetByName('销售');
console.log('合并前:', JSON.stringify(ws.getMergeData().map(m => m.getA1Notation())));
try {
  const r = ws.getRange('A13:B13');
  r.merge();
  console.log('merge() 无异常');
} catch (e) {
  console.log('merge() 抛错:', e.message);
}
console.log('合并后:', JSON.stringify(ws.getMergeData().map(m => m.getA1Notation())));
try {
  ws.getRange('C13:D13').merge({ isForceMerge: false });
  console.log('带参合并后:', JSON.stringify(ws.getMergeData().map(m => m.getA1Notation())));
} catch (e) {
  console.log('带参 merge 抛错:', e.message);
}
wb.dispose();
