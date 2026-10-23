import { readFileSync } from 'node:fs';
import { createUniver } from '@univerjs/presets';
import { UniverDocsPlugin } from '@univerjs/docs';
import { UniverDocsHyperLinkPlugin } from '@univerjs/docs-hyper-link';
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import { UniverThreadCommentPlugin } from '@univerjs/thread-comment';
import '@univerjs/docs/facade';
import '@univerjs/engine-formula/facade';

const docSample = JSON.parse(readFileSync('../samples/univer/doc-sample.json', 'utf-8'));
const { univer, univerAPI } = createUniver({
  presets: [{ plugins: [
    [UniverFormulaEnginePlugin, { function: undefined }],
    UniverThreadCommentPlugin,
    UniverDocsPlugin,
    UniverDocsHyperLinkPlugin,
  ]}],
});
univerAPI.loadLocales('zhCN', {});
const fDoc = univerAPI.createDocument(docSample);
const paras = fDoc.getParagraphs();
console.log('paragraphs:', paras.length);
const ds2 = fDoc.getBody().dataStream;
console.log('MODEL ds len:', ds2.length, 'orig len:', docSample.body.dataStream.length);
console.log('MODEL ds head:', JSON.stringify(ds2.slice(0, 40)));
for (const p of paras) {
  let t = '', r = '';
  try { t = JSON.stringify(p.getText()); r = JSON.stringify(p.getRange()); } catch (e) { t = 'ERR ' + e.message; }
  console.log(p.getId(), r, '=>', t.slice(0, 60));
}
const f = fDoc.findParagraphByText('Univer POC');
console.log('find:', f ? f.getId() : null);
univer.dispose();
