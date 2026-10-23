// docx headless 链路验证：import(桥接 JSON) → edit → export(save 快照)
// 版本线：1.0.4（headless node preset）
//
// POC 发现（1.0.4 preset-docs-node-core 的两个坑，均已在本文件规避）：
// 1. preset-docs-node-core 未包含 `import "@univerjs/docs/facade"` 副作用导入
//    （sheets node preset 有对应的），导致 univerAPI.createDocument 缺失。
//    需手动 import（且 @univerjs/docs 必须是直接依赖，pnpm strict 布局）。
// 2. preset 内含 UniverDocsDrawingPlugin，其依赖 engine-render.render-manager.service，
//    该服务在 headless Node 中未注册 → 第一个编辑操作（如 appendParagraph）即抛
//    "[redi]: Expect 1 dependency item(s) for id engine-render.render-manager.service"。
//    规避：手工组装插件列表，去掉 drawing（文档文本链路验证不需要渲染）。
import { writeFileSync, mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { createUniver } from '@univerjs/presets';
import { UniverDocsPlugin } from '@univerjs/docs';
import { UniverDocsHyperLinkPlugin } from '@univerjs/docs-hyper-link';
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import { UniverThreadCommentPlugin } from '@univerjs/thread-comment';
// POC 发现 1 的规避：补上 preset 遗漏的 facade 副作用导入
import '@univerjs/docs/facade';
import '@univerjs/engine-formula/facade';
import { IRenderManagerService } from '@univerjs/engine-render';

const docSample = JSON.parse(readFileSync('../samples/univer/doc-sample.json', 'utf-8'));
const expected = JSON.parse(readFileSync('../samples/univer/doc-expected.json', 'utf-8'));

// POC 发现 2 的规避：手工组装，等价于 UniverDocsNodeCorePreset() 去掉 UniverDocsDrawingPlugin
const { univer, univerAPI } = createUniver({
  presets: [{
    plugins: [
      [UniverFormulaEnginePlugin, { function: undefined }],
      UniverThreadCommentPlugin,
      UniverDocsPlugin,
      UniverDocsHyperLinkPlugin,
    ],
  }],
});
univerAPI.loadLocales('zhCN', {});

// POC 发现 3：docs 的核心编辑 mutation(RichTextEditingMutation)硬依赖
// IRenderManagerService(engine-render 提供)，headless node 未注册渲染服务
// → 注册一个 no-op stub 满足依赖注入（docs 侧只调用 getRenderUnitById，
// 返回 undefined 时代码走 ?. 优雅跳过）。这是 POC 的适配手段，非产品行为。
// redi 的 add 只接收一个元组参数 [token, item]（传两个参数会注册到 undefined 键上，静默无效）
univer.__getInjector().add([
  IRenderManagerService,
  { useValue: { getRenderUnitById: () => undefined } },
]);

const t0 = Date.now();
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
}

// ============ import：createDocument ============
const fDoc = univerAPI.createDocument(docSample);
check('import: createDocument 成功', !!fDoc);
check('docId 一致', fDoc.getId() === 'poc-doc', 'got ' + fDoc.getId());

const body = fDoc.getBody();
check('dataStream 非空(>100)', body.dataStream.length > 100, 'len=' + body.dataStream.length);
check('dataStream 以 \0 结尾', body.dataStream.endsWith('\u0000'));
check('dataStream 含标题文本', body.dataStream.includes('Univer POC 样例文档'));
check('dataStream 含三级标题文本', body.dataStream.includes('1.1 小节'));
check('段落数 === 18', fDoc.getParagraphs().length === 18, 'got ' + fDoc.getParagraphs().length);

const found = fDoc.findParagraphByText('Univer POC 样例文档');
check('findParagraphByText 命中标题段', !!found && found.getText() === 'Univer POC 样例文档',
  found ? 'text=' + JSON.stringify(found.getText()) : 'null');

// 表格哨兵：\x1a 表格开始
const taCount = body.dataStream.split('\u001a').length - 1;
check('表格哨兵 \\x1a 出现 1 次', taCount === 1, 'got ' + taCount);
const tb = (body.tables || [])[0];
check('body.tables[0] 存在', !!tb, JSON.stringify(tb));
const ts = (docSample.tableSource || {})[(tb && tb.tableId) || ''];
check('tableSource 行/列数正确', !!ts && ts.tableRows.length === 3 && ts.tableColumns.length === 3
  && ts.tableRows[0].tableCells.length === 3);

// ============ edit：追加段落 + 插入文本 ============
const okAppend = fDoc.appendParagraph('POC 追加段落');
check('edit: appendParagraph 成功', !!okAppend);
check('edit: 段落数 +1', fDoc.getParagraphs().length === 19, 'got ' + fDoc.getParagraphs().length);
check('edit: find 命中追加段', !!fDoc.findParagraphByText('POC 追加段落'));

const okInsert = fDoc.insertText(0, '【编辑】');
check('edit: insertText(0, ...) 成功', okInsert === true);
check('edit: dataStream 已更新', fDoc.getBody().dataStream.startsWith('【编辑】'));

// ============ undo / redo ============
const und = fDoc.undo();
check('undo() 成功', und === true);
check('undo 后【编辑】消失', !fDoc.getBody().dataStream.startsWith('【编辑】'));
const red = fDoc.redo();
check('redo() 成功', red === true);
check('redo 后【编辑】恢复', fDoc.getBody().dataStream.startsWith('【编辑】'));

// ============ export：save() 快照 ============
const snapshot = fDoc.save();
const snapStr = JSON.stringify(snapshot);
check('export: save() 含追加段', snapStr.includes('POC 追加段落'));
check('export: save() 含【编辑】前缀', snapshot.body.dataStream.startsWith('【编辑】'));
check('export: save() 保留表格', (snapshot.body.tables || []).length === 1
  && !!snapshot.tableSource['tbl-01']);
check('export: save() 保留 18→19 段', (snapshot.body.paragraphs || []).length === 19,
  'got ' + (snapshot.body.paragraphs || []).length);

mkdirSync('out', { recursive: true });
writeFileSync('out/doc-snapshot.json', JSON.stringify(snapshot, null, 2));
check('out/doc-snapshot.json 已写出', readFileSync('out/doc-snapshot.json', 'utf-8').includes('POC 追加段落'));

fDoc.dispose();
univer.dispose();

console.log('\n=== docx headless 链路: ' + pass + ' PASS / ' + fail + ' FAIL, 耗时 ' + (Date.now() - t0) + 'ms ===');
process.exit(fail === 0 ? 0 : 1);
