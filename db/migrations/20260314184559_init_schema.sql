-- migrate:up

CREATE TABLE `activation` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `token` text CHARACTER SET latin1 NOT NULL,
  `email` varchar(255) CHARACTER SET latin1 NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `archives` (
  `id` int(10) NOT NULL AUTO_INCREMENT,
  `shopid` int(11) NOT NULL,
  `ordernumber` varchar(255) CHARACTER SET latin1 NOT NULL,
  `customer` varchar(255) CHARACTER SET latin1 NOT NULL,
  `phone` varchar(256) CHARACTER SET latin1 DEFAULT NULL,
  `customerID` int(11) NOT NULL,
  `operator` int(11) DEFAULT NULL COMMENT 'cashier',
  `subtotal` int(11) NOT NULL,
  `payment` varchar(255) CHARACTER SET latin1 NOT NULL DEFAULT 'Cash',
  `used_payment_method` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` int(2) NOT NULL DEFAULT '1' COMMENT '1=pending 2=approve',
  `created` datetime NOT NULL,
  `finished` datetime NOT NULL,
  `remark` varchar(256) CHARACTER SET latin1 DEFAULT NULL,
  `token` varchar(255) CHARACTER SET latin1 NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `archivesdetail` (
  `id` int(10) NOT NULL AUTO_INCREMENT,
  `orderid` int(11) NOT NULL,
  `productid` int(11) NOT NULL,
  `price` int(11) NOT NULL,
  `qty` int(11) NOT NULL,
  `total` int(11) NOT NULL,
  `remark` text CHARACTER SET latin1,
  PRIMARY KEY (`id`),
  KEY `id` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `category` (
  `id` int(10) NOT NULL AUTO_INCREMENT,
  `shopid` int(11) NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'category',
  `created` datetime NOT NULL,
  `updated` datetime DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `orderdetail` (
  `id` int(10) NOT NULL AUTO_INCREMENT,
  `orderid` int(11) NOT NULL,
  `productid` int(11) NOT NULL,
  `price` int(11) NOT NULL,
  `qty` int(11) NOT NULL,
  `total` int(11) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `orders` (
  `id` int(10) NOT NULL AUTO_INCREMENT,
  `shopid` int(11) NOT NULL,
  `ordernumber` varchar(255) CHARACTER SET latin1 NOT NULL,
  `customer` varchar(255) CHARACTER SET latin1 NOT NULL,
  `phone` varchar(256) CHARACTER SET latin1 DEFAULT NULL,
  `customerID` int(11) NOT NULL,
  `operator` int(11) DEFAULT NULL COMMENT 'cashier',
  `subtotal` int(11) NOT NULL,
  `payment` varchar(255) CHARACTER SET latin1 NOT NULL DEFAULT 'Cash',
  `status` int(2) NOT NULL DEFAULT '1' COMMENT '1=pending 2=approve',
  `created` datetime NOT NULL,
  `finished` datetime NOT NULL,
  `remark` varchar(256) CHARACTER SET latin1 DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `orders_customization` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `order_id` int(11) NOT NULL,
  `order_details_id` int(11) NOT NULL,
  `product_id` int(11) NOT NULL,
  `product_choice_id` int(11) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `products` (
  `id` int(10) NOT NULL AUTO_INCREMENT,
  `shopid` int(11) NOT NULL,
  `name` varchar(255) CHARACTER SET latin1 NOT NULL,
  `description` varchar(512) CHARACTER SET latin1 DEFAULT NULL,
  `categoryid` int(10) NOT NULL COMMENT 'Id Cateogry',
  `price` int(10) NOT NULL,
  `stock` int(10) NOT NULL,
  `image` varchar(255) CHARACTER SET latin1 NOT NULL,
  `created` datetime NOT NULL,
  `updated` datetime DEFAULT NULL,
  `archived` tinyint(4) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `product_choice` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `product_customization_id` int(11) NOT NULL,
  `name` varchar(255) CHARACTER SET latin1 NOT NULL,
  `price` int(11) DEFAULT '0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `product_customization` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `product_id` int(11) NOT NULL,
  `name` varchar(255) CHARACTER SET latin1 DEFAULT NULL,
  `limit_choice` int(11) DEFAULT NULL,
  `description` varchar(255) CHARACTER SET latin1 DEFAULT NULL,
  `mandatory` int(11) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `id` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `shop` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `shop_name` varchar(255) CHARACTER SET latin1 NOT NULL,
  `shop_mail` varchar(255) CHARACTER SET latin1 NOT NULL,
  `shop_phone` varchar(255) CHARACTER SET latin1 NOT NULL,
  `shop_description` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `shop_payment_methods` text CHARACTER SET latin1 NOT NULL,
  `shop_adress` varchar(255) CHARACTER SET latin1 NOT NULL,
  `shop_siret` varchar(255) CHARACTER SET latin1 DEFAULT NULL,
  `admin_user` int(11) NOT NULL,
  `admin_phone` varchar(255) CHARACTER SET latin1 NOT NULL,
  `admin_mail` varchar(255) CHARACTER SET latin1 NOT NULL,
  `admin_password` varchar(255) CHARACTER SET latin1 NOT NULL,
  `hours` longtext CHARACTER SET latin1,
  `shop_social_media` longtext CHARACTER SET latin1,
  `shop_profile_image` varchar(255) CHARACTER SET latin1 NOT NULL,
  `shop_status` varchar(255) CHARACTER SET latin1 DEFAULT NULL,
  `kitchen_closed` tinyint(1) NOT NULL DEFAULT '0',
  `shop_printer_ip` varchar(255) CHARACTER SET latin1 NOT NULL,
  `smart_print_app` tinyint(1) DEFAULT NULL,
  UNIQUE KEY `shop_name` (`shop_name`),
  KEY `id` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `stocks` (
  `id` int(10) NOT NULL AUTO_INCREMENT,
  `productid` int(10) NOT NULL,
  `category` enum('0','1','2') CHARACTER SET latin1 NOT NULL COMMENT '0=add, 1=reduce & 2=adjusment',
  `qty` int(10) NOT NULL,
  `operator` int(10) NOT NULL COMMENT 'user id',
  `remark` text CHARACTER SET latin1,
  `created` datetime NOT NULL,
  `updated` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `users` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `shopid` int(11) NOT NULL,
  `username` varchar(255) CHARACTER SET latin1 NOT NULL,
  `email` varchar(255) CHARACTER SET latin1 NOT NULL,
  `password` varchar(255) CHARACTER SET latin1 NOT NULL,
  `token` text CHARACTER SET latin1,
  `expired` datetime DEFAULT NULL,
  `phone` varchar(255) CHARACTER SET latin1 NOT NULL,
  `gender` int(2) DEFAULT NULL COMMENT '1: Male 2: Female',
  `position` varchar(255) CHARACTER SET latin1 DEFAULT NULL,
  `image` varchar(255) CHARACTER SET latin1 NOT NULL DEFAULT 'defaultuser.png',
  `status` int(2) NOT NULL DEFAULT '0' COMMENT '0: Not activated 1: Actived',
  `access` int(2) DEFAULT NULL COMMENT '0: Admin 1: Cashier 2: User 3:Click-And-Collect',
  `created` datetime NOT NULL,
  `updated` datetime DEFAULT NULL,
  `clearpass` varchar(256) CHARACTER SET latin1 NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:down

DROP TABLE IF EXISTS `users`;
DROP TABLE IF EXISTS `stocks`;
DROP TABLE IF EXISTS `shop`;
DROP TABLE IF EXISTS `product_customization`;
DROP TABLE IF EXISTS `product_choice`;
DROP TABLE IF EXISTS `products`;
DROP TABLE IF EXISTS `orders_customization`;
DROP TABLE IF EXISTS `orders`;
DROP TABLE IF EXISTS `orderdetail`;
DROP TABLE IF EXISTS `category`;
DROP TABLE IF EXISTS `archivesdetail`;
DROP TABLE IF EXISTS `archives`;
DROP TABLE IF EXISTS `activation`;
