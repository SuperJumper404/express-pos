-- migrate:up
ALTER TABLE `shop`
  ADD COLUMN `shop_theme` TEXT NULL AFTER `shop_profile_image`;

UPDATE `shop`
SET `shop_theme` = '{"preset":"default","colors":{"primary":"#1976d2","primaryHover":"#155fa8","primarySoft":"#e8f2ff","background":"#f3f5f8","surface":"#ffffff","surfaceMuted":"#f8fafc","border":"#dfe5ee","borderSoft":"#e8edf3","text":"#121826","textBody":"#1f2933","textMuted":"#687386","success":"#00e676","warning":"#ffa014","danger":"#d83b3b"}}'
WHERE `shop_theme` IS NULL OR `shop_theme` = '';

-- migrate:down
ALTER TABLE `shop`
  DROP COLUMN `shop_theme`;
