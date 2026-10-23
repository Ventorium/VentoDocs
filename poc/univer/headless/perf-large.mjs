#!/usr/bin/env node
/**
 * POC-1 无头（Node）性能基准：20k 行工作簿 载入 → 编辑 → 导出快照
 *
 * 运行：node headless/perf-large.mjs
 * 产物：headless/out/perf-large.json（耗时/内存/快照体积指标）
 *
 * 度量口径：
 *  - loadMs    createWorkbook(桥接JSON) 耗时
 *  - editMs    一次程序化编辑（首行 A2 写入）耗时
 *  - saveMs    wb.save() 全量快照序列化耗时
 *  - memory    RSS/堆占用（MB），分别在载入前/编辑后/保存后采样
 *  - snapshotBytes  快照 JSON 字符串字节数（导出体量参考）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createUniver } from '@univerjs/presets';
import { UniverSheetsNodeCorePreset } from '@univerjs/preset-sheets-node-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(__dirname, 'out');
mkdirSync(outDir, { recursive: true });

const sample = JSON.parse(readFileSync(path.join(root, 'samples/univer/large-sheet.json'), 'utf-8'));
const sheetKey = sample.sheetOrder[0];
const rowCount = sample.sheets[sheetKey].rowCount;

const mem = () => {
  const m = process.memoryUsage();
  return { rssMB: Math.round(m.rss / 1048576 * 100) / 100, heapMB: Math.round(m.heapUsed / 1048576 * 100) / 100 };
};

const { univer, univerAPI } = createUniver({
  presets: [UniverSheetsNodeCorePreset()],
});
univerAPI.loadLocales('zhCN', {});

const before = mem();

// ---- 载入
const t0 = process.hrtime.bigint();
const wb = univerAPI.createWorkbook(sample);
const t1 = process.hrtime.bigint();
const loadMs = Number(t1 - t0) / 1e6;

// ---- 编辑（首数据行 A2 写入）
const ws = wb.getSheetBySheetId(sheetKey);
const t2 = process.hrtime.bigint();
ws.getRange(1, 0).setValue('perf-poc-edit');
const t3 = process.hrtime.bigint();
const editMs = Number(t3 - t2) / 1e6;
const afterEdit = mem();

// ---- 导出快照（save() 序列化全量 cellData）
const t4 = process.hrtime.bigint();
const snapshot = wb.save();
const jsonBytes = JSON.stringify(snapshot).length;
const t5 = process.hrtime.bigint();
const saveMs = Number(t5 - t4) / 1e6;
const afterSave = mem();

const report = {
  rows: rowCount,
  cols: sample.sheets[sheetKey].columnCount,
  loadMs: Math.round(loadMs * 100) / 100,
  editMs: Math.round(editMs * 100) / 100,
  saveMs: Math.round(saveMs * 100) / 100,
  totalMs: Math.round((loadMs + editMs + saveMs) * 100) / 100,
  memory: { before, afterEdit, afterSave },
  snapshotBytes: jsonBytes,
  snapshotMB: Math.round((jsonBytes / 1048576) * 100) / 100,
};
writeFileSync(path.join(outDir, 'perf-large.json'), JSON.stringify(report, null, 2), 'utf-8');
console.log(JSON.stringify(report, null, 2));
univer.dispose();
