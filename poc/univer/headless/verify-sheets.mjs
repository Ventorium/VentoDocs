#!/usr/bin/env node
/**
 * POC-1 无头（Node）验证：xlsx 链路 导入(桥接JSON) → 校验 → 程序化编辑 → 导出快照
 *
 * 运行：node headless/verify-sheets.mjs
 * 产物：headless/out/sheet-snapshot.json（wb.save() 快照，供 Python 复核）
 *
 * 说明：
 *  - OSS 无 xlsx 文件导入器，"导入"一步由 samples/office_to_univer.py 桥接模拟；
 *  - "导出"得到的是 Univer 快照（IWorkbookData JSON），非 .xlsx 文件（xlsx 导出为 Pro 功能）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createUniver } from '@univerjs/presets';
import { UniverSheetsNodeCorePreset } from '@univerjs/preset-sheets-node-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'headless', 'out');
mkdirSync(outDir, { recursive: true });

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail ?? '' });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

const t0 = process.hrtime.bigint();

// ---- 初始化实例
const { univer, univerAPI } = createUniver({
  presets: [UniverSheetsNodeCorePreset()],
});
// Node 环境无 UI 语言包，加载空 locale 避免权限校验时 LocaleService 抛错
univerAPI.loadLocales('zhCN', {});

const sample = JSON.parse(readFileSync(path.join(root, 'samples/univer/sheet-sample.json'), 'utf-8'));

// ---- "导入"：createWorkbook 载入桥接 JSON
const wb = univerAPI.createWorkbook(sample);
check('加载工作簿', !!wb && wb.getId() === sample.id, wb.getId());
check('工作表数量', wb.getNumSheets() === 2, `实际 ${wb.getNumSheets()}`);

const wsSales = wb.getSheetByName('销售');
const wsNote = wb.getSheetByName('备注');
check('按名取表(销售)', !!wsSales);
check('按名取表(备注)', !!wsNote);

// ---- 工具：单元格坐标转换
function cellToRC(coord) {
  const m = /^([A-Z]+)(\d+)$/.exec(coord);
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return [c - 1, parseInt(m[2], 10) - 1];
}
function readCell(ws, coord) {
  const [c, r] = cellToRC(coord);
  return ws.getRange(r, c).getValue();
}

// ---- 校验加载后的值 / 公式 / 合并
check('A1 值=10', readCell(wsSales, 'A1') === 10, String(readCell(wsSales, 'A1')));
check('B1 值=32', readCell(wsSales, 'B1') === 32, String(readCell(wsSales, 'B1')));
// A2 公式 =A1+B1：无头环境公式引擎应计算出 42
check('A2 公式结果=42', wsSales.getRange('A2').getValue() === 42, `getValue=${wsSales.getRange('A2').getValue()}`);
check('G6 公式=E6*F6=420', wsSales.getRange('G6').getValue() === 420, `getValue=${wsSales.getRange('G6').getValue()}`);
check('跨表公式 备注!B2=1002', wsNote.getRange('B2').getValue() === 1002, `getValue=${wsNote.getRange('B2').getValue()}`);

const merges = wsSales.getMergeData().map((m) => m.getA1Notation());
check('合并区域 D4:G4', merges.some((a) => a.toUpperCase() === 'D4:G4'), JSON.stringify(merges));

// ---- 程序化编辑（验证 OSS 可编辑范围）
wsSales.getRange('A11').setValue('POC 追加行');
wsSales.getRange('B11').setValue({ f: 'SUM(G6:G10)' });
wsSales.getRange('A13:B13').merge();
wsSales.getRange('A11').setFontWeight('bold').setBackgroundColor('#FFF2CC');
check('编辑后 A11 可读', wsSales.getRange('A11').getValue() === 'POC 追加行');
// 无头 node-core 不重算公式：新写入的公式单元格读不到值属预期；
// 公式文本是否在快照中正确保留见下方快照检查
const mergesAfter = wsSales.getMergeData().map((m) => m.getA1Notation());
check('编辑后合并 A13:B13', mergesAfter.some((a) => a === 'A13:B13'), JSON.stringify(mergesAfter));
wsSales.insertRows(12); // 0-based 12 = 1-based 第 13 行之前，合并区被推移到 A14:B14
check('插入行后 G10 缓存值不变=240', wsSales.getRange('G10').getValue() === 240, `= ${wsSales.getRange('G10').getValue()}`);
const mergesAfterInsert = wsSales.getMergeData().map((m) => m.getA1Notation());
check('插入行后合并区推移到 A14:B14', mergesAfterInsert.some((a) => a === 'A14:B14'), JSON.stringify(mergesAfterInsert));

// undo/redo 验证（独立单命令，避免多命令栈干扰）
wsSales.getRange('A15').setValue('undo-redo-test');
check('undo 前 A15 已写入', wsSales.getRange('A15').getValue() === 'undo-redo-test');
wb.undo();
check('undo 回退 A15', wsSales.getRange('A15').getValue() == null, `=${wsSales.getRange('A15').getValue()}`);
wb.redo();
check('redo 恢复 A15', wsSales.getRange('A15').getValue() === 'undo-redo-test', `=${wsSales.getRange('A15').getValue()}`);

// ---- "导出"：快照
const snapshot = wb.save();
writeFileSync(path.join(outDir, 'sheet-snapshot.json'), JSON.stringify(snapshot, null, 1));
check('快照 sheets 数', Object.keys(snapshot.sheets).length === 2);
const salesSnap = snapshot.sheets[Object.keys(snapshot.sheets).find((k) => snapshot.sheets[k].name === '销售')];
const snapA2 = salesSnap && salesSnap.cellData && salesSnap.cellData[1] && salesSnap.cellData[1][0];
check('快照含 A2 公式', !!snapA2 && (snapA2.f === 'A1+B1' || snapA2.f === '=A1+B1'), JSON.stringify(snapA2));
const snapB11 = salesSnap.cellData && salesSnap.cellData[10] && salesSnap.cellData[10][1];
check('快照含 B11 公式文本', !!snapB11 && snapB11.f === 'SUM(G6:G10)', JSON.stringify(snapB11));

// ---- 生命周期：disposeUnit
let disposed = true;
try {
  univerAPI.disposeUnit(sample.id);
} catch (e) {
  disposed = false;
  console.log(e);
}
check('disposeUnit 销毁', disposed);
const tEnd = Number(process.hrtime.bigint() - t0) / 1e6;
univer.dispose();

console.log('\n=== 结果汇总 ===');
const pass = results.filter((x) => x.ok).length;
console.log(`PASS ${pass}/${results.length}, 总耗时 ${tEnd.toFixed(0)}ms`);
writeFileSync(
  path.join(outDir, 'sheet-results.json'),
  JSON.stringify({ pass, total: results.length, ms: tEnd, results }, null, 1)
);
process.exit(pass === results.length ? 0 : 1);
