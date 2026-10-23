// POC-1 浏览器端 Univer OSS 1.1.0 preset 生命周期验证页
//
// 设计说明（全部中文注释，供 POC 报告引用）：
//   1. 1.1.0 的 core `Univer` 类没有 render() 方法（与 1.0.x 文档示例不同）；
//      渲染由 preset 内 UniverUIPlugin 的 `container` 选项（DOM 元素 id）自动完成，
//      本页面传 container: "editor"。
//   2. sheets / docs 两个 preset 各自注册 UniverUIPlugin、UniverRenderEnginePlugin、
//      UniverDocsPlugin；createUniver 按 pluginName 去重（后者覆盖前者），因此同一
//      Univer 实例可混合承载工作簿与文档（与官方组合示例一致）。
//   3. 公式计算证明：向 B11 setFormula("=A1*B1")（不带缓存值 v，f 必须带前导 "="），
//      浏览器端公式引擎应计算出 320；无头 node-core（1.0.4）不计算公式，此为两者
//      能力差异的证据。公式契约细节见 docs/poc/univer-matrix.md。
//   4. 页面保持可脚本化：#init / #edit / #destroy 为 index.html 中的静态按钮，
//      外部脚本（如浏览器自动化）可直接点击；React 仅渲染右下角状态角标。

import { useEffect, useRef, useState } from "react";
// 1.1.0 中 locales 是 createUniver 顶层选项（ILocales: { localeId: 语言包 }），
// 不属于 preset 配置；多 preset 语言包用 core 的 mergeLocales 合并后传入。
import { createUniver, LocaleType, mergeLocales } from "@univerjs/presets";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import sheetsZhCN from "@univerjs/preset-sheets-core/locales/zh-CN";
import { UniverDocsCorePreset } from "@univerjs/preset-docs-core";
import docsZhCN from "@univerjs/preset-docs-core/locales/zh-CN";
import { UniverSheetsConditionalFormattingPreset } from "@univerjs/preset-sheets-conditional-formatting";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const $status = (): HTMLSpanElement => document.getElementById("status") as HTMLSpanElement;
const $log = (): HTMLDivElement => document.getElementById("log") as HTMLDivElement;

function log(msg: string): void {
  const el = $log();
  const ts = new Date().toISOString().slice(11, 23);
  el.textContent += `[${ts}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

function mem(): string {
  const m = (performance as Any).memory;
  return m ? `内存 ${((m.usedJSHeapSize / 1048576) | 0)}MB` : "内存 n/a(仅 Chrome)";
}

type Phase = "idle" | "ready" | "destroyed";

export default function App(): JSX.Element {
  const [phase, setPhase] = useState<Phase>("idle");
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  const ctx = useRef<{ univer: Any; api: Any } | null>(null);

  useEffect(() => {
    // ---- 初始化：createUniver(presets) + 载入桥接生成的样例数据模型 ----
    const doInit = async (): Promise<void> => {
      if (phaseRef.current !== "idle" && phaseRef.current !== "destroyed") return;
      $status().textContent = "初始化中…";
      const t0 = performance.now();
      try {
        const { univer, univerAPI } = createUniver({
          locale: LocaleType.ZH_CN,
          locales: { [LocaleType.ZH_CN]: mergeLocales(sheetsZhCN, docsZhCN) },
          presets: [
            UniverSheetsCorePreset({ container: "editor" }),
            UniverDocsCorePreset({ container: "editor" }),
            UniverSheetsConditionalFormattingPreset(),
          ],
        });
        ctx.current = { univer, api: univerAPI };
        // 暴露给控制台/自动化脚本调试（POC 专用）
        (window as unknown as Record<string, unknown>).__poc = { univer, api: univerAPI };
        const [sheetJson, docJson] = await Promise.all([
          fetch("/samples/univer/sheet-sample.json").then((r) => r.json()),
          fetch("/samples/univer/doc-sample.json").then((r) => r.json()),
        ]);
        const tLoad = performance.now();
        univerAPI.createWorkbook(sheetJson);
        univerAPI.createDocument(docJson);
        const t1 = performance.now();
        log(`createUniver+3 preset: ${(tLoad - t0).toFixed(0)}ms`);
        log(`createWorkbook(poc-workbook)+createDocument(poc-doc): ${(t1 - tLoad).toFixed(0)}ms`);
        log(`初始化完成（${mem()}）`);
        $status().textContent = `就绪（${mem()}）`;
        setPhase("ready");
      } catch (e: Any) {
        log("初始化失败: " + (e && e.message ? e.message : String(e)));
        $status().textContent = "初始化失败（见日志）";
      }
    };

    // ---- 程序化编辑：值 / 公式（无缓存值）/ 样式 / 合并 / 追加段落 ----
    const doEdit = async (): Promise<void> => {
      const c = ctx.current;
      if (!c || phaseRef.current !== "ready") return;
      const { api } = c;
      const t0 = performance.now();
      try {
        const wb = api.getWorkbook("poc-workbook");
        const ws = wb.getSheetByName("销售");
        ws.getRange("A11").setValue("POC 浏览器追加行");
        // 无缓存值的公式：浏览器公式引擎必须自行算出 320（10*32）。
        // 注意：FRange.setFormula 的入参需带前导 "="（见官方 JSDoc 示例 '=SUM(A2:A5)'），
        // 引擎以 isFormulaString（首字符为 "="）识别公式；不带 "=" 会被当作普通值，
        // 公式数据模型为空 → 引擎 totalFormulasToCalculate=0 → 不产生计算结果。
        ws.getRange("B11").setFormula("=A1*B1");
        ws.getRange("A11").setFontWeight("bold").setBackgroundColor("#FFF2CC");
        ws.getRange("A13:B13").merge();
        const doc = api.getDocument("poc-doc");
        doc.appendParagraph("POC 浏览器端追加段落");
        log(`编辑下发: ${(performance.now() - t0).toFixed(1)}ms`);
        $status().textContent = "编辑中… 等待公式计算";

        // 公式计算是异步的：触发器要等 workbench 渲染到 Rendered 生命周期阶段
        // 才启动（DesktopUIController bootstrap + ~300ms + 双 rAF），故轮询回读，
        // 最长 10 秒。
        const readback = (): void => {
          try {
            const t1 = performance.now();
            const val = ws.getRange("B11").getValue();
            const formulaMs = performance.now() - t1;
            log(`B11 公式 A1*B1 计算值 = ${JSON.stringify(val)}（期望 320，轮询 ${(performance.now() - t0) / 1000 | 0}s）→ ${val === 320 ? "PASS" : "FAIL"}`);
            const sheetSnap: Any = wb.save();
            const sheetId: string = ws.getSheetId();
            const cellB11 = sheetSnap.sheets[sheetId].cellData[10] && sheetSnap.sheets[sheetId].cellData[10][1];
            log(`快照 B11 cellData: ${JSON.stringify(cellB11)}（save ${formulaMs.toFixed(1)}ms）`);
            const docSnap: Any = doc.save();
            const ds: string = docSnap.body.dataStream;
            log(`追加段落在快照中: ${ds.includes("POC 浏览器端追加段落")}；dataStream 尾部: ${JSON.stringify(ds.slice(-30))}`);
            log(`编辑完成（${mem()}）`);
            $status().textContent = `就绪（${mem()}）`;
          } catch (e2: Any) {
            log("回读失败: " + (e2 && e2.message ? e2.message : String(e2)));
            $status().textContent = "回读失败（见日志）";
          }
        };
        const deadline = performance.now() + 10000;
        const tick = (): void => {
          if (performance.now() > deadline) return readback();
          try {
            if (ws.getRange("B11").getValue() !== null && ws.getRange("B11").getValue() !== undefined) return readback();
          } catch {
            return readback();
          }
          setTimeout(tick, 250);
        };
        tick();
      } catch (e: Any) {
        log("编辑失败: " + (e && e.message ? e.message : String(e)));
        $status().textContent = "编辑失败（见日志）";
      }
    };

    // ---- 销毁：univer.dispose() ----
    const doDestroy = (): void => {
      const c = ctx.current;
      if (!c) return;
      try {
        c.univer.dispose();
        log("univer.dispose() 完成");
      } catch (e: Any) {
        log("销毁异常: " + (e && e.message ? e.message : String(e)));
      }
      ctx.current = null;
      $status().textContent = "已销毁（可重新初始化）";
      setPhase("destroyed");
    };

    const initBtn = document.getElementById("init");
    const editBtn = document.getElementById("edit");
    const destroyBtn = document.getElementById("destroy");
    const hInit = (): void => void doInit();
    const hEdit = (): void => void doEdit();
    const hDestroy = (): void => doDestroy();
    initBtn?.addEventListener("click", hInit);
    editBtn?.addEventListener("click", hEdit);
    destroyBtn?.addEventListener("click", hDestroy);
    return () => {
      initBtn?.removeEventListener("click", hInit);
      editBtn?.removeEventListener("click", hEdit);
      destroyBtn?.removeEventListener("click", hDestroy);
    };
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        top: 52,
        right: 8,
        fontSize: 11,
        color: "#666",
        background: "rgba(255,255,255,0.85)",
        padding: "2px 8px",
        borderRadius: 3,
        border: "1px solid #ddd",
      }}
    >
      Univer OSS 1.1.0 preset · React · 阶段: {phase}
    </div>
  );
}
