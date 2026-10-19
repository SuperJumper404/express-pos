-- migrate:up
ALTER TABLE shop_delivery_settings
  ADD COLUMN origin_google_place_id varchar(1024) COLLATE utf8mb4_bin DEFAULT NULL,
  DROP CHECK chk_delivery_settings_activation,
  ADD CONSTRAINT chk_delivery_settings_google_origin CHECK (
    origin_google_place_id IS NULL OR (CHAR_LENGTH(TRIM(origin_google_place_id)) > 0 AND origin_latitude IS NULL AND origin_longitude IS NULL)),
  ADD CONSTRAINT chk_delivery_settings_activation CHECK (
    enabled = 0 OR ((origin_latitude IS NOT NULL AND origin_longitude IS NOT NULL OR origin_google_place_id IS NOT NULL)
      AND max_distance_meters > 0 AND vat_rate IS NOT NULL));

ALTER TABLE deliveries
  ADD COLUMN google_place_id varchar(1024) COLLATE utf8mb4_bin DEFAULT NULL,
  MODIFY latitude decimal(10,7) DEFAULT NULL,
  MODIFY longitude decimal(10,7) DEFAULT NULL,
  DROP CHECK chk_deliveries_coordinates,
  ADD CONSTRAINT chk_deliveries_coordinates CHECK (
    (google_place_id IS NULL AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(address_snapshot,'$.provider')), '') <> 'google_places'
      AND latitude IS NOT NULL AND longitude IS NOT NULL AND latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)
    OR (google_place_id IS NOT NULL AND CHAR_LENGTH(TRIM(google_place_id)) > 0 AND latitude IS NULL AND longitude IS NULL
      AND JSON_CONTAINS_PATH(address_snapshot,'all','$.provider','$.placeId') = 1
      AND JSON_TYPE(JSON_EXTRACT(address_snapshot,'$.provider')) = 'STRING'
      AND JSON_TYPE(JSON_EXTRACT(address_snapshot,'$.placeId')) = 'STRING'
      AND BINARY JSON_UNQUOTE(JSON_EXTRACT(address_snapshot,'$.provider')) = BINARY 'google_places'
      AND BINARY JSON_UNQUOTE(JSON_EXTRACT(address_snapshot,'$.placeId')) = BINARY google_place_id
      AND JSON_CONTAINS_PATH(address_snapshot,'one','$.latitude','$.longitude') = 0));

-- migrate:down
DROP PROCEDURE IF EXISTS delivery_assert_no_google_references;
CREATE PROCEDURE delivery_assert_no_google_references()
BEGIN
  IF EXISTS(SELECT 1 FROM deliveries WHERE google_place_id IS NOT NULL)
    OR EXISTS(SELECT 1 FROM shop_delivery_settings WHERE origin_google_place_id IS NOT NULL)
    OR EXISTS(SELECT 1 FROM customer_addresses WHERE JSON_UNQUOTE(JSON_EXTRACT(address_snapshot,'$.provider')) = 'google_places') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Google references require a compatible application; rollback refused';
  END IF;
END;
CALL delivery_assert_no_google_references();
DROP PROCEDURE delivery_assert_no_google_references;
ALTER TABLE deliveries DROP CHECK chk_deliveries_coordinates,
  MODIFY latitude decimal(10,7) NOT NULL, MODIFY longitude decimal(10,7) NOT NULL,
  DROP COLUMN google_place_id,
  ADD CONSTRAINT chk_deliveries_coordinates CHECK (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180);
ALTER TABLE shop_delivery_settings DROP CHECK chk_delivery_settings_activation,
  DROP CHECK chk_delivery_settings_google_origin, DROP COLUMN origin_google_place_id,
  ADD CONSTRAINT chk_delivery_settings_activation CHECK (
    enabled = 0 OR (origin_latitude IS NOT NULL AND origin_longitude IS NOT NULL AND max_distance_meters > 0 AND vat_rate IS NOT NULL));
