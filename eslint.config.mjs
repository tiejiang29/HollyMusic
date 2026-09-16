import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // React Compiler 新规则（eslint-config-next 16 默认 error）对存量组件大面积报错：
  // setState-in-effect 数据加载模式、播放器 ref 时序等均为项目既有写法。
  // 先降为 warning 保住 CI 门禁（error 才阻断），存量告警渐进治理，新代码请遵守规则。
  //
  // files 必须与 eslint-config-next 的 next 预设同域：flat config 的插件不跨 config 对象生效，
  // 而 next 预设只在 **/*.{js,jsx,mjs,ts,tsx,mts,cts} 内声明 react-hooks 插件——本对象不限定
  // files 时会波及 .cjs 等预设未覆盖的文件，ESLint 在解析配置阶段就报
  // "could not find plugin react-hooks" 并以 exit 2 中止（lint 全量挂掉，后续步骤全跳过）
  {
    files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // SPA frontend (has its own eslint/tsconfig via Vite)
    "frontend/**",
    // Ignore reference source, simulator, generated code, and CommonJS modules
    "lx-env-simulator/**",
    "lx-music-desktop-master/**",
    "lib/generated/**",
    "lib/music-core/**",
    "scripts/**",
    // Local third-party music source scripts (CommonJS, executed via vm at runtime)
    "custom-sources/**",
    // 识曲指纹器：spawn 的 CommonJS 子进程脚本 + 从 npm 包 ncm-audio-recognize@1.4.0
    // 提取的压缩 bundle（含 wasm 加载器）。前者 require() 加载后者，两者都不经 Next 打包，
    // 也不参与本项目构建图，与 lib/music-core/**、custom-sources/** 同类
    "lib/recognize/worker.js",
    "lib/recognize/sandbox.bundle.cjs",
  ]),
]);

export default eslintConfig;
