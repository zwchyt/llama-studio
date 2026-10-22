// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║ 区域：文件扩展名分类集合（兼容出口）                                          ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
// 集合与判定已上移到 `src/renderer/src/utils/fileKind.ts`——预览、文件树、Monaco
// 语言映射三处都要用，留在 agent-code 子目录里会让上层反向依赖。此处只保留原导出
// 路径（既有 import 不必改），新增代码请直接从 utils/fileKind 引入。

export { CODE_EXT, MD_EXT, IMG_EXT, extOf, kindOf, type FileKind } from '../../../utils/fileKind'
