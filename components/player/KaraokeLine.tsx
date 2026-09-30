import { findActiveWordIndex, type LrcLine } from '@/lib/utils/lrc'

/**
 * 逐字行的渲染单元：已唱的块显主色，未唱的块显暗色，当前块内做进度填充。
 *
 * 填充靠每个块自身 200% 宽的渐变平移（background-clip: text），底栏的时间是
 * ~250ms 一跳，块内滑动交给 CSS transition 补齐，不额外加逐帧重渲染。
 *
 * 之前试过"整行匀速插值"并回退过：LRC 只有行级时间戳，行内停顿被算进填充时长，
 * 进度明显落后于演唱。逐字时间戳到位后，每个块只在自己的区间里推进，才不存在这个问题。
 */
export function KaraokeLine({ line, currentTime }: { line?: LrcLine; currentTime: number }) {
  const words = line?.words
  if (!words?.length) return <>{line?.text ?? ''}</>

  const active = findActiveWordIndex(line, currentTime)
  return (
    <>
      {words.map((word, index) => {
        // 块的终点 = 下一块的起点；末块用行结束时间兜底（行尾标签缺失时按 0.3s 估）
        const endTime = words[index + 1]?.time ?? line!.endTime ?? word.time + 0.3
        const span = Math.max(0.05, endTime - word.time)
        const progress = index < active
          ? 1
          : index > active
            ? 0
            : Math.min(1, Math.max(0, (currentTime - word.time) / span))
        return (
          <span
            key={index}
            className="karaoke-word"
            style={{ backgroundPosition: `${(1 - progress) * 100}% 0` }}
          >
            {word.text}
          </span>
        )
      })}
    </>
  )
}
