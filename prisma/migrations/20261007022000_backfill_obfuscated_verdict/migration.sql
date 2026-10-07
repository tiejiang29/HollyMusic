-- 新增一档 verdict='obfuscated'：静态特征读不懂、但带 @name 且正文 20KB~1MB 的候选。
-- 结构不用动（verdict 本来就是自由文本），这里只把历史行归到新档 ——
-- 否则存量 23 条还挂在「不像音源」里，面板上那一档是空的，而采集只会给新行分档。
-- 窗口那两个数是 lib/services/source-discovery.ts 里 FORCE_PROBE_MIN/MAX_BYTES 的同一把尺子，
-- 一次性回填所以照抄；将来改窗口不影响已归档的行（下一次采集会按新尺子重新分档）。
UPDATE "SourceCandidate"
SET "verdict" = 'obfuscated',
    "reason" = COALESCE("reason", '') || '；带 @name、正文 ' || CAST("sizeBytes" / 1024 AS INTEGER) || 'KB —— 静态特征读不懂，按混淆载荷收着'
WHERE "verdict" = 'not-source'
  AND "scriptName" <> ''
  AND "sizeBytes" BETWEEN 20480 AND 1048576;
