-- 修复旧版 warm start 产生的重叠会话：旧会话被标记 recover 闭合，
-- 但同一设备的下一段会话开始时间早于旧会话结束时间（设备其实一直在线）。
-- 做法：把新会话的开始时间提前到旧会话的开始时间，然后删掉旧会话。
UPDATE sessions SET started_at = (
  SELECT o.started_at FROM sessions o
  WHERE o.mac = sessions.mac AND o.end_source = 'recover' AND o.id < sessions.id
    AND o.ended_at >= sessions.started_at AND o.started_at < sessions.started_at
  ORDER BY o.started_at LIMIT 1
)
WHERE EXISTS (
  SELECT 1 FROM sessions o
  WHERE o.mac = sessions.mac AND o.end_source = 'recover' AND o.id < sessions.id
    AND o.ended_at >= sessions.started_at AND o.started_at < sessions.started_at
);
DELETE FROM sessions WHERE end_source = 'recover' AND EXISTS (
  SELECT 1 FROM sessions n WHERE n.mac = sessions.mac AND n.id > sessions.id AND n.started_at = sessions.started_at
);
UPDATE sessions SET duration_ms = ended_at - started_at WHERE ended_at IS NOT NULL;
