-- 合并来源：'auto' 为按主机名自动合并，'manual' 为用户在抽屉里改过（此后不再自动处理该设备）
ALTER TABLE devices ADD COLUMN merge_source TEXT;
-- 此前的合并都是手动做的
UPDATE devices SET merge_source = 'manual' WHERE canonical_mac IS NOT NULL;
