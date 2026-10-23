// 探针：无头环境下公式单元格的求值行为（临时脚本，验证后删除）
import { createUniver } from '@univerjs/presets';
import { UniverSheetsNodeCorePreset } from '@univerjs/preset-sheets-node-core';

const { univer, univerAPI } = createUniver({ presets: [UniverSheetsNodeCorePreset()] });
univerAPI.loadLocales('zhCN', {});
const wb = univerAPI.createWorkbook({
  id: 'w', name: 'w',
  sheetOrder: ['s1'],
  sheets: { s1: {
    id: 's1', name: 'S1', rowCount: 10, columnCount: 10,
    cellData: {
      '0': { '0': { v: 10, t: 2 }, '1': { v: 32, t: 2 } },
      '1': { '0': { f: 'A1+B1' } },
      '2': { '0': { f: 'SUM(A1:B1)*2' } },
    },
    mergeData: [],
  } },
});
const s = wb.getSheetByName('S1');
console.log('A2 getValue', s.getRange('A2').getValue());
console.log('A2 getRawValue', JSON.stringify(s.getRange('A2').getRawValue()));
console.log('A3 getValue', s.getRange('A3').getValue());
await new Promise((r) => setTimeout(r, 500));
console.log('A2 after wait', s.getRange('A2').getValue());
const snap = wb.save();
console.log('snap A2', JSON.stringify(snap.sheets['s1'].cellData['1']['0']));
console.log('snap A3', JSON.stringify(snap.sheets['s1'].cellData['2']['0']));
univer.dispose();
