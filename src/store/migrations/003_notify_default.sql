-- 早期版本把路由器恒为 0 的 push 字段当作提醒默认值，统一恢复为开启
UPDATE devices SET notify = 1;
