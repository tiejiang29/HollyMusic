/**
 * 应用版本号（单一来源：package.json，构建时静态内联）。
 * 侧栏/版本 API 共用；发版流程：改 package.json version → 打 v* git tag。
 */
import pkg from '../package.json'

export const APP_VERSION = pkg.version
