// GGUF 文件头部解析器：纯 Node 实现，仅读取文件头（KV 元数据 + tensor 信息表），
// 不加载权重数据。供「模型工具 → GGUF 检查器」与显存计算器使用。
import { promises as fsPromises } from 'fs'
import type { GgufKvEntry, GgufMetadata } from '../../shared/types'

// GGUF KV 值类型编号（ggml 规范）
const enum GgufType {
  UINT8 = 0, INT8 = 1, UINT16 = 2, INT16 = 3, UINT32 = 4, INT32 = 5,
  FLOAT32 = 6, BOOL = 7, STRING = 8, ARRAY = 9, UINT64 = 10, INT64 = 11, FLOAT64 = 12
}

const GGUF_TYPE_NAMES: Record<number, string> = {
  0: 'uint8', 1: 'int8', 2: 'uint16', 3: 'int16', 4: 'uint32', 5: 'int32',
  6: 'float32', 7: 'bool', 8: 'string', 9: 'array', 10: 'uint64', 11: 'int64', 12: 'float64'
}

// ggml tensor 数据类型编号 → 名称（ggml_type 枚举）
const GGML_TENSOR_TYPES: Record<number, string> = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 6: 'Q5_0', 7: 'Q5_1', 8: 'Q8_0', 9: 'Q8_1',
  10: 'Q2_K', 11: 'Q3_K', 12: 'Q4_K', 13: 'Q5_K', 14: 'Q6_K', 15: 'Q8_K',
  16: 'IQ2_XXS', 17: 'IQ2_XS', 18: 'IQ3_XXS', 19: 'IQ1_S', 20: 'IQ4_NL', 21: 'IQ3_S',
  22: 'IQ2_S', 23: 'IQ4_XS', 24: 'I8', 25: 'I16', 26: 'I32', 27: 'I64', 28: 'F64',
  29: 'IQ1_M', 30: 'BF16', 34: 'TQ1_0', 35: 'TQ2_0', 39: 'MXFP4'
}

// general.file_type 编号 → 可读量化名称（llama_ftype 枚举）
const FILE_TYPE_NAMES: Record<number, string> = {
  0: 'ALL_F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1',
  10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M', 13: 'Q3_K_L', 14: 'Q4_K_S', 15: 'Q4_K_M',
  16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K', 19: 'IQ2_XXS', 20: 'IQ2_XS', 21: 'Q2_K_S',
  22: 'IQ3_XS', 23: 'IQ3_XXS', 24: 'IQ1_S', 25: 'IQ4_NL', 26: 'IQ3_S', 27: 'IQ3_M',
  28: 'IQ2_S', 29: 'IQ2_M', 30: 'IQ4_XS', 31: 'IQ1_M', 32: 'BF16', 36: 'TQ1_0', 37: 'TQ2_0', 38: 'MXFP4'
}

const ARRAY_PREVIEW_MAX = 32          // 大数组（如词表）只保留前 N 项
const STRING_DISPLAY_MAX = 65536      // 单个字符串值上限（chat template 通常几 KB）
const HEADER_READ_LIMIT = 512 * 1024 * 1024 // 头部读取安全上限

// 带缓冲的顺序读取器：按需从 fd 补读，避免一次性读入整个文件
class GgufBufferedReader {
  private buf = Buffer.alloc(0)
  private bufStart = 0        // buf 相对文件的起始偏移
  private pos = 0             // 当前读取位置（文件偏移）
  constructor(private fd: fsPromises.FileHandle, private fileSize: number) {}

  get offset(): number { return this.pos }

  private async ensure(n: number): Promise<void> {
    const end = this.bufStart + this.buf.length
    if (this.pos + n <= end) return
    if (this.pos + n > this.fileSize) throw new Error('GGUF 文件头意外截断')
    if (this.pos > HEADER_READ_LIMIT) throw new Error('GGUF 头部超出读取上限')
    // 丢弃已消费部分，从当前位置起补读
    const CHUNK = 1024 * 1024
    const readLen = Math.max(n, CHUNK)
    const newBuf = Buffer.alloc(Math.min(readLen, this.fileSize - this.pos))
    const { bytesRead } = await this.fd.read(newBuf, 0, newBuf.length, this.pos)
    this.buf = newBuf.subarray(0, bytesRead)
    this.bufStart = this.pos
    if (bytesRead < n) throw new Error('GGUF 文件头读取失败')
  }

  private local(): number { return this.pos - this.bufStart }

  async u8(): Promise<number> { await this.ensure(1); const v = this.buf.readUInt8(this.local()); this.pos += 1; return v }
  async i8(): Promise<number> { await this.ensure(1); const v = this.buf.readInt8(this.local()); this.pos += 1; return v }
  async u16(): Promise<number> { await this.ensure(2); const v = this.buf.readUInt16LE(this.local()); this.pos += 2; return v }
  async i16(): Promise<number> { await this.ensure(2); const v = this.buf.readInt16LE(this.local()); this.pos += 2; return v }
  async u32(): Promise<number> { await this.ensure(4); const v = this.buf.readUInt32LE(this.local()); this.pos += 4; return v }
  async i32(): Promise<number> { await this.ensure(4); const v = this.buf.readInt32LE(this.local()); this.pos += 4; return v }
  async f32(): Promise<number> { await this.ensure(4); const v = this.buf.readFloatLE(this.local()); this.pos += 4; return v }
  async f64(): Promise<number> { await this.ensure(8); const v = this.buf.readDoubleLE(this.local()); this.pos += 8; return v }
  async u64(): Promise<number> { await this.ensure(8); const v = this.buf.readBigUInt64LE(this.local()); this.pos += 8; return Number(v) }
  async i64(): Promise<number> { await this.ensure(8); const v = this.buf.readBigInt64LE(this.local()); this.pos += 8; return Number(v) }
  async bool(): Promise<boolean> { return (await this.u8()) !== 0 }

  // 跳过 n 字节（无需实际读取，直接前移指针）
  async skip(n: number): Promise<void> {
    if (this.pos + n > this.fileSize) throw new Error('GGUF 文件头意外截断')
    this.pos += n
  }

  async str(): Promise<string> {
    const len = await this.u64()
    if (len === 0) return ''
    if (len > STRING_DISPLAY_MAX) {
      // 超长字符串：读前段做展示，跳过剩余
      await this.ensure(Math.min(len, STRING_DISPLAY_MAX))
      const head = this.buf.subarray(this.local(), this.local() + STRING_DISPLAY_MAX).toString('utf-8')
      this.pos += len
      return head + `…(共 ${len} 字节，已截断)`
    }
    await this.ensure(len)
    const v = this.buf.subarray(this.local(), this.local() + len).toString('utf-8')
    this.pos += len
    return v
  }
}

type Scalar = string | number | boolean

async function readScalar(r: GgufBufferedReader, type: number): Promise<Scalar> {
  switch (type) {
    case GgufType.UINT8: return r.u8()
    case GgufType.INT8: return r.i8()
    case GgufType.UINT16: return r.u16()
    case GgufType.INT16: return r.i16()
    case GgufType.UINT32: return r.u32()
    case GgufType.INT32: return r.i32()
    case GgufType.FLOAT32: return r.f32()
    case GgufType.BOOL: return r.bool()
    case GgufType.STRING: return r.str()
    case GgufType.UINT64: return r.u64()
    case GgufType.INT64: return r.i64()
    case GgufType.FLOAT64: return r.f64()
    default: throw new Error(`未知的 GGUF 值类型: ${type}`)
  }
}

function asNumber(v: Scalar | undefined): number | undefined {
  return typeof v === 'number' ? v : undefined
}
function asString(v: Scalar | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined
}

export async function readGgufMeta(path: string): Promise<GgufMetadata> {
  const fd = await fsPromises.open(path, 'r')
  try {
    const fileSize = (await fd.stat()).size
    const r = new GgufBufferedReader(fd, fileSize)
    const magic = await r.u32()
    if (magic !== 0x46554747) throw new Error('不是有效的 GGUF 文件（magic 不匹配）')
    const version = await r.u32()
    if (version < 2 || version > 3) throw new Error(`不支持的 GGUF 版本: ${version}`)
    const tensorCount = await r.u64()
    const kvCount = await r.u64()

    const kv: GgufKvEntry[] = []
    const rawValues = new Map<string, Scalar>()      // 标量值原文，供便捷字段提取
    const arrayLengths = new Map<string, number>()   // 数组长度（如词表大小）

    for (let i = 0; i < kvCount; i++) {
      const key = await r.str()
      const type = await r.u32()
      if (type === GgufType.ARRAY) {
        const elemType = await r.u32()
        const len = await r.u64()
        const preview: Scalar[] = []
        if (elemType === GgufType.STRING) {
          // 字符串数组无法按固定步长跳过，只能逐项读取（str() 内部对超长项已截断）
          for (let j = 0; j < len; j++) {
            const s = await r.str()
            if (j < ARRAY_PREVIEW_MAX) preview.push(s)
          }
        } else if (elemType === GgufType.ARRAY) {
          throw new Error('不支持嵌套数组类型的 GGUF 元数据')
        } else {
          for (let j = 0; j < Math.min(len, ARRAY_PREVIEW_MAX); j++) preview.push(await readScalar(r, elemType))
          // 跳过剩余定长元素
          const elemSize = [1, 1, 2, 2, 4, 4, 4, 1, 0, 0, 8, 8, 8][elemType] ?? 0
          if (elemSize === 0) throw new Error(`数组元素类型无法跳过: ${elemType}`)
          const remaining = len - Math.min(len, ARRAY_PREVIEW_MAX)
          if (remaining > 0) await r.skip(remaining * elemSize)
        }
        arrayLengths.set(key, len)
        kv.push({ key, type: `array[${GGUF_TYPE_NAMES[elemType] ?? elemType}]`, value: null, arrayLength: len, arrayPreview: preview })
      } else {
        const value = await readScalar(r, type)
        rawValues.set(key, value)
        kv.push({ key, type: GGUF_TYPE_NAMES[type] ?? String(type), value })
      }
    }

    // tensor 信息表：name / dims / type / offset，汇总量化类型分布与参数量
    let paramCount = 0
    const typeStats = new Map<string, { count: number; params: number }>()
    for (let i = 0; i < tensorCount; i++) {
      await r.str() // tensor 名称（汇总统计不需要逐个保留）
      const nDims = await r.u32()
      if (nDims > 8) throw new Error(`tensor 维度异常: ${nDims}`)
      let elems = 1
      for (let d = 0; d < nDims; d++) elems *= await r.u64()
      const tType = await r.u32()
      await r.u64() // offset
      paramCount += elems
      const typeName = GGML_TENSOR_TYPES[tType] ?? `type_${tType}`
      const stat = typeStats.get(typeName) ?? { count: 0, params: 0 }
      stat.count += 1
      stat.params += elems
      typeStats.set(typeName, stat)
    }

    const arch = asString(rawValues.get('general.architecture'))
    const fileTypeId = asNumber(rawValues.get('general.file_type'))
    const vocabFromArray = arrayLengths.get('tokenizer.ggml.tokens')
    const meta: GgufMetadata = {
      path,
      fileSize,
      version,
      tensorCount,
      kvCount,
      paramCount,
      architecture: arch,
      modelName: asString(rawValues.get('general.name')),
      fileTypeName: fileTypeId !== undefined ? (FILE_TYPE_NAMES[fileTypeId] ?? `ftype_${fileTypeId}`) : undefined,
      contextLength: arch ? asNumber(rawValues.get(`${arch}.context_length`)) : undefined,
      blockCount: arch ? asNumber(rawValues.get(`${arch}.block_count`)) : undefined,
      headCount: arch ? asNumber(rawValues.get(`${arch}.attention.head_count`)) : undefined,
      headCountKv: arch ? asNumber(rawValues.get(`${arch}.attention.head_count_kv`)) : undefined,
      embeddingLength: arch ? asNumber(rawValues.get(`${arch}.embedding_length`)) : undefined,
      expertCount: arch ? asNumber(rawValues.get(`${arch}.expert_count`)) : undefined,
      vocabSize: vocabFromArray ?? (arch ? asNumber(rawValues.get(`${arch}.vocab_size`)) : undefined),
      chatTemplate: asString(rawValues.get('tokenizer.chat_template')),
      kv,
      tensorTypes: Array.from(typeStats.entries())
        .map(([type, s]) => ({ type, count: s.count, params: s.params }))
        .sort((a, b) => b.params - a.params)
    }
    return meta
  } finally {
    await fd.close()
  }
}
