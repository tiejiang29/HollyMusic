/**
 * git blob 的 sha1：`sha1("blob <字节数>\0" + 内容)`，也就是 GitHub 树接口里那个 sha。
 * 与 `git hash-object` 逐字节对过（见同目录的测试）—— 自己算完自证没有意义，
 * 因为这个值是用来判定"下下来的还是不是仓库里那一份"，算错了整套复验都白做。
 *
 * 单独成模块是因为它有**两个**方向相反的调用方：音源发现记录它（打分/判级前的身份），
 * 订阅导入复验它（执行与入库之前的最后一道完整性闸门）。放在任何一边都会让另一边反向依赖。
 */
import { createHash } from 'node:crypto'

export function gitBlobSha(content: string): string {
  const buf = Buffer.from(content, 'utf8')
  const header = Buffer.from(`blob ${buf.length}\0`, 'binary')
  return createHash('sha1').update(Buffer.concat([header, buf])).digest('hex')
}
