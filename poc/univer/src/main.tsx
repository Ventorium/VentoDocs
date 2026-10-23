// POC-1 浏览器端入口：React + Vite + TS 工具链 + Univer OSS 1.1.0 preset
// 静态按钮（#init/#edit/#destroy）保留在 index.html，便于无 JS 环境脚本化点击；
// React 仅承载状态展示组件，Univer 实例逻辑全部在 App.tsx 的 useEffect 中。
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
// Univer 官方 CSS（preset 包内 lib/index.css，1.1.0 起不再单独分发 design.css）
import "@univerjs/preset-sheets-core/lib/index.css";
import "@univerjs/preset-docs-core/lib/index.css";
import "@univerjs/preset-sheets-conditional-formatting/lib/index.css";

const rootEl = document.getElementById("react-root");
if (!rootEl) throw new Error("missing #react-root");
createRoot(rootEl).render(<App />);
